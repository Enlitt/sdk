"""Client sign-in handoff: loopback, redirect, pairing, logout, secrecy."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest
import respx

from _support import (
    APP_ORIGIN,
    EXCHANGED_TOKEN,
    callback_config,
    exchange_ok,
    header_values,
    request,
)
from enlitt import EnlittConfigurationError
from enlitt.auth import HandlerResponse, callback_handler
from enlitt.client_sign_in import (
    CODE_TTL_MS,
    CSRF_COOKIE_NAME,
    USER_CODE_ALPHABET,
    ClientSignInConfig,
    MemoryClientSignInStore,
    client_sign_in_handler,
)

BASE = "/enlitt/client"
VERIFIER = "v" * 43
WRONG_VERIFIER = "w" * 43
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
)
STATE = "client-state-123"
REDIRECT_URL = "com.example.game://callback"


class Clock:
    """A settable clock for the store's time-to-live."""

    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class Harness:
    """A client sign-in handler plus the account callback it shares a state store with."""

    def __init__(self, **overrides: Any) -> None:
        self.clock = Clock()
        self.callback = callback_config()
        values: dict[str, Any] = {
            "callback": self.callback,
            "base_path": BASE,
            "app_name": "Space Game",
            "store": MemoryClientSignInStore(self.clock),
        }
        values.update(overrides)
        self.config = ClientSignInConfig(**values)
        self.handle = client_sign_in_handler(self.config)
        self.callback_route = callback_handler(self.callback)

    async def get(
        self, path: str, query: dict[str, str] | None = None, **kw: Any
    ) -> HandlerResponse:
        url = f"{APP_ORIGIN}{BASE}{path}"
        if query is not None:
            url += "?" + urlencode(query)
        return await self.handle(request(url, **kw))

    async def post_json(self, path: str, body: object, **headers: str) -> HandlerResponse:
        return await self.handle(
            request(
                f"{APP_ORIGIN}{BASE}{path}",
                method="POST",
                headers={"content-type": "application/json", **headers},
                body=json.dumps(body).encode(),
            )
        )

    def start_query(self, **extra: str) -> dict[str, str]:
        query = {
            "mode": "loopback",
            "port": "8080",
            "state": STATE,
            "code_challenge": CHALLENGE,
            "code_challenge_method": "S256",
        }
        query.update(extra)
        return query

    async def sign_in(
        self,
        *,
        query: dict[str, str] | None = None,
        cancel: bool = False,
        old_cookie: str | None = None,
    ) -> HandlerResponse:
        """Drive start -> authorize -> callback -> complete and return complete's response."""
        started = await self.get(
            "/start",
            query or self.start_query(),
            headers={"cookie": f"enlitt_session={old_cookie}"} if old_cookie else {},
        )
        assert started.status == 303, started.body
        authorize = header_values(started, "location")[0]
        state = parse_qs(urlsplit(authorize).query)["state"][0]
        callback_query = (
            {"state": state, "error": "access_denied"}
            if cancel
            else {"state": state, "code": "auth-code"}
        )
        callbacked = await self.callback_route(
            request(f"{APP_ORIGIN}/enlitt/callback?{urlencode(callback_query)}")
        )
        complete_url = header_values(callbacked, "location")[0]
        cookies = header_values(callbacked, "set-cookie")
        cookie_header = cookies[0].split(";")[0] if cookies else ""
        return await self.handle(request(complete_url, headers={"cookie": cookie_header}))


def token_of(response: HandlerResponse) -> str:
    return str(json.loads(response.body)["session_token"])


def error_of(response: HandlerResponse) -> str:
    assert response.status == 400
    return str(json.loads(response.body)["error"])


def code_from(location: str) -> str:
    return parse_qs(urlsplit(location).query)["code"][0]


# ------------------------------------------------------------------------- construction


@pytest.mark.parametrize(
    "bad",
    [
        "http://example.com/cb",
        "javascript:alert(1)",
        "game://callback",
        "com.example.game://cb#f",
        "https://",
        "not a url",
    ],
)
def test_return_urls_are_validated_at_construction(bad: str) -> None:
    with pytest.raises(EnlittConfigurationError):
        Harness(return_urls=(bad,))


@pytest.mark.parametrize("base", ["enlitt", "/enlitt/", "/a?b", ""])
def test_base_path_is_validated(base: str) -> None:
    with pytest.raises(EnlittConfigurationError):
        Harness(base_path=base)


def test_at_least_one_mode_and_a_sane_app_name_are_required() -> None:
    with pytest.raises(EnlittConfigurationError):
        Harness(loopback=False)
    with pytest.raises(EnlittConfigurationError):
        Harness(app_name="")
    with pytest.raises(EnlittConfigurationError):
        Harness(app_name="x" * 61)


# ----------------------------------------------------------------------------- start


@pytest.mark.parametrize(
    "mutation",
    [
        {"extra": "1"},
        {"code_challenge": ""},
        {"code_challenge_method": "plain"},
        {"port": "80"},
        {"port": "65536"},
        {"port": "08080"},
        {"port": "abc"},
        {"state": "has space"},
        {"mode": "redirect", "redirect_uri": REDIRECT_URL},  # disabled mode
    ],
)
async def test_invalid_start_requests_are_refused_with_400(mutation: dict[str, str]) -> None:
    harness = Harness()
    response = await harness.get("/start", harness.start_query(**mutation))
    assert response.status == 400


async def test_missing_challenge_is_refused() -> None:
    harness = Harness()
    query = harness.start_query()
    del query["code_challenge"]
    assert (await harness.get("/start", query)).status == 400


async def test_redirect_uri_must_match_exactly() -> None:
    harness = Harness(loopback=False, return_urls=(REDIRECT_URL,))
    good = {
        "mode": "redirect",
        "redirect_uri": REDIRECT_URL,
        "state": STATE,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
    }
    assert (await harness.get("/start", good)).status == 303
    assert (await harness.get("/start", {**good, "redirect_uri": REDIRECT_URL + "x"})).status == 400
    assert (await harness.get("/start", {**good, "redirect_uri": REDIRECT_URL[:-1]})).status == 400


async def test_valid_start_enters_login_with_return_to_and_clears_the_cookie() -> None:
    harness = Harness()
    response = await harness.get("/start", harness.start_query())
    assert response.status == 303
    location = header_values(response, "location")[0]
    assert location.startswith("https://dash.enlitt.test/auth/oauth2/authorize?")
    cleared = header_values(response, "set-cookie")
    assert len(cleared) == 1 and cleared[0].startswith("enlitt_session=;")
    # return_to is stored in the state record, so the callback lands on /complete?h=...
    state = parse_qs(urlsplit(location).query)["state"][0]
    record = harness.callback.state_store.get(state)
    assert record is not None
    assert re.fullmatch(rf"{BASE}/complete\?h=[A-Za-z0-9_-]{{43}}", record.return_to or "")


async def test_unknown_routes_and_wrong_methods() -> None:
    harness = Harness()
    assert (await harness.get("/nope")).status == 404
    assert (await harness.handle(request(f"{APP_ORIGIN}/elsewhere"))).status == 404
    wrong = await harness.handle(request(f"{APP_ORIGIN}{BASE}/token", method="GET"))
    assert wrong.status == 405


# ------------------------------------------------------------------------ loopback flow


async def test_full_loopback_flow_hands_the_token_over_exactly_once(
    api: respx.MockRouter,
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    complete = await harness.sign_in()
    assert complete.status == 303
    location = header_values(complete, "location")[0]
    parts = urlsplit(location)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == "http://127.0.0.1:8080/callback"
    query = parse_qs(parts.query)
    assert query["state"] == [STATE]
    assert "Max-Age=0" in header_values(complete, "set-cookie")[0]
    assert EXCHANGED_TOKEN not in location  # the token is never in the redirect

    grant = {"grant_type": "code", "code": code_from(location), "code_verifier": VERIFIER}
    first = await harness.post_json("/token", grant)
    assert first.status == 200 and token_of(first) == EXCHANGED_TOKEN
    assert error_of(await harness.post_json("/token", grant)) == "invalid_grant"


async def test_wrong_verifier_fails_and_spends_the_code(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    location = header_values(await harness.sign_in(), "location")[0]
    code = code_from(location)
    wrong = {"grant_type": "code", "code": code, "code_verifier": WRONG_VERIFIER}
    assert error_of(await harness.post_json("/token", wrong)) == "invalid_grant"
    right = {"grant_type": "code", "code": code, "code_verifier": VERIFIER}
    assert error_of(await harness.post_json("/token", right)) == "invalid_grant"


async def test_code_expires_after_five_minutes(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    location = header_values(await harness.sign_in(), "location")[0]
    harness.clock.now += CODE_TTL_MS / 1000 + 1
    grant = {"grant_type": "code", "code": code_from(location), "code_verifier": VERIFIER}
    assert error_of(await harness.post_json("/token", grant)) == "invalid_grant"


async def test_redirect_mode_returns_to_the_deep_link(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness(loopback=False, return_urls=(REDIRECT_URL,))
    query = {
        "mode": "redirect",
        "redirect_uri": REDIRECT_URL,
        "state": STATE,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
    }
    complete = await harness.sign_in(query=query)
    location = header_values(complete, "location")[0]
    assert location.startswith(f"{REDIRECT_URL}?")
    assert parse_qs(urlsplit(location).query)["state"] == [STATE]


async def test_cancel_reports_access_denied_and_never_hands_over_an_old_token(
    api: respx.MockRouter,
) -> None:
    exchange = api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    complete = await harness.sign_in(cancel=True, old_cookie="old_session_token_value")
    location = header_values(complete, "location")[0]
    query = parse_qs(urlsplit(location).query)
    assert query["error"] == ["access_denied"]
    assert "code" not in query
    assert "old_session_token_value" not in location
    assert exchange.call_count == 0


async def test_unknown_or_replayed_handoff_shows_the_expired_page(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    unknown = await harness.get("/complete", {"h": "nope"})
    assert unknown.status == 400 and b"expired" in unknown.body
    missing = await harness.get("/complete")
    assert missing.status == 400

    started = await harness.get("/start", harness.start_query())
    state = parse_qs(urlsplit(header_values(started, "location")[0]).query)["state"][0]
    callbacked = await harness.callback_route(
        request(f"{APP_ORIGIN}/enlitt/callback?state={state}&code=c")
    )
    complete_url = header_values(callbacked, "location")[0]
    cookie = header_values(callbacked, "set-cookie")[0].split(";")[0]
    first = await harness.handle(request(complete_url, headers={"cookie": cookie}))
    assert first.status == 303
    replay = await harness.handle(request(complete_url, headers={"cookie": cookie}))
    assert replay.status == 400


# ---------------------------------------------------------------------------- pairing


async def create_pairing(harness: Harness) -> dict[str, Any]:
    response = await harness.post_json(
        "/pairing", {"code_challenge": CHALLENGE, "code_challenge_method": "S256"}
    )
    assert response.status == 200, response.body
    return dict(json.loads(response.body))


def pair_post(
    harness: Harness, form: dict[str, str], *, cookie: str | None, origin: str | None = None
) -> Any:
    headers = {"content-type": "application/x-www-form-urlencoded"}
    if cookie is not None:
        headers["cookie"] = f"{CSRF_COOKIE_NAME}={cookie}"
    if origin is not None:
        headers["origin"] = origin
    return harness.handle(
        request(
            f"{APP_ORIGIN}{BASE}/pair",
            method="POST",
            headers=headers,
            body=urlencode(form).encode(),
        )
    )


async def csrf_for(harness: Harness) -> str:
    page = await harness.get("/pair")
    cookie = header_values(page, "set-cookie")[0]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=Strict" in cookie
    return cookie.split(";")[0].split("=", 1)[1]


async def test_pairing_returns_a_valid_body() -> None:
    harness = Harness(pairing=True)
    body = await create_pairing(harness)
    assert set(body) == {"pairing_id", "user_code", "verification_uri", "expires_in", "interval"}
    assert re.fullmatch(
        f"[{USER_CODE_ALPHABET}]{{4}}-[{USER_CODE_ALPHABET}]{{4}}", body["user_code"]
    )
    assert body["verification_uri"] == f"{APP_ORIGIN}{BASE}/pair"


@pytest.mark.parametrize(
    "bad",
    [
        {},
        {"code_challenge": CHALLENGE},
        {"code_challenge": "short", "code_challenge_method": "S256"},
        {"code_challenge": CHALLENGE, "code_challenge_method": "plain"},
        {"code_challenge": CHALLENGE, "code_challenge_method": "S256", "x": 1},
    ],
)
async def test_pairing_rejects_malformed_bodies(bad: dict[str, Any]) -> None:
    harness = Harness(pairing=True)
    assert error_of(await harness.post_json("/pairing", bad)) == "invalid_request"


async def test_pairing_routes_are_404_when_off() -> None:
    harness = Harness(pairing=False)
    assert (await harness.get("/pair")).status == 404
    body = {"code_challenge": CHALLENGE, "code_challenge_method": "S256"}
    assert (await harness.post_json("/pairing", body)).status == 404
    grant = {"grant_type": "pairing", "pairing_id": "x", "code_verifier": VERIFIER}
    assert error_of(await harness.post_json("/token", grant)) == "invalid_request"


async def test_pair_post_needs_matching_csrf_and_same_origin() -> None:
    harness = Harness(pairing=True)
    pairing = await create_pairing(harness)
    csrf = await csrf_for(harness)
    form = {"csrf": csrf, "user_code": pairing["user_code"]}
    assert (await pair_post(harness, form, cookie=None)).status == 403
    assert (await pair_post(harness, form, cookie="other")).status == 403
    assert (await pair_post(harness, {**form, "csrf": "wrong"}, cookie=csrf)).status == 403
    assert (await pair_post(harness, form, cookie=csrf, origin="https://evil.test")).status == 403
    assert (await pair_post(harness, form, cookie=csrf, origin=APP_ORIGIN)).status == 200


async def test_unknown_user_code_shows_the_form_again() -> None:
    harness = Harness(pairing=True)
    csrf = await csrf_for(harness)
    response = await pair_post(harness, {"csrf": csrf, "user_code": "BBBB-BBBB"}, cookie=csrf)
    assert response.status == 200
    assert b"not valid" in response.body and b'name="user_code"' in response.body


async def test_confirmation_page_shows_name_code_and_warning_escaped() -> None:
    harness = Harness(pairing=True, app_name="<script>alert(1)</script>")
    pairing = await create_pairing(harness)
    csrf = await csrf_for(harness)
    response = await pair_post(
        harness, {"csrf": csrf, "user_code": pairing["user_code"]}, cookie=csrf
    )
    page = response.body.decode()
    assert "<script>alert(1)</script>" not in page
    assert "&lt;script&gt;" in page
    assert pairing["user_code"] in page
    assert "Only continue if this code is on a screen in front of you" in page


async def test_pairing_flow_hands_the_token_over_once(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness(pairing=True)
    pairing = await create_pairing(harness)
    grant = {
        "grant_type": "pairing",
        "pairing_id": pairing["pairing_id"],
        "code_verifier": VERIFIER,
    }
    assert error_of(await harness.post_json("/token", grant)) == "authorization_pending"

    csrf = await csrf_for(harness)
    confirm = {
        "csrf": csrf,
        "user_code": pairing["user_code"],
        "action": "confirm",
        "decision": "continue",
    }
    started = await pair_post(harness, confirm, cookie=csrf)
    assert started.status == 303
    state = parse_qs(urlsplit(header_values(started, "location")[0]).query)["state"][0]
    callbacked = await harness.callback_route(
        request(f"{APP_ORIGIN}/enlitt/callback?state={state}&code=c")
    )
    cookie = header_values(callbacked, "set-cookie")[0].split(";")[0]
    done = await harness.handle(
        request(header_values(callbacked, "location")[0], headers={"cookie": cookie})
    )
    assert done.status == 200 and b"Signed in" in done.body
    assert EXCHANGED_TOKEN.encode() not in done.body

    wrong = {**grant, "code_verifier": WRONG_VERIFIER}
    assert error_of(await harness.post_json("/token", wrong)) == "invalid_grant"  # spent by try


async def test_pairing_token_returns_session_once_with_right_verifier(
    api: respx.MockRouter,
) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness(pairing=True)
    pairing = await create_pairing(harness)
    csrf = await csrf_for(harness)
    started = await pair_post(
        harness,
        {
            "csrf": csrf,
            "user_code": pairing["user_code"],
            "action": "confirm",
            "decision": "continue",
        },
        cookie=csrf,
    )
    state = parse_qs(urlsplit(header_values(started, "location")[0]).query)["state"][0]
    callbacked = await harness.callback_route(
        request(f"{APP_ORIGIN}/enlitt/callback?state={state}&code=c")
    )
    cookie = header_values(callbacked, "set-cookie")[0].split(";")[0]
    await harness.handle(
        request(header_values(callbacked, "location")[0], headers={"cookie": cookie})
    )
    grant = {
        "grant_type": "pairing",
        "pairing_id": pairing["pairing_id"],
        "code_verifier": VERIFIER,
    }
    assert token_of(await harness.post_json("/token", grant)) == EXCHANGED_TOKEN
    assert error_of(await harness.post_json("/token", grant)) == "invalid_grant"


async def test_pairing_cancel_gives_access_denied() -> None:
    harness = Harness(pairing=True)
    pairing = await create_pairing(harness)
    csrf = await csrf_for(harness)
    cancelled = await pair_post(
        harness,
        {
            "csrf": csrf,
            "user_code": pairing["user_code"],
            "action": "confirm",
            "decision": "cancel",
        },
        cookie=csrf,
    )
    assert cancelled.status == 200
    grant = {
        "grant_type": "pairing",
        "pairing_id": pairing["pairing_id"],
        "code_verifier": VERIFIER,
    }
    assert error_of(await harness.post_json("/token", grant)) == "access_denied"


# ----------------------------------------------------------------------------- logout


async def test_logout_revokes_the_header_token_and_answers_204(api: respx.MockRouter) -> None:
    revoke = api.post("/auth/oauth2/revoke").mock(return_value=httpx.Response(200, json={}))
    harness = Harness()
    response = await harness.handle(
        request(
            f"{APP_ORIGIN}{BASE}/logout",
            method="POST",
            headers={"enlitt-session": "tok_from_header"},
        )
    )
    assert response.status == 204
    assert parse_qs(revoke.calls.last.request.content.decode())["token"] == ["tok_from_header"]


async def test_failed_revocation_still_answers_204(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/revoke").mock(side_effect=httpx.ConnectError("down"))
    harness = Harness()
    response = await harness.handle(
        request(f"{APP_ORIGIN}{BASE}/logout", method="POST", headers={"enlitt-session": "tok"})
    )
    assert response.status == 204


# ----------------------------------------------------------------------------- secrecy


async def test_the_token_appears_only_in_the_token_response(api: respx.MockRouter) -> None:
    api.post("/auth/oauth2/token").mock(return_value=exchange_ok())
    harness = Harness()
    complete = await harness.sign_in()
    assert EXCHANGED_TOKEN not in str(complete.headers)
    assert EXCHANGED_TOKEN.encode() not in complete.body
    code = code_from(header_values(complete, "location")[0])
    bad = await harness.post_json(
        "/token", {"grant_type": "code", "code": code, "code_verifier": WRONG_VERIFIER}
    )
    assert EXCHANGED_TOKEN.encode() not in bad.body
    page = await harness.get("/complete", {"h": "nope"})
    assert EXCHANGED_TOKEN.encode() not in page.body


async def test_store_never_sees_the_token_outside_the_code_record(api: respx.MockRouter) -> None:
    """The handoff and state records written at start carry no token."""
    harness = Harness()
    await harness.get("/start", harness.start_query())
    values = [v for v, _ in harness.config.store._values.values()]  # type: ignore[attr-defined]
    assert values and all(EXCHANGED_TOKEN not in v for v in values)
