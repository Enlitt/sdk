"""Account's SDK handlers (``callback.ts``): login start, callback, and logout.

The handlers are framework-neutral: each is
``Callable[[HandlerRequest], Awaitable[HandlerResponse]]``.
Every response any of them produces is a ``303`` redirect with ``Cache-Control: no-store``.
"""

from __future__ import annotations

import asyncio
import inspect
import secrets
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol, TypeVar
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit

from . import _contract, _parse, _transport
from ._cookies import clearing_cookie, parse_cookie_header, session_cookie
from ._secrets import resolve_business_authorization_header
from .errors import (
    EnlittConfigurationError,
    EnlittError,
    enlitt_error_from_response,
    normalize_enlitt_model_error,
)
from .session import ENLITT_SESSION_COOKIE_NAME

T = TypeVar("T")

DEFAULT_ENLITT_ORIGIN = "https://enlitt.com"
"""The deployed Enlitt dashboard origin, where the browser is sent to authorize."""

STATE_TTL_MS = 10 * 60 * 1000
"""How long a login ``state`` stays usable."""

MAX_RETURN_TO_LENGTH = 2048
_STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_STATE_LENGTH = 43
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


# ---------------------------------------------------------------------------------------------
# Framework-neutral request and response
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HandlerRequest:
    """One incoming HTTP request. ``headers`` have lowercase names; ``url`` is absolute."""

    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes = b""


@dataclass
class HandlerResponse:
    """One outgoing HTTP response. ``headers`` is repeatable (several ``set-cookie`` lines).

    It is mutable on purpose: an ``on_sign_in`` hook appends its own cookie to it.
    """

    status: int
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""


Handler = Callable[[HandlerRequest], Awaitable[HandlerResponse]]
"""A framework-neutral handler."""


# ---------------------------------------------------------------------------------------------
# State store
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StateRecord:
    """Server-side record of one login start. Timestamps are milliseconds since the epoch."""

    created_at: int
    expires_at: int
    return_to: str | None = None


class StateStore(Protocol):
    """The application-provided, server-side login-state store.

    Methods may return values directly or as awaitables. ``consume`` must atomically read and
    remove a record, and the store honors the TTL. Multi-process deployments share the store.
    """

    def set(self, state: str, record: StateRecord, ttl_ms: int) -> Awaitable[None] | None: ...

    def get(self, state: str) -> StateRecord | Awaitable[StateRecord | None] | None: ...

    def consume(self, state: str) -> StateRecord | Awaitable[StateRecord | None] | None: ...


class MemoryStateStore:
    """In-process :class:`StateStore` for development and tests. Not shared across processes."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._records: dict[str, tuple[StateRecord, float]] = {}

    def set(self, state: str, record: StateRecord, ttl_ms: int) -> None:
        """Store ``record`` for ``ttl_ms``."""
        self._records[state] = (record, self._clock() + ttl_ms / 1000)

    def get(self, state: str) -> StateRecord | None:
        """Read a live record without removing it."""
        entry = self._records.get(state)
        if entry is None or entry[1] <= self._clock():
            self._records.pop(state, None)
            return None
        return entry[0]

    def consume(self, state: str) -> StateRecord | None:
        """Atomically read and remove a live record."""
        record = self.get(state)
        self._records.pop(state, None)
        return record


async def _maybe_await(value: T | Awaitable[T]) -> T:
    if inspect.isawaitable(value):
        return await value
    return value


# ---------------------------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SignInIdentity:
    """The only thing ``on_sign_in`` learns: the verified, application-scoped subject."""

    subject: str


OnSignIn = Callable[[SignInIdentity, HandlerResponse], Awaitable[None] | None]


@dataclass(frozen=True, kw_only=True)
class CallbackConfig:
    """Configuration shared by the login-start, callback, and logout handlers.

    Attributes:
        client_id: The application's public OAuth client ID.
        redirect_uri: Must equal a registered redirect URI exactly (the callback URL).
        app_origin: The business's own origin; it bounds every redirect.
        default_return_to: A path on ``app_origin`` used when no valid target is supplied.
        state_store: Server-side login-state store (no default; use a shared one in production).
        secret_key: The business secret; else ``ENLITT_SECRET_KEY``.
        enlitt_origin: Where the browser is sent to authorize (the dashboard host).
        enlitt_api_origin: Where the code exchange and revocation go; defaults to ``enlitt_origin``.
        cookie_name: Defaults to ``ENLITT_SESSION_COOKIE_NAME``; pass the same value to the
            session middleware.
        on_sign_in: Runs once after a verified exchange, before the Enlitt cookie is appended.
    """

    client_id: str
    redirect_uri: str
    app_origin: str
    default_return_to: str
    state_store: StateStore
    secret_key: str | None = None
    enlitt_origin: str = DEFAULT_ENLITT_ORIGIN
    enlitt_api_origin: str | None = None
    cookie_name: str = ENLITT_SESSION_COOKIE_NAME
    on_sign_in: OnSignIn | None = None


def _origin_of(raw: str, what: str) -> str:
    """Normalize ``raw`` to ``scheme://host[:port]`` or raise a configuration error."""
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        port = parts.port
    except ValueError:
        raise EnlittConfigurationError(f"{what} is not a valid URL.") from None
    if (
        not host
        or parts.username is not None
        or parts.password is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise EnlittConfigurationError(f"{what} must be an origin such as https://example.com.")
    if parts.scheme != "https" and not (parts.scheme == "http" and host in _LOOPBACK_HOSTS):
        raise EnlittConfigurationError(f"{what} must use https (http only for a loopback host).")
    shown = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{shown}" + (f":{port}" if port is not None else "")


@dataclass(frozen=True)
class _Resolved:
    """A :class:`CallbackConfig` with every default applied and every check done."""

    config: CallbackConfig
    app_origin: str
    enlitt_origin: str
    api_origin: str
    default_return_to: str


def resolve_config(config: CallbackConfig) -> _Resolved:
    """Validate a config once, at handler construction."""
    if not config.client_id:
        raise EnlittConfigurationError("client_id is required.")
    app_origin = _origin_of(config.app_origin, "app_origin")
    enlitt_origin = _origin_of(config.enlitt_origin, "enlitt_origin")
    api_origin = _origin_of(config.enlitt_api_origin or config.enlitt_origin, "enlitt_api_origin")
    default = validate_return_to(config.default_return_to, app_origin)
    if default is None:
        raise EnlittConfigurationError("default_return_to must be a path on app_origin.")
    try:
        redirect = urlsplit(config.redirect_uri)
    except ValueError:
        redirect = None
    if redirect is None or not redirect.scheme or not redirect.hostname:
        raise EnlittConfigurationError("redirect_uri must be an absolute URL.")
    return _Resolved(config, app_origin, enlitt_origin, api_origin, default)


# ---------------------------------------------------------------------------------------------
# Redirect validation
# ---------------------------------------------------------------------------------------------


def validate_return_to(raw: str | None, app_origin: str) -> str | None:
    """Accept only a same-origin path (with optional query); anything else returns ``None``.

    Rejected: another origin, scheme-relative ``//host``, backslashes, control characters,
    fragments, and traversal segments in raw or percent-decoded form.
    """
    if not raw or len(raw) > MAX_RETURN_TO_LENGTH:
        return None
    if not raw.startswith("/") or raw.startswith("//") or "#" in raw:
        return None
    decoded = unquote(unquote(raw))
    for candidate in (raw, decoded):
        if "\\" in candidate or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in candidate):
            return None
        if candidate.startswith("//"):
            return None
        if ".." in candidate.split("?", 1)[0].split("/"):
            return None
    try:
        joined = urlsplit(urljoin(app_origin + "/", raw))
    except ValueError:
        return None
    if f"{joined.scheme}://{joined.netloc}" != urlsplit(app_origin).geturl().rstrip("/"):
        return None
    return raw


def _redirect(location: str, extra: list[tuple[str, str]] | None = None) -> HandlerResponse:
    headers = [("location", location), ("cache-control", "no-store")]
    return HandlerResponse(303, headers + (extra or []))


def query_params(url: str) -> dict[str, str]:
    """Query parameters with the first value winning."""
    out: dict[str, str] = {}
    for key, value in parse_qsl(urlsplit(url).query, keep_blank_values=True):
        out.setdefault(key, value)
    return out


def now_ms() -> int:
    return int(time.time() * 1000)


def new_state() -> str:
    """A 43-character state drawn uniformly from the base64url alphabet."""
    return "".join(secrets.choice(_STATE_ALPHABET) for _ in range(_STATE_LENGTH))


# ---------------------------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------------------------


def login_start_handler(config: CallbackConfig) -> Handler:
    """Create the login-start handler: store a fresh ``state``, redirect to Enlitt to authorize."""
    resolved = resolve_config(config)

    async def handle(request: HandlerRequest) -> HandlerResponse:
        return_to = validate_return_to(
            query_params(request.url).get("return_to"), resolved.app_origin
        )
        state = new_state()
        now = now_ms()
        await _maybe_await(
            config.state_store.set(
                state,
                StateRecord(created_at=now, expires_at=now + STATE_TTL_MS, return_to=return_to),
                STATE_TTL_MS,
            )
        )
        query = urlencode(
            {
                "response_type": "code",
                "client_id": config.client_id,
                "redirect_uri": config.redirect_uri,
                "state": state,
            },
            quote_via=quote,
        )
        return _redirect(f"{resolved.enlitt_origin}/auth/oauth2/authorize?{query}")

    return handle


async def _exchange_code(resolved: _Resolved, authorization: str, code: str) -> tuple[str, str]:
    """Exchange a one-time code for ``(session_token, subject)``; raises ``EnlittError``."""
    config = resolved.config
    try:
        response = await _transport.shared_http_client().post(
            f"{resolved.api_origin}/auth/oauth2/token",
            headers={
                "Authorization": authorization,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                _contract.VERSION_HEADER: _contract.API_VERSION,
            },
            content=urlencode(
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": config.redirect_uri,
                    "client_id": config.client_id,
                }
            ).encode("ascii"),
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise normalize_enlitt_model_error(exc) from None
    try:
        body: object = response.json()
    except ValueError:
        body = response.text[:2048]
    if response.status_code != 200:
        headers = {k.lower(): v for k, v in response.headers.items()}
        raise enlitt_error_from_response(response.status_code, headers, body)
    parsed = _parse.parse_body(_parse.parse_exchange_response, body, "code exchange response")
    return parsed["session_token"], parsed["subject"]


def callback_handler(config: CallbackConfig) -> Handler:
    """Create the OAuth callback handler: verify ``state``, exchange the code, set the cookie."""
    resolved = resolve_config(config)
    authorization = resolve_business_authorization_header(config.secret_key)

    async def handle(request: HandlerRequest) -> HandlerResponse:
        query = query_params(request.url)
        state = query.get("state")
        default_url = resolved.app_origin + resolved.default_return_to
        # No live record means nothing to trust: always the default page, never an exchange.
        record = await _maybe_await(config.state_store.consume(state)) if state else None
        if record is None or record.expires_at <= now_ms():
            return _redirect(default_url)
        target = validate_return_to(record.return_to, resolved.app_origin)
        signed_out = _redirect(resolved.app_origin + (target or resolved.default_return_to))

        code = query.get("code")
        if "error" in query or not code:
            return signed_out  # cancelled login or no code: signed out, no cookie
        try:
            token, subject = await _exchange_code(resolved, authorization, code)
        except EnlittError:
            return signed_out  # failed exchange: signed out, no cookie

        response = _redirect(signed_out.headers[0][1])
        if config.on_sign_in is not None:
            # Hook errors propagate unchanged: no SDK login response is returned on that path.
            await _maybe_await(config.on_sign_in(SignInIdentity(subject), response))
        response.headers.append(("set-cookie", session_cookie(config.cookie_name, token)))
        return response

    return handle


async def revoke_session(resolved: _Resolved, authorization: str, token: str) -> None:
    """Ask Enlitt to end one session. Every failure is swallowed (the outcome is the same)."""
    try:
        await _transport.shared_http_client().post(
            f"{resolved.api_origin}/auth/oauth2/revoke",
            headers={
                "Authorization": authorization,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                _contract.VERSION_HEADER: _contract.API_VERSION,
            },
            content=urlencode({"token": token, "client_id": resolved.config.client_id}).encode(
                "ascii"
            ),
        )
    except asyncio.CancelledError:
        raise
    except Exception:
        return


def logout_handler(config: CallbackConfig) -> Handler:
    """Create the logout handler: revoke the session, clear the cookie, redirect."""
    resolved = resolve_config(config)
    authorization = resolve_business_authorization_header(config.secret_key)

    async def handle(request: HandlerRequest) -> HandlerResponse:
        token = parse_cookie_header(request.headers.get("cookie")).get(config.cookie_name)
        if token:
            await revoke_session(resolved, authorization, token)
        target = validate_return_to(query_params(request.url).get("return_to"), resolved.app_origin)
        return _redirect(
            resolved.app_origin + (target or resolved.default_return_to),
            [("set-cookie", clearing_cookie(config.cookie_name))],
        )

    return handle
