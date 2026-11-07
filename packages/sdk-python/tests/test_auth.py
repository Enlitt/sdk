"""Account handlers: login start, callback, logout (``callback.test.ts``)."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx

from _support import (
    APP_ORIGIN,
    CLIENT_ID,
    DASHBOARD_ORIGIN,
    EXCHANGED_SUBJECT,
    EXCHANGED_TOKEN,
    REDIRECT_URI,
    SECRET,
    callback_config,
    exchange_ok,
    header_values,
    request,
)
from enlitt import EnlittConfigurationError
from enlitt.auth import (
    HandlerResponse,
    MemoryStateStore,
    SignInIdentity,
    StateRecord,
    callback_handler,
    login_start_handler,
    logout_handler,
    now_ms,
    validate_return_to,
)

CALLBACK = f"{REDIRECT_URI}"


async def start(config: object, return_to: str | None = None) -> tuple[str, str]:
    """Run login start and return ``(state, location)``."""
    url = f"{APP_ORIGIN}/enlitt/login"
    if return_to is not None:
        url += f"?return_to={return_to}"
    response = await login_start_handler(config)(request(url))  # type: ignore[arg-type]
    location = header_values(response, "location")[0]
    return parse_qs(urlsplit(location).query)["state"][0], location


def no_cookie(response: HandlerResponse) -> None:
    assert header_values(response, "set-cookie") == []


# ------------------------------------------------------------------------------- login start


async def test_login_start_redirects_with_client_id_exact_redirect_and_fresh_state() -> None:
    config = callback_config()
    state_a, location = await start(config)
    state_b, _ = await start(config)
    parts = urlsplit(location)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == (
        f"{DASHBOARD_ORIGIN}/auth/oauth2/authorize"
    )
    query = parse_qs(parts.query)
    assert query["client_id"] == [CLIENT_ID]
    assert query["redirect_uri"] == [REDIRECT_URI]
    assert query["response_type"] == ["code"]
    assert len(state_a) == len(state_b) == 43
    assert state_a != state_b


async def test_login_start_response_is_a_no_store_303() -> None:
    response = await login_start_handler(callback_config())(request(f"{APP_ORIGIN}/enlitt/login"))
    assert response.status == 303
    assert header_values(response, "cache-control") == ["no-store"]


def test_construction_refuses_bad_config() -> None:
    with pytest.raises(EnlittConfigurationError):
        login_start_handler(callback_config(client_id=""))
    with pytest.raises(EnlittConfigurationError):
        login_start_handler(callback_config(default_return_to="https://evil.test/"))
    with pytest.raises(EnlittConfigurationError):
        login_start_handler(callback_config(redirect_uri="/relative"))


# ---------------------------------------------------------------------------------- callback


async def test_missing_unknown_expired_replayed_and_foreign_state_never_exchange(
    api: respx.MockRouter,
) -> None:
    store = MemoryStateStore()
    config = callback_config(state_store=store)
    exchange = api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    handler = callback_handler(config)
    store.set("expired", StateRecord(now_ms() - 20_000, now_ms() - 10_000), 600_000)
    state, _ = await start(config)

    cases = [
        f"{CALLBACK}?code=abc",
        f"{CALLBACK}?code=abc&state=unknown",
        f"{CALLBACK}?code=abc&state=expired",
    ]
    for url in cases:
        response = await handler(request(url))
        assert response.status == 303
        assert header_values(response, "location") == [f"{APP_ORIGIN}/home"]
        no_cookie(response)
    assert exchange.call_count == 0

    # Replay: the first use consumes the state; the second is refused without an exchange.
    first = await handler(request(f"{CALLBACK}?code=abc&state={state}"))
    assert header_values(first, "set-cookie")
    replay = await handler(request(f"{CALLBACK}?code=abc&state={state}"))
    no_cookie(replay)
    assert exchange.call_count == 1


async def test_state_started_for_another_store_is_foreign() -> None:
    other = callback_config()
    state, _ = await start(other)
    response = await callback_handler(callback_config())(
        request(f"{CALLBACK}?code=abc&state={state}")
    )
    no_cookie(response)


async def test_successful_exchange_sets_exactly_one_secure_cookie(
    api: respx.MockRouter,
) -> None:
    exchange = api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    state, _ = await start(config, return_to="/dashboard?tab=1")
    response = await callback_handler(config)(request(f"{CALLBACK}?code=the-code&state={state}"))

    assert response.status == 303
    assert header_values(response, "location") == [f"{APP_ORIGIN}/dashboard?tab=1"]
    cookies = header_values(response, "set-cookie")
    assert len(cookies) == 1
    cookie = cookies[0]
    assert cookie.startswith(f"enlitt_session={EXCHANGED_TOKEN};")
    for attribute in ("HttpOnly", "Secure", "SameSite=Lax"):
        assert attribute in cookie
    # The token is only in the cookie: never in a URL, redirect or body.
    assert EXCHANGED_TOKEN not in header_values(response, "location")[0]
    assert EXCHANGED_TOKEN.encode() not in response.body

    sent = exchange.calls.last.request
    assert sent.headers["authorization"] == f"Bearer {SECRET}"
    assert sent.headers["enlitt-version"] == "2026-10-05"
    form = parse_qs(sent.content.decode())
    assert form == {
        "grant_type": ["authorization_code"],
        "code": ["the-code"],
        "redirect_uri": [REDIRECT_URI],
        "client_id": [CLIENT_ID],
    }
    assert len([h for h in sent.headers if h.lower() == "enlitt-version"]) == 1


@pytest.mark.parametrize(
    "target",
    [
        "https://evil.test/x",
        "//evil.test/x",
        "/%2e%2e/%2e%2e/etc",
        "/..%2f..%2fetc",
        "javascript:alert(1)",
        "/\\evil.test",
    ],
)
async def test_unsafe_return_targets_are_replaced_by_the_default(
    api: respx.MockRouter, target: str
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    state, _ = await start(config, return_to=target)
    response = await callback_handler(config)(request(f"{CALLBACK}?code=c&state={state}"))
    assert header_values(response, "location") == [f"{APP_ORIGIN}/home"]


def test_validate_return_to_accepts_same_origin_paths_only() -> None:
    assert validate_return_to("/a/b?c=d", APP_ORIGIN) == "/a/b?c=d"
    assert validate_return_to("https://evil.test/", APP_ORIGIN) is None
    assert validate_return_to(None, APP_ORIGIN) is None
    assert validate_return_to("//evil.test", APP_ORIGIN) is None
    assert validate_return_to("/x" * 2000, APP_ORIGIN) is None


async def test_failed_exchange_is_signed_out_with_no_cookie(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(
        return_value=httpx.Response(
            400,
            json={
                "error": {
                    "message": "bad",
                    "type": "invalid_request_error",
                    "param": None,
                    "code": "invalid_value",
                }
            },
        )
    )
    config = callback_config()
    state, _ = await start(config)
    response = await callback_handler(config)(request(f"{CALLBACK}?code=c&state={state}"))
    assert response.status == 303
    no_cookie(response)


async def test_token_or_subject_in_the_callback_request_is_never_honored(
    api: respx.MockRouter,
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    seen: list[str] = []
    config = callback_config(on_sign_in=lambda who, _r: seen.append(who.subject))
    state, _ = await start(config)
    url = f"{CALLBACK}?code=c&state={state}&session_token=forged&token=forged&subject=forged"
    response = await callback_handler(config)(
        request(url, headers={"cookie": "enlitt_session=forged"})
    )
    assert "forged" not in header_values(response, "set-cookie")[0]
    assert seen == [EXCHANGED_SUBJECT]


async def test_cancelled_login_returns_to_the_stored_target_signed_out(
    api: respx.MockRouter,
) -> None:
    """Signed-out outcomes: a live state sends every failure to the record's return_to."""
    exchange = api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    handler = callback_handler(config)

    state, _ = await start(config, return_to="/pricing")
    cancelled = await handler(request(f"{CALLBACK}?error=access_denied&state={state}"))
    assert cancelled.status == 303
    assert header_values(cancelled, "location") == [f"{APP_ORIGIN}/pricing"]
    no_cookie(cancelled)

    state, _ = await start(config, return_to="/pricing")
    missing_code = await handler(request(f"{CALLBACK}?state={state}"))
    assert header_values(missing_code, "location") == [f"{APP_ORIGIN}/pricing"]
    no_cookie(missing_code)
    assert exchange.call_count == 0

    api.post("/auth/oauth2/token").mock(return_value=httpx.Response(500, json={}))
    state, _ = await start(config, return_to="/pricing")
    failed = await handler(request(f"{CALLBACK}?code=c&state={state}"))
    assert header_values(failed, "location") == [f"{APP_ORIGIN}/pricing"]
    no_cookie(failed)

    state, _ = await start(config)  # no return_to stored: the default page
    default = await handler(request(f"{CALLBACK}?error=access_denied&state={state}"))
    assert header_values(default, "location") == [f"{APP_ORIGIN}/home"]

    unknown = await handler(request(f"{CALLBACK}?error=access_denied&state=unknown"))
    assert header_values(unknown, "location") == [f"{APP_ORIGIN}/home"]
    no_cookie(unknown)


async def test_a_cancelled_state_cannot_be_replayed_into_a_login(api: respx.MockRouter) -> None:
    exchange = api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    config = callback_config()
    handler = callback_handler(config)
    state, _ = await start(config)
    await handler(request(f"{CALLBACK}?error=access_denied&state={state}"))
    replay = await handler(request(f"{CALLBACK}?code=c&state={state}"))
    no_cookie(replay)
    assert exchange.call_count == 0


# ------------------------------------------------------------------------------ on_sign_in


async def test_on_sign_in_gets_only_the_subject_and_can_add_its_own_cookie(
    api: respx.MockRouter,
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    received: list[SignInIdentity] = []

    async def hook(who: SignInIdentity, response: HandlerResponse) -> None:
        received.append(who)
        response.headers.append(("set-cookie", "app_session=1; Path=/"))

    config = callback_config(on_sign_in=hook)
    state, _ = await start(config)
    handler = callback_handler(config)
    response = await handler(request(f"{CALLBACK}?code=c&state={state}"))
    assert received == [SignInIdentity(EXCHANGED_SUBJECT)]
    cookies = header_values(response, "set-cookie")
    assert len(cookies) == 2
    assert any(c.startswith("app_session=1") for c in cookies)
    assert any(c.startswith("enlitt_session=") for c in cookies)

    await handler(request(f"{CALLBACK}?code=c&state={state}"))  # replay
    assert len(received) == 1


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, json={"session_token": "t"}),
        httpx.Response(200, json={"session_token": "t", "subject": "has space"}),
        httpx.Response(200, json={"session_token": "t", "subject": 5}),
        httpx.Response(200, json={"session_token": "t", "subject": ""}),
        httpx.Response(200, content=b"not json"),
        httpx.Response(401, json={}),
    ],
)
async def test_failed_paths_invoke_no_hook(api: respx.MockRouter, answer: httpx.Response) -> None:
    api.post("/auth/oauth2/token").mock(return_value=answer)
    called: list[object] = []
    config = callback_config(on_sign_in=lambda who, _r: called.append(who))
    state, _ = await start(config)
    response = await callback_handler(config)(request(f"{CALLBACK}?code=c&state={state}"))
    no_cookie(response)
    assert called == []


async def test_hook_error_propagates(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())

    def hook(who: SignInIdentity, response: HandlerResponse) -> None:
        raise RuntimeError("database down")

    config = callback_config(on_sign_in=hook)
    state, _ = await start(config)
    with pytest.raises(RuntimeError, match="database down"):
        await callback_handler(config)(request(f"{CALLBACK}?code=c&state={state}"))


async def test_hook_is_not_called_for_cancelled_or_unknown_state() -> None:
    called: list[object] = []
    config = callback_config(on_sign_in=lambda who, _r: called.append(who))
    state, _ = await start(config)
    handler = callback_handler(config)
    await handler(request(f"{CALLBACK}?error=access_denied&state={state}"))
    await handler(request(f"{CALLBACK}?code=c&state=unknown"))
    assert called == []


# -------------------------------------------------------------------------------- logout


async def test_logout_revokes_and_clears_the_cookie(api: respx.MockRouter) -> None:
    revoke = api.post("/auth/oauth2/revoke").mock(return_value=httpx.Response(200, json={}))
    response = await logout_handler(callback_config())(
        request(
            f"{APP_ORIGIN}/enlitt/logout?return_to=/bye",
            headers={"cookie": "other=1; enlitt_session=tok_to_revoke"},
        )
    )
    assert response.status == 303
    assert header_values(response, "location") == [f"{APP_ORIGIN}/bye"]
    cleared = header_values(response, "set-cookie")
    assert len(cleared) == 1
    assert cleared[0].startswith("enlitt_session=;") and "Max-Age=0" in cleared[0]
    sent = revoke.calls.last.request
    assert parse_qs(sent.content.decode()) == {"token": ["tok_to_revoke"], "client_id": [CLIENT_ID]}
    assert sent.headers["authorization"] == f"Bearer {SECRET}"
    assert sent.headers["enlitt-version"] == "2026-10-05"


async def test_logout_without_cookie_makes_no_request_and_failed_revocation_still_clears(
    api: respx.MockRouter,
) -> None:
    revoke = api.post("/auth/oauth2/revoke").mock(side_effect=httpx.ConnectError("down"))
    handler = logout_handler(callback_config())
    bare = await handler(request(f"{APP_ORIGIN}/enlitt/logout"))
    assert revoke.call_count == 0
    assert header_values(bare, "set-cookie")
    failing = await handler(
        request(f"{APP_ORIGIN}/enlitt/logout", headers={"cookie": "enlitt_session=tok"})
    )
    assert revoke.call_count == 1
    assert "Max-Age=0" in header_values(failing, "set-cookie")[0]


# -------------------------------------------------------------------------------- secrets


def test_explicit_business_secret_is_used_for_the_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ENLITT_SECRET_KEY")
    with pytest.raises(EnlittConfigurationError):
        callback_handler(callback_config())
    callback_handler(callback_config(secret_key="sk_explicit"))
