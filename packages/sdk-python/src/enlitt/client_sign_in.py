"""Client sign-in handoff (Account "Client sign-in handoff"): a game or native client signs in.

The business's backend serves every path under ``base_path``. The wire is
``specs/PROTOCOLS.md`` "Client sign-in handoff"; Enlitt itself only sees the ordinary
authorization, exchange, and revocation requests.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import inspect
import json
import re
import secrets
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar
from urllib.parse import parse_qsl, urlencode, urlsplit

from . import auth
from ._cookies import clearing_cookie, parse_cookie_header
from .auth import CallbackConfig, Handler, HandlerRequest, HandlerResponse
from .errors import EnlittConfigurationError
from .session import ENLITT_SESSION_HEADER_NAME

T = TypeVar("T")

HANDOFF_TTL_MS = 10 * 60 * 1000
CODE_TTL_MS = 5 * 60 * 1000
PAIRING_TTL_MS = 10 * 60 * 1000
PAIRING_INTERVAL_SECONDS = 5
CSRF_COOKIE_NAME = "enlitt_pair_csrf"
USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"
USER_CODE_LENGTH = 8

_STATE = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")
_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PRIVATE_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*$")
_FORBIDDEN_SCHEMES = frozenset({"http", "javascript", "data", "file", "vbscript"})
_START_FIELDS = frozenset({"mode", "state", "code_challenge", "code_challenge_method"})


# ---------------------------------------------------------------------------------------------
# Store and config
# ---------------------------------------------------------------------------------------------


class ClientSignInStore(Protocol):
    """Opaque-string store shared across processes (the handler owns the value format).

    Methods may return values directly or as awaitables. ``consume`` is an atomic
    read-and-delete.
    """

    def set(self, key: str, value: str, ttl_ms: int) -> Awaitable[None] | None: ...

    def get(self, key: str) -> str | Awaitable[str | None] | None: ...

    def consume(self, key: str) -> str | Awaitable[str | None] | None: ...


class MemoryClientSignInStore:
    """In-process store for development. It does not work across processes."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._values: dict[str, tuple[str, float]] = {}

    def set(self, key: str, value: str, ttl_ms: int) -> None:
        """Store ``value`` (overwriting) for ``ttl_ms``."""
        self._values[key] = (value, self._clock() + ttl_ms / 1000)

    def get(self, key: str) -> str | None:
        """Read a live value."""
        entry = self._values.get(key)
        if entry is None or entry[1] <= self._clock():
            self._values.pop(key, None)
            return None
        return entry[0]

    def consume(self, key: str) -> str | None:
        """Atomically read and remove a live value."""
        value = self.get(key)
        self._values.pop(key, None)
        return value


@dataclass(frozen=True, kw_only=True)
class ClientSignInConfig:
    """Configuration for :func:`client_sign_in_handler`.

    Attributes:
        callback: The same config the three account handlers are mounted with.
        base_path: Path on ``callback.app_origin``, e.g. ``"/enlitt/client"``; no trailing slash.
        app_name: Shown on the pairing pages (1 to 60 characters).
        store: Shared store for handoffs, codes, and pairings.
        loopback: Allow the loopback mode (default true).
        return_urls: Exact deep-link targets for the redirect mode.
        pairing: Allow the pairing mode (default false).
    """

    callback: CallbackConfig
    base_path: str
    app_name: str
    store: ClientSignInStore
    loopback: bool = True
    return_urls: Sequence[str] = ()
    pairing: bool = False


def _check_return_url(url: str) -> None:
    try:
        parts = urlsplit(url)
    except ValueError:
        parts = None
    ok = parts is not None and bool(parts.scheme) and "#" not in url
    if ok and parts is not None:
        scheme = parts.scheme
        if scheme == "https":
            ok = bool(parts.hostname)
        else:
            ok = (
                scheme == scheme.lower()
                and "." in scheme
                and bool(_PRIVATE_SCHEME.match(scheme))
                and scheme not in _FORBIDDEN_SCHEMES
            )
    if not ok:
        raise EnlittConfigurationError(
            "Each return URL must be an absolute https: URL or a reverse-DNS private-use scheme "
            "URL (such as com.example.game://callback) without a fragment."
        )


def _check_config(config: ClientSignInConfig) -> None:
    base = config.base_path
    if not base.startswith("/") or base.endswith("/") or "?" in base or "#" in base:
        raise EnlittConfigurationError(
            "base_path must start with / and must not end with / or contain ? or #."
        )
    for url in config.return_urls:
        _check_return_url(url)
    if not (config.loopback or config.return_urls or config.pairing):
        raise EnlittConfigurationError("Enable at least one of loopback, return_urls, or pairing.")
    if not 1 <= len(config.app_name) <= 60:
        raise EnlittConfigurationError("app_name must be 1 to 60 characters.")


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


async def _maybe_await(value: T | Awaitable[T]) -> T:
    if inspect.isawaitable(value):
        return await value
    return value


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _random_id() -> str:
    """32 random bytes as 43 base64url characters."""
    return _b64url(secrets.token_bytes(32))


def _challenge_of(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def _matches(verifier: str, challenge: str) -> bool:
    return hmac.compare_digest(_challenge_of(verifier).encode(), challenge.encode())


def _load(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _dump(value: dict[str, Any]) -> str:
    return json.dumps(value, separators=(",", ":"))


def _format_user_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def _json_response(status: int, body: dict[str, Any]) -> HandlerResponse:
    return HandlerResponse(
        status,
        [("content-type", "application/json"), ("cache-control", "no-store")],
        json.dumps(body, separators=(",", ":")).encode(),
    )


def _token_error(error: str) -> HandlerResponse:
    return _json_response(400, {"error": error})


_PAGE_HEADERS = [
    ("content-type", "text/html; charset=utf-8"),
    ("cache-control", "no-store"),
    ("x-frame-options", "DENY"),
    (
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    ),
    ("referrer-policy", "no-referrer"),
]


def _page(
    status: int, title: str, body_html: str, extra: list[tuple[str, str]] | None = None
) -> HandlerResponse:
    """A small HTML page. ``body_html`` must already be escaped by the caller."""
    document = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title>"
        "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;"
        "padding:0 1rem;line-height:1.5}button,input{font-size:1rem;padding:.5rem 1rem}</style>"
        f"</head><body>{body_html}</body></html>"
    )
    return HandlerResponse(status, _PAGE_HEADERS + (extra or []), document.encode())


_EXPIRED_PAGE = "This sign-in link has expired. Go back to the app and try again."


def _expired_page() -> HandlerResponse:
    return _page(400, "Link expired", f"<p>{html.escape(_EXPIRED_PAGE)}</p>")


# ---------------------------------------------------------------------------------------------
# The handler
# ---------------------------------------------------------------------------------------------


def client_sign_in_handler(config: ClientSignInConfig) -> Handler:
    """Create the handler that serves every path under ``config.base_path``."""
    _check_config(config)
    resolved = auth.resolve_config(config.callback)
    base = config.base_path
    store = config.store
    login_start = auth.login_start_handler(config.callback)
    logout = auth.logout_handler(config.callback)
    cookie_name = config.callback.cookie_name
    app_origin = resolved.app_origin

    # -- storage helpers ---------------------------------------------------------------------

    async def put(key: str, value: dict[str, Any], ttl_ms: int) -> None:
        await _maybe_await(store.set(key, _dump(value), ttl_ms))

    async def take(key: str) -> dict[str, Any] | None:
        return _load(await _maybe_await(store.consume(key)))

    async def peek(key: str) -> dict[str, Any] | None:
        return _load(await _maybe_await(store.get(key)))

    async def start_login(handoff: dict[str, Any]) -> HandlerResponse:
        """Write the handoff, then enter the business's login start (clearing the cookie)."""
        handoff_id = _random_id()
        await put(f"h:{handoff_id}", handoff, HANDOFF_TTL_MS)
        return_to = f"{base}/complete?{urlencode({'h': handoff_id})}"
        # login_start_handler reads only return_to from the URL it is given.
        request = HandlerRequest(
            "GET", f"{app_origin}/?{urlencode({'return_to': return_to})}", {}, b""
        )
        response = await login_start(request)
        response.headers.append(("set-cookie", clearing_cookie(cookie_name)))
        return response

    # -- routes ------------------------------------------------------------------------------

    async def start(request: HandlerRequest) -> HandlerResponse:
        pairs = parse_qsl(urlsplit(request.url).query, keep_blank_values=True)
        query = dict(pairs)
        refusal = _refuse_start(config, pairs, query)
        if refusal is not None:
            return _page(400, "Sign-in unavailable", f"<p>{html.escape(refusal)}</p>")
        mode = query["mode"]
        target: dict[str, Any]
        if mode == "loopback":
            target = {"mode": "loopback", "port": int(query["port"])}
        else:
            target = {"mode": "redirect", "redirectUri": query["redirect_uri"]}
        return await start_login(
            {"target": target, "state": query["state"], "codeChallenge": query["code_challenge"]}
        )

    async def complete(request: HandlerRequest) -> HandlerResponse:
        handoff_id = auth.query_params(request.url).get("h", "")
        handoff = await take(f"h:{handoff_id}") if handoff_id else None
        if handoff is None:
            return _clear(_expired_page())
        token = parse_cookie_header(request.headers.get("cookie")).get(cookie_name)
        target = handoff.get("target")
        if not isinstance(target, dict):
            return _clear(_expired_page())
        if target.get("mode") == "pairing":
            return _clear(await complete_pairing(str(target.get("pairingId", "")), token))
        base_url = (
            f"http://127.0.0.1:{target.get('port')}/callback"
            if target.get("mode") == "loopback"
            else str(target.get("redirectUri", ""))
        )
        state = handoff.get("state")
        params: dict[str, str]
        if token:
            code = _random_id()
            await put(
                f"c:{code}",
                {"sessionToken": token, "codeChallenge": handoff.get("codeChallenge", "")},
                CODE_TTL_MS,
            )
            params = {"code": code}
        else:
            params = {"error": "access_denied"}
        if isinstance(state, str):
            params["state"] = state
        separator = "&" if "?" in base_url else "?"
        return _clear(
            HandlerResponse(
                303,
                [
                    ("location", f"{base_url}{separator}{urlencode(params)}"),
                    ("cache-control", "no-store"),
                ],
            )
        )

    def _clear(response: HandlerResponse) -> HandlerResponse:
        response.headers.append(("set-cookie", clearing_cookie(cookie_name)))
        return response

    async def complete_pairing(pairing_id: str, token: str | None) -> HandlerResponse:
        pairing = await peek(f"p:{pairing_id}") if pairing_id else None
        if pairing is None or pairing.get("status") != "pending":
            return _expired_page()
        if token:
            pairing["status"] = "ready"
            pairing["sessionToken"] = token
        else:
            pairing["status"] = "denied"
        await rewrite_pairing(pairing_id, pairing)
        if token:
            return _page(
                200, "Signed in", "<p>Signed in. You can go back to your other device.</p>"
            )
        return _page(200, "Sign-in cancelled", "<p>Sign-in cancelled. You can close this page.</p>")

    async def rewrite_pairing(pairing_id: str, pairing: dict[str, Any]) -> None:
        """Rewrite a pairing with the lifetime it has left."""
        left = int(pairing.get("expiresAt", 0)) - auth.now_ms()
        if left > 0:
            await put(f"p:{pairing_id}", pairing, left)

    async def pairing_create(request: HandlerRequest) -> HandlerResponse:
        if not config.pairing:
            return _not_found()
        body = _load(request.body.decode("utf-8", errors="replace"))
        if (
            "application/json" not in request.headers.get("content-type", "")
            or body is None
            or set(body) != {"code_challenge", "code_challenge_method"}
            or body["code_challenge_method"] != "S256"
            or not isinstance(body["code_challenge"], str)
            or not _CHALLENGE.match(body["code_challenge"])
        ):
            return _token_error("invalid_request")
        pairing_id = _random_id()
        while True:
            user_code = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH))
            if await peek(f"u:{user_code}") is None:
                break
        await put(
            f"p:{pairing_id}",
            {
                "status": "pending",
                "codeChallenge": body["code_challenge"],
                "userCode": user_code,
                "expiresAt": auth.now_ms() + PAIRING_TTL_MS,
            },
            PAIRING_TTL_MS,
        )
        await put(f"u:{user_code}", {"pairingId": pairing_id}, PAIRING_TTL_MS)
        return _json_response(
            200,
            {
                "pairing_id": pairing_id,
                "user_code": _format_user_code(user_code),
                "verification_uri": f"{app_origin}{base}/pair",
                "expires_in": PAIRING_TTL_MS // 1000,
                "interval": PAIRING_INTERVAL_SECONDS,
            },
        )

    def _entry_page(csrf: str, message: str | None = None) -> HandlerResponse:
        note = f"<p>{html.escape(message)}</p>" if message else ""
        form = (
            f"<h1>Sign in to {html.escape(config.app_name)}</h1>{note}"
            f'<form method="post" action="{html.escape(base)}/pair">'
            f'<input type="hidden" name="csrf" value="{html.escape(csrf)}">'
            '<label>Code <input name="user_code" autocomplete="off" autofocus></label> '
            '<button type="submit">Continue</button></form>'
        )
        return _page(200, "Enter code", form)

    async def pair(request: HandlerRequest) -> HandlerResponse:
        if not config.pairing:
            return _not_found()
        if request.method == "GET":
            csrf = _random_id()
            cookie = f"{CSRF_COOKIE_NAME}={csrf}; HttpOnly; Secure; SameSite=Strict; Path={base}"
            page = _entry_page(csrf)
            page.headers.append(("set-cookie", cookie))
            return page
        if request.method != "POST":
            return _method_not_allowed("GET, POST")
        form = dict(
            parse_qsl(request.body.decode("utf-8", errors="replace"), keep_blank_values=True)
        )
        cookie_csrf = parse_cookie_header(request.headers.get("cookie")).get(CSRF_COOKIE_NAME, "")
        origin = request.headers.get("origin")
        if (
            not cookie_csrf
            or not hmac.compare_digest(cookie_csrf.encode(), form.get("csrf", "").encode())
            or (origin is not None and origin != app_origin)
        ):
            return HandlerResponse(
                403, [("content-type", "text/plain"), ("cache-control", "no-store")], b"Forbidden"
            )
        code = "".join(ch for ch in form.get("user_code", "").upper() if ch.isalpha())
        link = await peek(f"u:{code}") if code else None
        pairing_id = str(link.get("pairingId", "")) if link else ""
        pairing = await peek(f"p:{pairing_id}") if pairing_id else None
        if pairing is None or pairing.get("status") != "pending":
            return _entry_page(cookie_csrf, "That code is not valid or has expired.")
        if form.get("action") != "confirm":
            return _confirmation_page(cookie_csrf, code)
        if form.get("decision") == "cancel":
            pairing["status"] = "denied"
            await rewrite_pairing(pairing_id, pairing)
            return _page(
                200, "Sign-in cancelled", "<p>Sign-in cancelled. You can close this page.</p>"
            )
        return await start_login(
            {
                "target": {"mode": "pairing", "pairingId": pairing_id},
                "codeChallenge": pairing["codeChallenge"],
            }
        )

    def _confirmation_page(csrf: str, code: str) -> HandlerResponse:
        name = html.escape(config.app_name)
        shown = html.escape(_format_user_code(code))
        body = (
            f"<h1>Sign in to {name} on another device?</h1>"
            f"<p>Code: <strong>{shown}</strong></p>"
            "<p>Only continue if this code is on a screen in front of you right now. "
            "If someone sent you this code, do not continue "
            "— they are trying to use your account.</p>"
            f'<form method="post" action="{html.escape(base)}/pair">'
            f'<input type="hidden" name="csrf" value="{html.escape(csrf)}">'
            f'<input type="hidden" name="user_code" value="{html.escape(code)}">'
            '<input type="hidden" name="action" value="confirm">'
            '<button name="decision" value="continue" type="submit">Continue</button> '
            '<button name="decision" value="cancel" type="submit">Cancel</button></form>'
        )
        return _page(200, "Confirm sign-in", body)

    async def token(request: HandlerRequest) -> HandlerResponse:
        body = _load(request.body.decode("utf-8", errors="replace"))
        if "application/json" not in request.headers.get("content-type", "") or body is None:
            return _token_error("invalid_request")
        grant = body.get("grant_type")
        verifier = body.get("code_verifier")
        if not isinstance(verifier, str) or not _VERIFIER.match(verifier):
            return _token_error("invalid_request")
        if grant == "code" and set(body) == {"grant_type", "code", "code_verifier"}:
            code = body["code"]
            if not isinstance(code, str):
                return _token_error("invalid_request")
            record = await take(f"c:{code}")  # consumed before comparing: single use
            return _finish_grant(record, verifier)
        if grant == "pairing" and set(body) == {"grant_type", "pairing_id", "code_verifier"}:
            pairing_id = body["pairing_id"]
            if not isinstance(pairing_id, str) or not config.pairing:
                return _token_error("invalid_request")
            return await pairing_grant(pairing_id, verifier)
        return _token_error("invalid_request")

    def _finish_grant(record: dict[str, Any] | None, verifier: str) -> HandlerResponse:
        if (
            record is None
            or not isinstance(record.get("sessionToken"), str)
            or not isinstance(record.get("codeChallenge"), str)
            or not _matches(verifier, record["codeChallenge"])
        ):
            return _token_error("invalid_grant")
        return _json_response(200, {"session_token": record["sessionToken"]})

    async def pairing_grant(pairing_id: str, verifier: str) -> HandlerResponse:
        pairing = await peek(f"p:{pairing_id}")
        if pairing is None:
            return _token_error("invalid_grant")
        if int(pairing.get("expiresAt", 0)) <= auth.now_ms():
            await take(f"p:{pairing_id}")
            return _token_error("expired_token")
        status = pairing.get("status")
        if status == "pending":
            return _token_error("authorization_pending")
        consumed = await take(f"p:{pairing_id}")
        if consumed is None:
            return _token_error("invalid_grant")
        user_code = consumed.get("userCode")
        if isinstance(user_code, str):
            await take(f"u:{user_code}")
        if status == "denied":
            return _token_error("access_denied")
        return _finish_grant(
            {
                "sessionToken": consumed.get("sessionToken"),
                "codeChallenge": consumed.get("codeChallenge"),
            },
            verifier,
        )

    async def logout_route(request: HandlerRequest) -> HandlerResponse:
        session = request.headers.get(ENLITT_SESSION_HEADER_NAME.lower(), "")
        if session:
            inner = HandlerRequest(
                "POST",
                f"{app_origin}/",
                {"cookie": f"{cookie_name}={session}"},
                b"",
            )
            await logout(inner)  # revocation has exactly one implementation
        return HandlerResponse(204, [("cache-control", "no-store")])

    routes: dict[str, tuple[str, Callable[[HandlerRequest], Awaitable[HandlerResponse]]]] = {
        "/start": ("GET", start),
        "/complete": ("GET", complete),
        "/pairing": ("POST", pairing_create),
        "/token": ("POST", token),
        "/logout": ("POST", logout_route),
    }

    async def handle(request: HandlerRequest) -> HandlerResponse:
        path = urlsplit(request.url).path
        if not (path == base or path.startswith(base + "/")):
            return _not_found()
        sub = path[len(base) :]
        if sub == "/pair":
            return await pair(request)
        route = routes.get(sub)
        if route is None:
            return _not_found()
        method, endpoint = route
        if request.method != method:
            return _method_not_allowed(method)
        return await endpoint(request)

    return handle


def _not_found() -> HandlerResponse:
    return HandlerResponse(
        404, [("content-type", "text/plain"), ("cache-control", "no-store")], b"Not found"
    )


def _method_not_allowed(allow: str) -> HandlerResponse:
    return HandlerResponse(
        405,
        [("content-type", "text/plain"), ("cache-control", "no-store"), ("allow", allow)],
        b"Method not allowed",
    )


def _refuse_start(
    config: ClientSignInConfig, pairs: list[tuple[str, str]], query: dict[str, str]
) -> str | None:
    """Why a ``start`` query is refused, or ``None`` when it is valid."""
    names = [name for name, _ in pairs]
    if len(set(names)) != len(names):
        return "The sign-in request is not valid."
    mode = query.get("mode")
    allowed = set(_START_FIELDS)
    if mode == "loopback" and config.loopback:
        allowed.add("port")
    elif mode == "redirect" and config.return_urls:
        allowed.add("redirect_uri")
    else:
        return "The sign-in request is not valid."
    if set(query) != allowed:
        return "The sign-in request is not valid."
    if not _STATE.match(query["state"]) or not _CHALLENGE.match(query["code_challenge"]):
        return "The sign-in request is not valid."
    if query["code_challenge_method"] != "S256":
        return "The sign-in request is not valid."
    if mode == "loopback":
        port = query["port"]
        if not (
            port.isascii()
            and port.isdigit()
            and str(int(port)) == port
            and 1024 <= int(port) <= 65535
        ):
            return "The sign-in request is not valid."
    elif query["redirect_uri"] not in config.return_urls:
        return "The sign-in request is not valid."
    return None
