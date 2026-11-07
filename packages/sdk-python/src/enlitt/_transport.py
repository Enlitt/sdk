"""The one HTTP path to Enlitt (``core/transport.ts``).

Everything that talks to Enlitt goes through :func:`request_enlitt`: the exact header set, the
HTTPS rule, the no-redirect rule, bounded reads, error mapping, and the rate-limit wait.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
import uuid
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import _contract
from ._secrets import resolve_business_authorization_header
from ._version import SDK_VERSION
from .errors import (
    EnlittConfigurationError,
    EnlittError,
    EnlittLoginRequiredError,
    EnlittRateLimitError,
    enlitt_error_from_response,
    normalize_enlitt_model_error,
)
from .session import EnlittSession, get_enlitt_session

DEFAULT_BASE_URL = "https://api.enlitt.com"
"""The deployed Enlitt API origin compiled into the package."""

DEFAULT_RATE_LIMIT_FLOOR_MS = 1_000
"""Wait floor when a ``rate_limit_exceeded`` refusal advertises no ``Retry-After``."""

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_MAX_TOTAL_WAIT_MS = 30_000

MAX_ERROR_BODY_BYTES = 64 * 1024
"""Error bodies are read up to this size; anything longer is cut off."""

MAX_SUCCESS_BODY_BYTES = 16 * 1024 * 1024
"""A non-streaming success body larger than this is refused as malformed."""

MAX_HEADER_BYTES = 16 * 1024
"""Total size of response headers accepted from Enlitt."""

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_VISIBLE_ASCII = re.compile(r"^[\x21-\x7e]+$")


# ---------------------------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True, kw_only=True)
class EnlittRateLimitRetryOptions:
    """Tunes the transport's ``rate_limit_exceeded`` wait and nothing else.

    Attributes:
        max_attempts: Total requests per call including the first (default 3, minimum 1). One
            disables waiting: the ``EnlittRateLimitError`` is raised at once.
        max_total_wait_ms: Wall-clock budget for all waits, measured from the first refusal
            (default 30000).
        on_rate_limit: Called with the refused attempt number and the delay about to be slept.
    """

    max_attempts: int | None = None
    max_total_wait_ms: int | None = None
    on_rate_limit: Callable[[int, float], None] | None = None


@dataclass(frozen=True, kw_only=True)
class EnlittOptions:
    """Construction options shared by every SDK entry point.

    Attributes:
        secret_key: The business secret; else the ``ENLITT_SECRET_KEY`` environment variable.
        base_url: The Enlitt origin; else ``ENLITT_BASE_URL``; else the deployed origin.
        session: An explicit session. Without one the ambient session context is used.
        rate_limit: Tuning for the rate-limit wait.
        on_terminal_report_error: Observes a premium terminal report that could not be delivered.
    """

    secret_key: str | None = None
    base_url: str | None = None
    session: EnlittSession | None = None
    rate_limit: EnlittRateLimitRetryOptions | None = None
    on_terminal_report_error: Callable[[EnlittError], None] | None = None


@dataclass(frozen=True)
class ResolvedRateLimit:
    """The rate-limit options folded over the SDK defaults once, at construction."""

    max_attempts: int
    max_total_wait_ms: int
    on_rate_limit: Callable[[int, float], None] | None


@dataclass(frozen=True)
class InternalEnlittClient:
    """A configured client. Holding one is what makes a call managed (there is no null client)."""

    base_url: str
    business_authorization: str
    sdk_version: str
    resolve_session: Callable[[], EnlittSession]
    rate_limit: ResolvedRateLimit
    on_terminal_report_error: Callable[[EnlittError], None] | None

    def __repr__(self) -> str:
        # The authorization header holds the business secret; never print it.
        return f"InternalEnlittClient(base_url={self.base_url!r})"


def get_enlitt_session_or_login() -> EnlittSession:
    """Resolve the ambient session: no context raises configuration, null raises login-required."""
    session = get_enlitt_session()  # raises EnlittConfigurationError with no context at all
    if session is None:
        raise EnlittLoginRequiredError(
            "No signed-in Enlitt user: the request context holds no session.",
            code="personal_login_required",
        )
    return session


# ---------------------------------------------------------------------------------------------
# Test seam
# ---------------------------------------------------------------------------------------------


@dataclass
class Runtime:
    """Clock, random source, and sleep. Tests replace these; production never does."""

    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    uniform: Callable[[float, float], float] = random.uniform
    monotonic: Callable[[], float] = time.monotonic


runtime = Runtime()
"""The module-level seam read by the rate-limit wait and the terminal-report retry."""


# ---------------------------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------------------------


def resolve_base_url(base_url: str | None) -> str:
    """Pick and validate the base URL: HTTPS, or HTTP only for a loopback host."""
    raw = base_url or os.environ.get("ENLITT_BASE_URL") or DEFAULT_BASE_URL
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        parts.port  # noqa: B018 - touching .port validates it
    except ValueError:
        raise EnlittConfigurationError("The Enlitt base URL is not a valid URL.") from None
    if (
        not host
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
    ):
        raise EnlittConfigurationError(
            "The Enlitt base URL must be an absolute URL without credentials, query, or fragment."
        )
    if parts.scheme == "https" or (parts.scheme == "http" and host in _LOOPBACK_HOSTS):
        pass
    else:
        raise EnlittConfigurationError(
            "The Enlitt base URL must use https (http is allowed only for localhost, "
            "127.0.0.1, or [::1])."
        )
    return raw.rstrip("/")


def _resolve_rate_limit(options: EnlittRateLimitRetryOptions | None) -> ResolvedRateLimit:
    options = options or EnlittRateLimitRetryOptions()
    attempts = DEFAULT_MAX_ATTEMPTS if options.max_attempts is None else options.max_attempts
    total = (
        DEFAULT_MAX_TOTAL_WAIT_MS
        if options.max_total_wait_ms is None
        else options.max_total_wait_ms
    )
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
        raise EnlittConfigurationError("rate_limit.max_attempts must be an integer of at least 1.")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise EnlittConfigurationError(
            "rate_limit.max_total_wait_ms must be a nonnegative integer."
        )
    return ResolvedRateLimit(attempts, total, options.on_rate_limit)


def create_internal_client(options: EnlittOptions | None = None) -> InternalEnlittClient:
    """Build one client from the options and the environment (``createInternalClient``)."""
    options = options or EnlittOptions()
    authorization = resolve_business_authorization_header(options.secret_key)
    base_url = resolve_base_url(options.base_url)
    rate_limit = _resolve_rate_limit(options.rate_limit)
    explicit = options.session

    def resolve_session() -> EnlittSession:
        return explicit if explicit is not None else get_enlitt_session_or_login()

    return InternalEnlittClient(
        base_url=base_url,
        business_authorization=authorization,
        sdk_version=f"enlitt-python/{SDK_VERSION}",
        resolve_session=resolve_session,
        rate_limit=rate_limit,
        on_terminal_report_error=options.on_terminal_report_error,
    )


def validate_idempotency_key(value: object, *, what: str = "idempotency key") -> str:
    """Check a call ID against the protocol's ``Idempotency-Key`` bounds."""
    low, high = _contract.IDEMPOTENCY_KEY_MIN_LENGTH, _contract.IDEMPOTENCY_KEY_MAX_LENGTH
    if (
        not isinstance(value, str)
        or not low <= len(value) <= high
        or not _VISIBLE_ASCII.match(value)
    ):
        raise EnlittConfigurationError(
            f"The {what} must be {low} to {high} visible ASCII characters."
        )
    return value


def generate_call_id() -> str:
    """A fresh random call ID of 32 visible ASCII characters."""
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------

_clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient] = (
    weakref.WeakKeyDictionary()
)


def _http_client() -> httpx.AsyncClient:
    """The shared client for the running event loop, created lazily."""
    loop = asyncio.get_running_loop()
    client = _clients.get(loop)
    if client is None:
        client = httpx.AsyncClient(follow_redirects=False, timeout=None, trust_env=False)
        _clients[loop] = client
    return client


def _lower_headers(response: httpx.Response) -> dict[str, str]:
    return {k.lower(): v for k, v in response.headers.items()}


async def _read_bounded(response: httpx.Response, limit: int) -> tuple[bytes, bool]:
    """Read up to ``limit`` bytes; the flag says whether the body was longer."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            chunks.append(chunk[: len(chunk) - (size - limit)])
            return b"".join(chunks), True
        chunks.append(chunk)
    return b"".join(chunks), False


def _decode_error_body(raw: bytes) -> object:
    try:
        return json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", errors="replace")


def _http_error(headers: dict[str, str], raw: bytes, status: int) -> EnlittError:
    return enlitt_error_from_response(status, headers, _decode_error_body(raw))


async def _send_once(
    client: InternalEnlittClient,
    *,
    method: str,
    path: str,
    body: object,
    call_id: str | None,
    accept: str,
) -> httpx.Response:
    """One request. Returns the open success response; raises an ``EnlittError`` otherwise."""
    session = client.resolve_session()
    headers = {
        "Authorization": client.business_authorization,
        "X-Enlitt-User-Authorization": f"Bearer {session.token}",
        "Accept": accept,
        "X-Request-Id": f"req_{uuid.uuid4().hex}",
        _contract.VERSION_HEADER: _contract.API_VERSION,
        "X-Enlitt-SDK-Version": client.sdk_version,
    }
    content: bytes | None = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        if call_id is not None:
            headers["Idempotency-Key"] = call_id
        content = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = httpx.Request(method, client.base_url + path, headers=headers, content=content)
    try:
        response = await _http_client().send(request, stream=True)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise normalize_enlitt_model_error(exc) from None
    try:
        status = response.status_code
        if 300 <= status < 400:
            raise EnlittError(
                "Enlitt answered with a redirect, which the SDK never follows.",
                code="transport_failed",
            )
        if sum(len(k) + len(v) for k, v in response.headers.items()) > MAX_HEADER_BYTES:
            raise EnlittError(
                "Enlitt sent response headers larger than the SDK accepts.",
                code="malformed_response",
            )
        if status >= 400 or status < 200:
            raw, _ = await _read_bounded(response, MAX_ERROR_BODY_BYTES)
            raise _http_error(_lower_headers(response), raw, status)
        return response
    except BaseException:
        await response.aclose()
        raise


async def request_enlitt(
    client: InternalEnlittClient,
    *,
    path: str,
    body: object = None,
    call_id: str | None = None,
    accept: str = "application/json",
    method: str = "POST",
) -> httpx.Response:
    """Send one request to Enlitt and return the open success response.

    The caller owns the response and must read or close it. A non-success answer raises the
    mapped :class:`EnlittError`. ``rate_limit_exceeded`` is waited out and retried (jittered
    above the advertised floor, bounded by attempts and total wall-clock time, cancellable,
    observable) before its error escapes unchanged.
    """
    limit = client.rate_limit
    first_refusal: float | None = None
    attempt = 0
    while True:
        attempt += 1
        try:
            return await _send_once(
                client, method=method, path=path, body=body, call_id=call_id, accept=accept
            )
        except EnlittRateLimitError as refusal:
            now = runtime.monotonic()
            if first_refusal is None:
                first_refusal = now
            if attempt >= limit.max_attempts:
                raise
            floor = float(
                refusal.retry_after_ms
                if refusal.retry_after_ms is not None
                else DEFAULT_RATE_LIMIT_FLOOR_MS
            )
            delay_ms = floor + runtime.uniform(0.0, floor / 2)
            waited_ms = (now - first_refusal) * 1000
            if waited_ms + delay_ms > limit.max_total_wait_ms:
                raise
            if limit.on_rate_limit is not None:
                limit.on_rate_limit(attempt, delay_ms)
            # asyncio.sleep is cancellable: task cancellation ends the wait with CancelledError.
            await runtime.sleep(delay_ms / 1000)


async def read_json_body(response: httpx.Response) -> object:
    """Read and close a success response, returning its parsed JSON body."""
    try:
        raw, truncated = await _read_bounded(response, MAX_SUCCESS_BODY_BYTES)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        raise normalize_enlitt_model_error(exc) from None
    finally:
        await response.aclose()
    if truncated:
        raise EnlittError(
            "Enlitt sent a body larger than the SDK accepts.", code="malformed_response"
        )
    try:
        return json.loads(raw)
    except ValueError:
        raise EnlittError(
            "Enlitt sent a body that is not JSON.", code="malformed_response"
        ) from None


def response_headers(response: httpx.Response) -> dict[str, Any]:
    """Lowercase response headers as a plain dict."""
    return dict(_lower_headers(response))


def shared_http_client() -> httpx.AsyncClient:
    """The per-event-loop client, for the account handlers' code exchange and revocation."""
    return _http_client()
