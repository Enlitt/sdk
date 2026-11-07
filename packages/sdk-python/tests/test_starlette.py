"""The Starlette binding: routes, session middleware, and one client sign-in flow."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from _support import APP_ORIGIN, EXCHANGED_TOKEN, callback_config, exchange_ok
from enlitt import EnlittConfigurationError, get_enlitt_session
from enlitt.asgi import EnlittSessionMiddleware
from enlitt.client_sign_in import ClientSignInConfig, MemoryClientSignInStore
from enlitt.starlette import enlitt_routes

CHALLENGE = "A" * 43


async def whoami(request: Request) -> JSONResponse:
    session = get_enlitt_session()
    return JSONResponse({"token": session.token if session else None})


def make_app(config: Any, **kwargs: Any) -> Starlette:
    return Starlette(
        routes=[Route("/whoami", whoami), *enlitt_routes(config=config, **kwargs)],
        middleware=[Middleware(EnlittSessionMiddleware, header=True)],
    )


def client_for(app: Starlette) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=APP_ORIGIN)


async def test_login_callback_and_session_round_trip(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    async with client_for(make_app(config)) as client:
        login = await client.get("/enlitt/login?return_to=/welcome")
        assert login.status_code == 303
        state = parse_qs(urlsplit(login.headers["location"]).query)["state"][0]

        callback = await client.get(f"/enlitt/callback?code=c&state={state}")
        assert callback.status_code == 303
        assert callback.headers["location"] == f"{APP_ORIGIN}/welcome"
        cookie = callback.headers["set-cookie"].split(";")[0]
        assert cookie == f"enlitt_session={EXCHANGED_TOKEN}"

        seen = await client.get("/whoami", headers={"cookie": cookie})
        assert seen.json() == {"token": EXCHANGED_TOKEN}
        client.cookies.clear()  # the client's jar kept the Secure cookie; a visitor has none
        assert (await client.get("/whoami")).json() == {"token": None}


async def test_logout_route_clears_the_cookie(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/revoke").mock(return_value=httpx.Response(200, json={}))
    async with client_for(make_app(callback_config())) as client:
        response = await client.post("/enlitt/logout", headers={"cookie": "enlitt_session=tok"})
    assert response.status_code == 303
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_callback_path_must_match_the_redirect_uri() -> None:
    with pytest.raises(EnlittConfigurationError):
        enlitt_routes(config=callback_config(), callback_path="/other")


async def test_client_sign_in_is_mounted_and_the_session_header_reaches_get_session(
    api: respx.MockRouter,
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    sign_in = ClientSignInConfig(
        callback=config,
        base_path="/enlitt/client",
        app_name="Game",
        store=MemoryClientSignInStore(),
    )
    async with client_for(make_app(config, client_sign_in=sign_in)) as client:
        started = await client.get(
            "/enlitt/client/start",
            params={
                "mode": "loopback",
                "port": "8080",
                "state": "s1",
                "code_challenge": CHALLENGE,
                "code_challenge_method": "S256",
            },
        )
        assert started.status_code == 303
        state = parse_qs(urlsplit(started.headers["location"]).query)["state"][0]
        callback = await client.get(f"/enlitt/callback?code=c&state={state}")
        cookie = callback.headers["set-cookie"].split(";")[0]
        complete = await client.get(callback.headers["location"], headers={"cookie": cookie})
        assert complete.status_code == 303
        assert complete.headers["location"].startswith("http://127.0.0.1:8080/callback?code=")

        # A native client sends the token it holds in the Enlitt-Session header.
        by_header = await client.get("/whoami", headers={"Enlitt-Session": "native_client_token"})
        assert by_header.json() == {"token": "native_client_token"}

        unknown = await client.get("/enlitt/client/nope")
        assert unknown.status_code == 404
        token_route = await client.post(
            "/enlitt/client/token",
            content=json.dumps({"grant_type": "code", "code": "x", "code_verifier": "v" * 43}),
            headers={"content-type": "application/json"},
        )
        assert token_route.status_code == 400
        assert token_route.json() == {"error": "invalid_grant"}
