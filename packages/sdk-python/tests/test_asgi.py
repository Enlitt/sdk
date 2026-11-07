"""ASGI glue: the session middleware and the handler wrapper."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from enlitt import EnlittConfigurationError, get_enlitt_session
from enlitt.asgi import MAX_REQUEST_BODY_BYTES, EnlittSessionMiddleware, asgi_app
from enlitt.auth import HandlerRequest, HandlerResponse


def client_for(app: Any) -> httpx.AsyncClient:
    """An httpx client that talks to ``app`` in-process (no network)."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://app.test")


def reporting_app(seen: list[Any]) -> Any:
    """An ASGI app that records the session it sees, or ``unset`` outside any context."""

    async def app(scope: Any, receive: Any, send: Any) -> None:
        try:
            current = get_enlitt_session()
            seen.append(current.token if current else None)
        except EnlittConfigurationError:
            seen.append("unset")
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return app


async def visit(app: Any, headers: dict[str, str] | None = None) -> None:
    async with client_for(app) as client:
        await client.get("/", headers=headers)


async def test_cookie_becomes_the_session() -> None:
    seen: list[Any] = []
    await visit(
        EnlittSessionMiddleware(reporting_app(seen)), {"cookie": "a=1; enlitt_session=tok1"}
    )
    assert seen == ["tok1"]


async def test_no_cookie_is_an_explicit_null_session_not_an_unset_one() -> None:
    seen: list[Any] = []
    await visit(EnlittSessionMiddleware(reporting_app(seen)))
    assert seen == [None]


async def test_header_is_ignored_unless_enabled() -> None:
    seen: list[Any] = []
    await visit(EnlittSessionMiddleware(reporting_app(seen)), {"enlitt-session": "from-header"})
    assert seen == [None]


async def test_header_wins_over_cookie_when_enabled() -> None:
    seen: list[Any] = []
    app = EnlittSessionMiddleware(reporting_app(seen), header=True)
    await visit(app, {"enlitt-session": "from-header", "cookie": "enlitt_session=from-cookie"})
    await visit(app, {"cookie": "enlitt_session=from-cookie"})
    await visit(app, {"enlitt-session": "", "cookie": "enlitt_session=from-cookie"})
    assert seen == ["from-header", "from-cookie", "from-cookie"]


async def test_custom_cookie_name_and_oversize_token() -> None:
    seen: list[Any] = []
    app = EnlittSessionMiddleware(reporting_app(seen), cookie_name="my_cookie")
    await visit(app, {"cookie": "my_cookie=custom; enlitt_session=ignored"})
    await visit(app, {"cookie": "my_cookie=" + "x" * 5000})
    assert seen == ["custom", None]


async def test_middleware_never_rejects_and_lifespan_passes_through() -> None:
    calls: list[str] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        calls.append(scope["type"])

    await EnlittSessionMiddleware(inner)({"type": "lifespan"}, None, None)  # type: ignore[arg-type]
    assert calls == ["lifespan"]


# -------------------------------------------------------------------------- handler wrapper


async def test_asgi_app_builds_the_neutral_request_and_writes_the_response() -> None:
    received: list[HandlerRequest] = []

    async def handler(req: HandlerRequest) -> HandlerResponse:
        received.append(req)
        return HandlerResponse(
            303,
            [("Location", "/next"), ("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")],
            b"body",
        )

    async with client_for(asgi_app(handler)) as client:
        response = await client.post("/x/y?q=1", content=b"payload", headers={"cookie": "c=1"})
    assert response.status_code == 303
    assert response.headers["location"] == "/next"
    assert response.headers.get_list("set-cookie") == ["a=1", "b=2"]
    assert response.content == b"body"
    request = received[0]
    assert (request.method, request.body) == ("POST", b"payload")
    assert request.url == "http://app.test/x/y?q=1" or request.url == "https://app.test/x/y?q=1"
    assert request.headers["cookie"] == "c=1"


async def test_oversize_body_is_413_without_calling_the_handler() -> None:
    called = False

    async def handler(req: HandlerRequest) -> HandlerResponse:
        nonlocal called
        called = True
        return HandlerResponse(200)

    async with client_for(asgi_app(handler)) as client:
        response = await client.post("/", content=b"x" * (MAX_REQUEST_BODY_BYTES + 1))
    assert response.status_code == 413
    assert not called


async def test_asgi_app_refuses_non_http_scopes() -> None:
    async def handler(req: HandlerRequest) -> HandlerResponse:
        return HandlerResponse(200)

    with pytest.raises(RuntimeError):
        await asgi_app(handler)({"type": "websocket"}, None, None)  # type: ignore[arg-type]
