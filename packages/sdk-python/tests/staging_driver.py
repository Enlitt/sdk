"""Staging driver: runs the Python SDK against a deployed Enlitt Worker.

It is spawned by ``tests/staging/sdk-python.test.ts`` and is never part of ``pytest``. It prints
one JSON line per check, ``{"check", "ok", "detail"}``, where ``detail`` holds error codes and
counts only: never a token, a secret, or model content.

Inputs arrive only through the child's environment:

* ``ENLITT_BASE_URL``, ``ENLITT_SECRET_KEY``: the Worker and the business key.
* ``ENLITT_SESSION_TOKEN``: a seeded personal-session token for the model calls.
* ``ENLITT_ORIGIN``: the dashboard origin that serves the authorize step.
* ``ENLITT_CLIENT_ID``, ``ENLITT_REDIRECT_URI``: the seeded application and its registered
  callback URL (its origin is also the local app's origin).
* ``ENLITT_PERSONAL_COOKIE``: the full ``Cookie`` header value of the seeded personal session
  used by the authorize step (there is no browser and no email).
* ``ENLITT_TEST_PROVIDER_TOKEN`` (optional): when set, every request to the Worker carries the
  two staging test-provider headers, so standard calls use the recorded provider and cost no
  real model call (``tests/staging/harness/standard-provider.ts``).

The local app is driven in process through httpx's ASGI transport: the loopback redirect target
is parsed, never connected to, so no port is opened.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sys
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import httpx

from enlitt import (
    EnlittError,
    EnlittLoginRequiredError,
    EnlittOptions,
    PremiumChargeFunction,
    PremiumChargeHandle,
    PremiumProvider,
    WithPremiumChargeOptions,
    enlitt_session,
    usage,
    with_premium_charge,
)
from enlitt._transport import shared_http_client
from enlitt.asgi import EnlittSessionMiddleware, asgi_app
from enlitt.auth import (
    CallbackConfig,
    MemoryStateStore,
    callback_handler,
)
from enlitt.client_sign_in import (
    ClientSignInConfig,
    MemoryClientSignInStore,
    client_sign_in_handler,
)
from enlitt.openai import enlitt as enlitt_openai

LOOPBACK_PORT = 45819
BASE_PATH = "/enlitt/client"
CALLBACK_PATH = "/enlitt/callback"


def report(check: str, ok: bool, detail: dict[str, Any]) -> None:
    """Print one result line."""
    print(json.dumps({"check": check, "ok": ok, "detail": detail}), flush=True)


async def run_check(name: str, check: Callable[[], Awaitable[dict[str, Any]]]) -> None:
    """Run one check; an exception becomes a failed line naming only its type and code."""
    try:
        detail = await check()
    except EnlittError as error:
        report(name, False, {"error": type(error).__name__, "code": error.code})
    except Exception as error:
        report(name, False, {"error": type(error).__name__})
    else:
        report(name, True, detail)


def env(name: str) -> str:
    """A required environment value (the name, never the value, appears in errors)."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# -- model-call checks -----------------------------------------------------------------------


async def check_standard_call(options: EnlittOptions) -> dict[str, Any]:
    client = enlitt_openai(None, options)
    result = await client.responses.create(model="enlitt-standard", input="Reply with: ok")
    return {"status": result.status, "has_text": bool(result.output_text)}


async def check_standard_stream(options: EnlittOptions) -> dict[str, Any]:
    client = enlitt_openai(None, options)
    stream = await client.responses.create(
        model="enlitt-standard", input="Reply with: ok", stream=True
    )
    finishes = 0
    events = 0
    async for event in stream:
        events += 1
        if event.type in ("response.completed", "response.incomplete", "response.failed"):
            finishes += 1
    if finishes != 1:
        raise RuntimeError(f"expected one finish, saw {finishes}")
    return {"events": events, "finishes": finishes}


async def check_usage(options: EnlittOptions) -> dict[str, Any]:
    result = await usage(options)
    return {
        "standard_percent": result.standard.remaining_percent,
        "premium_percent": result.premium.remaining_percent,
    }


async def check_premium(options: EnlittOptions) -> dict[str, Any]:
    """A premium charge around a local provider double, with a constant price."""
    provider_calls = 0

    async def run(charge: PremiumChargeFunction, handle: PremiumChargeHandle) -> str:
        nonlocal provider_calls
        provider_calls += 1  # the "provider" is this local double
        charge("1")
        return handle.operation_id

    operation_id = await with_premium_charge(
        WithPremiumChargeOptions(
            session=options.session,
            max_charge="1000",
            provider=PremiumProvider(id="staging-double", model="double-1"),
        ),
        run,
    )
    return {"provider_calls": provider_calls, "has_operation_id": bool(operation_id)}


async def check_login_required() -> dict[str, Any]:
    """A garbage session is refused before the provider double runs."""
    provider_calls = 0

    async def run(charge: PremiumChargeFunction, handle: PremiumChargeHandle) -> None:
        nonlocal provider_calls
        provider_calls += 1

    options = WithPremiumChargeOptions(
        session=enlitt_session("garbage-session-token-for-driver-check"),
        max_charge="1000",
        provider=PremiumProvider(id="staging-double", model="double-1"),
    )
    try:
        await with_premium_charge(options, run)
    except EnlittLoginRequiredError as error:
        if provider_calls:
            raise RuntimeError("the provider ran before admission") from None
        return {"code": error.code, "provider_calls": provider_calls}
    raise RuntimeError("a garbage session was admitted")


# -- client sign-in loopback -----------------------------------------------------------------


def build_local_app(session_options: EnlittOptions) -> Any:
    """The business app: callback, client sign-in, and one header-authenticated model route."""
    redirect_uri = env("ENLITT_REDIRECT_URI")
    parts = urlsplit(redirect_uri)
    callback = CallbackConfig(
        client_id=env("ENLITT_CLIENT_ID"),
        redirect_uri=redirect_uri,
        app_origin=f"{parts.scheme}://{parts.netloc}",
        default_return_to="/",
        state_store=MemoryStateStore(),
        enlitt_origin=env("ENLITT_ORIGIN"),
        enlitt_api_origin=env("ENLITT_BASE_URL"),
    )
    callback_app = asgi_app(callback_handler(callback))
    sign_in_app = asgi_app(
        client_sign_in_handler(
            ClientSignInConfig(
                callback=callback,
                base_path=BASE_PATH,
                app_name="Staging driver",
                store=MemoryClientSignInStore(),
            )
        )
    )

    async def app(scope: Any, receive: Any, send: Any) -> None:
        path = scope["path"]
        if path.startswith(BASE_PATH):
            await sign_in_app(scope, receive, send)
        elif path == "/model":
            # The ambient session comes from the middleware (the Enlitt-Session header).
            result = await enlitt_openai(None).responses.create(
                model="enlitt-standard", input="Reply with: ok"
            )
            body = json.dumps({"status": result.status}).encode()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": body})
        else:
            await callback_app(scope, receive, send)

    del session_options  # the local app resolves sessions from requests only
    return EnlittSessionMiddleware(app, header=True)


def location_of(response: httpx.Response) -> str:
    if response.status_code not in (302, 303, 307):
        raise RuntimeError(f"expected a redirect, got {response.status_code}")
    return response.headers["location"]


async def check_client_sign_in(options: EnlittOptions) -> dict[str, Any]:
    app = build_local_app(options)
    verifier = b64url(secrets.token_bytes(48))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(16))
    query = httpx.QueryParams(
        {
            "mode": "loopback",
            "port": str(LOOPBACK_PORT),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    redirect_uri = env("ENLITT_REDIRECT_URI")
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(redirect_uri))
    steps = 0
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=origin, follow_redirects=False
        ) as local,
        httpx.AsyncClient(follow_redirects=False, trust_env=False) as remote,
    ):
        # 1. start -> redirect to Enlitt's authorize step.
        authorize = location_of(await local.get(f"{BASE_PATH}/start", params=query))
        steps += 1
        # 2. authorize, with the seeded personal-session cookie, run by hand.
        response = await remote.get(authorize, headers={"cookie": env("ENLITT_PERSONAL_COOKIE")})
        callback_url = location_of(response)
        steps += 1
        # 3. callback -> complete -> loopback redirect, back through the local app.
        location = callback_url
        for _ in range(4):
            target = urlsplit(location)
            if target.hostname == "127.0.0.1":
                break
            response = await local.get(target.path + (f"?{target.query}" if target.query else ""))
            location = location_of(response)
            steps += 1
        loopback = urlsplit(location)
        if loopback.hostname != "127.0.0.1" or loopback.port != LOOPBACK_PORT:
            raise RuntimeError("the flow did not end at the loopback target")
        params = dict(parse_qsl(loopback.query))
        if params.get("state") != state or "code" not in params:
            raise RuntimeError(
                f"loopback redirect lacks a matching state and code: {sorted(params)}"
            )
        # 4. token.
        token_response = await local.post(
            f"{BASE_PATH}/token",
            json={"grant_type": "code", "code": params["code"], "code_verifier": verifier},
        )
        if token_response.status_code != 200:
            raise RuntimeError(f"token answered {token_response.status_code}")
        session_token = token_response.json()["session_token"]
        # 5. one standard call with the Enlitt-Session header through the middleware.
        model = await local.get("/model", headers={"Enlitt-Session": session_token})
        if model.status_code != 200:
            raise RuntimeError(f"model route answered {model.status_code}")
    return {"redirects": steps, "model_status": model.json()["status"]}


def use_recorded_provider() -> None:
    """Route standard calls to staging's recorded provider when the test token is present.

    The SDK has no public header hook, so this adds an httpx request hook to the SDK's one shared
    client. It only touches requests to ``ENLITT_BASE_URL``, never the authorize step.
    """
    token = os.environ.get("ENLITT_TEST_PROVIDER_TOKEN")
    if not token:
        return
    base_host = httpx.URL(env("ENLITT_BASE_URL")).host

    async def add_headers(request: httpx.Request) -> None:
        if request.url.host == base_host:
            request.headers["x-enlitt-test-provider"] = "recorded"
            request.headers["x-enlitt-test-token"] = token

    shared_http_client().event_hooks["request"].append(add_headers)


async def main() -> int:
    use_recorded_provider()
    options = EnlittOptions(session=enlitt_session(env("ENLITT_SESSION_TOKEN")))
    await run_check("standard_call", lambda: check_standard_call(options))
    await run_check("standard_stream", lambda: check_standard_stream(options))
    await run_check("usage", lambda: check_usage(options))
    await run_check("premium_with_charge", lambda: check_premium(options))
    await run_check("login_required", check_login_required)
    await run_check("client_sign_in_loopback", lambda: check_client_sign_in(options))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
