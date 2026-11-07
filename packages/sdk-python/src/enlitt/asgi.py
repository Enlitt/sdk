"""ASGI glue: the session middleware and a wrapper that serves a framework-neutral handler."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from ._cookies import parse_cookie_header
from .auth import Handler, HandlerRequest
from .errors import EnlittConfigurationError
from .session import (
    ENLITT_SESSION_COOKIE_NAME,
    ENLITT_SESSION_HEADER_NAME,
    EnlittSession,
    enlitt_session,
    run_with_enlitt_session,
)

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

MAX_REQUEST_BODY_BYTES = 1024 * 1024
"""Account handler bodies are tiny; anything larger is refused rather than buffered."""


def _headers(scope: Scope) -> dict[str, str]:
    """Lowercase header names; repeated headers are joined (cookies with ``; ``)."""
    out: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers", []):
        name = raw_name.decode("latin-1").lower()
        value = raw_value.decode("latin-1")
        separator = "; " if name == "cookie" else ", "
        out[name] = f"{out[name]}{separator}{value}" if name in out else value
    return out


class EnlittSessionMiddleware:
    """Pure ASGI middleware: run the downstream app inside the Enlitt session context.

    It never rejects a request. A request with no (or an unusable) session proceeds with an
    explicit null session, which is how a signed-out visitor differs from a missing middleware.
    It performs no network call and no validation.

    Args:
        app: The downstream ASGI application.
        cookie_name: Must equal the callback config's ``cookie_name``.
        header: When true, a non-empty ``Enlitt-Session`` header is the session and the cookie is
            read only when the header is absent or empty. Default false ignores the header.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        cookie_name: str = ENLITT_SESSION_COOKIE_NAME,
        header: bool = False,
    ) -> None:
        self.app = app
        self.cookie_name = cookie_name
        self.header = header

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)  # lifespan passes straight through
            return
        session = self._read_session(_headers(scope))
        await run_with_enlitt_session(session, lambda: self.app(scope, receive, send))

    def _read_session(self, headers: dict[str, str]) -> EnlittSession | None:
        token: str | None = None
        if self.header:
            token = headers.get(ENLITT_SESSION_HEADER_NAME.lower()) or None
        if not token:
            token = parse_cookie_header(headers.get("cookie")).get(self.cookie_name)
        if not token:
            return None
        try:
            return enlitt_session(token)
        except EnlittConfigurationError:
            return None  # a token outside the bound is the same as no token


class _HandlerApp:
    """An ASGI application that serves one :data:`Handler`.

    A class (not a function) so Starlette treats it as an ASGI app rather than a view.
    """

    def __init__(self, handler: Handler) -> None:
        self._handler = handler

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            raise RuntimeError("asgi_app serves http requests only.")
        body = b""
        more = True
        while more:
            message = await receive()
            body += message.get("body", b"")
            more = bool(message.get("more_body", False))
            if len(body) > MAX_REQUEST_BODY_BYTES:
                await send({"type": "http.response.start", "status": 413, "headers": []})
                await send({"type": "http.response.body", "body": b""})
                return
        headers = _headers(scope)
        path = str(scope["path"])
        root = str(scope.get("root_path", ""))
        if root and not path.startswith(root):
            path = root + path
        query = scope.get("query_string", b"").decode("latin-1")
        host = headers.get("host") or "localhost"
        url = f"{scope.get('scheme', 'http')}://{host}{path}" + (f"?{query}" if query else "")
        response = await self._handler(HandlerRequest(str(scope["method"]), url, headers, body))
        await send(
            {
                "type": "http.response.start",
                "status": response.status,
                "headers": [
                    (name.lower().encode("latin-1"), value.encode("latin-1"))
                    for name, value in response.headers
                ],
            }
        )
        await send({"type": "http.response.body", "body": response.body})


def asgi_app(handler: Handler) -> ASGIApp:
    """Wrap one framework-neutral handler as an ASGI application."""
    return _HandlerApp(handler)
