"""Group 3: transport behavior - headers, rate-limit schedule, refusals, base URL rules."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import respx

from _support import BASE_URL, SECRET, TOKEN
from conftest import FakeClock
from enlitt import (
    SDK_VERSION,
    EnlittConfigurationError,
    EnlittError,
    EnlittLoginRequiredError,
    EnlittOptions,
    EnlittRateLimitError,
    EnlittRateLimitRetryOptions,
    _transport,
    enlitt_session,
)

RATE_LIMITED = {
    "error": {
        "message": "slow",
        "type": "rate_limit_error",
        "param": None,
        "code": "rate_limit_exceeded",
    }
}
TOLERATED = {"host", "content-length", "accept-encoding", "connection", "user-agent"}


def make_client(**rate: object) -> _transport.InternalEnlittClient:
    return _transport.create_internal_client(
        EnlittOptions(
            session=enlitt_session(TOKEN),
            rate_limit=EnlittRateLimitRetryOptions(**rate) if rate else None,  # type: ignore[arg-type]
        )
    )


async def test_post_carries_exactly_the_documented_header_set(api: respx.MockRouter) -> None:
    route = api.post("/v1/responses").mock(return_value=httpx.Response(200, json={}))
    response = await _transport.request_enlitt(
        make_client(), path="/v1/responses", body={"a": 1}, call_id="call-id-0123456789"
    )
    await response.aclose()
    request = route.calls.last.request
    headers = {k.lower(): v for k, v in request.headers.items() if k.lower() not in TOLERATED}
    assert headers.pop("x-request-id").startswith("req_")
    assert headers == {
        "authorization": f"Bearer {SECRET}",
        "x-enlitt-user-authorization": f"Bearer {TOKEN}",
        "accept": "application/json",
        "content-type": "application/json",
        "enlitt-version": "2026-10-05",
        "x-enlitt-sdk-version": f"enlitt-python/{SDK_VERSION}",
        "idempotency-key": "call-id-0123456789",
    }
    assert json.loads(request.content) == {"a": 1}


async def test_get_omits_idempotency_key_and_content_type(api: respx.MockRouter) -> None:
    route = api.get("/v1/enlitt/usage").mock(return_value=httpx.Response(200, json={}))
    response = await _transport.request_enlitt(make_client(), path="/v1/enlitt/usage", method="GET")
    await response.aclose()
    names = {k.lower() for k in route.calls.last.request.headers}
    assert "idempotency-key" not in names
    assert "content-type" not in names


async def test_rate_limit_waits_floor_plus_jitter_then_succeeds(
    api: respx.MockRouter, clock: FakeClock
) -> None:
    api.post("/v1/responses").mock(
        side_effect=[
            httpx.Response(429, json=RATE_LIMITED, headers={"retry-after": "2"}),
            httpx.Response(429, json=RATE_LIMITED),
            httpx.Response(200, json={}),
        ]
    )
    seen: list[tuple[int, float]] = []
    client = make_client(on_rate_limit=lambda attempt, delay: seen.append((attempt, delay)))
    response = await _transport.request_enlitt(client, path="/v1/responses", body={})
    await response.aclose()
    # The fake uniform returns its upper bound: floor + floor/2.
    assert seen == [(1, 3000.0), (2, 1500.0)]
    assert clock.sleeps == [3.0, 1.5]


async def test_rate_limit_stops_at_max_attempts(api: respx.MockRouter, clock: FakeClock) -> None:
    route = api.post("/v1/responses").mock(return_value=httpx.Response(429, json=RATE_LIMITED))
    with pytest.raises(EnlittRateLimitError):
        await _transport.request_enlitt(make_client(max_attempts=2), path="/v1/responses", body={})
    assert route.call_count == 2
    assert len(clock.sleeps) == 1


async def test_rate_limit_stops_at_total_wait_budget(
    api: respx.MockRouter, clock: FakeClock
) -> None:
    route = api.post("/v1/responses").mock(return_value=httpx.Response(429, json=RATE_LIMITED))
    client = make_client(max_attempts=10, max_total_wait_ms=2000)
    with pytest.raises(EnlittRateLimitError):
        await _transport.request_enlitt(client, path="/v1/responses", body={})
    # The first wait (1500 ms) fits the 2000 ms budget; a second would reach 3000 ms.
    assert route.call_count == 2
    assert clock.sleeps == [1.5]


async def test_max_attempts_one_never_waits(api: respx.MockRouter, clock: FakeClock) -> None:
    api.post("/v1/responses").mock(return_value=httpx.Response(429, json=RATE_LIMITED))
    with pytest.raises(EnlittRateLimitError):
        await _transport.request_enlitt(make_client(max_attempts=1), path="/v1/responses", body={})
    assert clock.sleeps == []


async def test_cancellation_ends_the_rate_limit_wait(api: respx.MockRouter) -> None:
    api.post("/v1/responses").mock(return_value=httpx.Response(429, json=RATE_LIMITED))
    gate = asyncio.Event()

    async def blocked_sleep(seconds: float) -> None:
        gate.set()
        await asyncio.sleep(3600)

    _transport.runtime.sleep = blocked_sleep  # restored by the clock fixture's monkeypatch
    task = asyncio.create_task(
        _transport.request_enlitt(make_client(), path="/v1/responses", body={})
    )
    await gate.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "invalid_value"),
        (401, "invalid_api_key"),
        (500, "server_error"),
        (503, "provider_error"),
        (409, "operation_in_progress"),
    ],
)
async def test_other_codes_are_never_retried(
    api: respx.MockRouter, clock: FakeClock, status: int, code: str
) -> None:
    body = {
        "error": {"message": "no", "type": "invalid_request_error", "param": None, "code": code}
    }
    route = api.post("/v1/responses").mock(return_value=httpx.Response(status, json=body))
    with pytest.raises(EnlittError):
        await _transport.request_enlitt(make_client(), path="/v1/responses", body={})
    assert route.call_count == 1
    assert clock.sleeps == []


async def test_redirect_is_transport_failed_and_not_followed(api: respx.MockRouter) -> None:
    route = api.post("/v1/responses").mock(
        return_value=httpx.Response(302, headers={"location": "https://evil.test/"})
    )
    with pytest.raises(EnlittError) as caught:
        await _transport.request_enlitt(make_client(), path="/v1/responses", body={})
    assert caught.value.code == "transport_failed"
    assert route.call_count == 1


async def test_network_failure_is_transport_failed(api: respx.MockRouter) -> None:
    api.post("/v1/responses").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(EnlittError) as caught:
        await _transport.request_enlitt(make_client(), path="/v1/responses", body={})
    assert caught.value.code == "transport_failed"


async def test_signed_out_session_raises_login_required_before_any_request(
    api: respx.MockRouter,
) -> None:
    client = _transport.create_internal_client(EnlittOptions())
    from enlitt import run_with_enlitt_session

    async def body() -> None:
        await _transport.request_enlitt(client, path="/v1/responses", body={})

    with pytest.raises(EnlittLoginRequiredError):
        await run_with_enlitt_session(None, body)
    assert api.calls.call_count == 0


async def test_no_ambient_context_is_a_configuration_error(api: respx.MockRouter) -> None:
    client = _transport.create_internal_client(EnlittOptions())
    with pytest.raises(EnlittConfigurationError):
        await _transport.request_enlitt(client, path="/v1/responses", body={})
    assert api.calls.call_count == 0


def test_missing_secret_fails_at_construction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENLITT_SECRET_KEY")
    with pytest.raises(EnlittConfigurationError):
        _transport.create_internal_client(EnlittOptions())


@pytest.mark.parametrize(
    "url",
    [
        "http://api.enlitt.com",
        "ftp://x.test",
        "https://u:p@x.test",
        "https://x.test/?q=1",
        "https://x.test/#f",
        "not a url",
        "https://",
    ],
)
def test_bad_base_urls_are_refused(url: str) -> None:
    with pytest.raises(EnlittConfigurationError):
        _transport.resolve_base_url(url)


@pytest.mark.parametrize(
    "url", ["https://x.test", "http://localhost:8787", "http://127.0.0.1:1", "http://[::1]:9"]
)
def test_https_and_loopback_http_are_allowed(url: str) -> None:
    assert _transport.resolve_base_url(url) == url


def test_base_url_falls_back_to_environment_then_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert _transport.resolve_base_url(None) == BASE_URL
    monkeypatch.delenv("ENLITT_BASE_URL")
    assert _transport.resolve_base_url(None) == _transport.DEFAULT_BASE_URL


@pytest.mark.parametrize("bad", [0, -1, True, 1.5])
def test_invalid_max_attempts_are_refused(bad: object) -> None:
    with pytest.raises(EnlittConfigurationError):
        make_client(max_attempts=bad)


def test_client_repr_never_shows_the_secret() -> None:
    assert SECRET not in repr(make_client())


@pytest.mark.parametrize("key", ["", "short", "x" * 300, "has space in it 0123456"])
def test_bad_idempotency_keys_are_refused(key: str) -> None:
    with pytest.raises(EnlittConfigurationError):
        _transport.validate_idempotency_key(key)


def test_generated_call_ids_are_valid_and_distinct() -> None:
    ids = {_transport.generate_call_id() for _ in range(50)}
    assert len(ids) == 50
    for value in ids:
        _transport.validate_idempotency_key(value)
