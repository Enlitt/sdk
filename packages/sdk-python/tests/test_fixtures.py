"""Group 2: the shared protocol fixtures (``packages/protocol/fixtures``)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import respx

from _support import TOKEN, canonical, load_fixtures, sse_body
from enlitt import (
    EnlittAuthenticationError,
    EnlittAuthorizationError,
    EnlittError,
    EnlittInsufficientCreditsError,
    EnlittLimitExceededError,
    EnlittLoginRequiredError,
    EnlittOptions,
    EnlittRateLimitError,
    EnlittRateLimitRetryOptions,
    EnlittSubscriptionInactiveError,
    _parse,
    _transport,
    enlitt_session,
)
from enlitt._sse import iter_sse_events
from enlitt.openai import map_standard_stream
from enlitt.premium import (
    PremiumChargeRequest,
    PremiumProvider,
    build_begin_body,
    build_report_body,
)

CLASSES: dict[str, type[EnlittError]] = {
    "authentication": EnlittAuthenticationError,
    "authorization": EnlittAuthorizationError,
    "generic": EnlittError,
    "insufficient_credits": EnlittInsufficientCreditsError,
    "limit_exceeded": EnlittLimitExceededError,
    "login_required": EnlittLoginRequiredError,
    "rate_limit": EnlittRateLimitError,
    "subscription_inactive": EnlittSubscriptionInactiveError,
}


# ------------------------------------------------------------------------------ errors/


@pytest.mark.parametrize(("name", "fixture"), load_fixtures("errors"), ids=lambda v: str(v)[:60])
async def test_error_fixture(name: str, fixture: dict[str, Any], api: respx.MockRouter) -> None:
    body = fixture["body"]
    content = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    api.post("/v1/responses").mock(
        return_value=httpx.Response(
            fixture["http_status"], content=content, headers=fixture.get("headers", {})
        )
    )
    client = _transport.create_internal_client(
        EnlittOptions(
            session=enlitt_session(TOKEN),
            rate_limit=EnlittRateLimitRetryOptions(max_attempts=1),
        )
    )
    with pytest.raises(EnlittError) as caught:
        await _transport.request_enlitt(client, path="/v1/responses", body={})
    error, expected = caught.value, fixture["expected"]
    assert type(error) is CLASSES[expected["class"]], name
    assert error.code == expected["code"], name
    assert error.retryable is expected["retryable"], name
    assert error.provider_invoked is False
    if "retry_after_ms" in expected:
        assert error.retry_after_ms == expected["retry_after_ms"], name
    if "authorize_url" in expected:
        assert error.authorize_url == expected["authorize_url"], name
    if "limit_rule" in expected:
        assert isinstance(error, EnlittLimitExceededError)
        assert error.limit_rule == expected["limit_rule"], name
    if "admissible_max_charge_nano_usd" in expected:
        assert isinstance(error, EnlittInsufficientCreditsError)
        assert error.admissible_max_charge_nano_usd == expected["admissible_max_charge_nano_usd"]
    if "message" in expected:
        assert str(error) == expected["message"], name


# ---------------------------------------------------------------------------- responses/

PARSERS = {
    "create-response": _parse.parse_create_response,
    "begin-operation": _parse.parse_begin_response,
    "report-terminal": _parse.parse_terminal_response,
    "usage": _parse.parse_usage_response,
}


@pytest.mark.parametrize(
    ("name", "fixture"),
    [f for f in load_fixtures("responses") if f[1]["endpoint"] in PARSERS],
    ids=lambda v: str(v)[:60],
)
def test_response_fixture(name: str, fixture: dict[str, Any]) -> None:
    parsed = PARSERS[fixture["endpoint"]](fixture["body"], "")
    expected = fixture.get("expected_tolerant", fixture["body"])
    assert canonical(parsed) == canonical(expected), name


# ----------------------------------------------------------------------------- streams/


def render(events: list[dict[str, Any]]) -> bytes:
    return sse_body([(e["event"], e["data"]) for e in events])


async def chunks(raw: bytes, size: int) -> AsyncIterator[bytes]:
    for start in range(0, len(raw), size):
        yield raw[start : start + size]


async def run_stream(raw: bytes, size: int) -> dict[str, Any]:
    """Frame, map and summarize one stream the way the fixture's ``expected`` does."""
    outcome: dict[str, Any] = {}
    text: list[str] = []
    calls: list[dict[str, str]] = []
    names: dict[str, dict[str, str]] = {}
    try:
        async for event in map_standard_stream(iter_sse_events(chunks(raw, size))):
            kind = event.get("type")
            if kind == "response.output_text.delta":
                text.append(event["delta"])
            if (
                kind == "response.output_item.added"
                and event["item"].get("type") == "function_call"
            ):
                item = event["item"]
                names[item["id"]] = {"call_id": item["call_id"], "name": item["name"]}
            if kind == "response.function_call_arguments.done":
                calls.append({**names[event["item_id"]], "arguments": event["arguments"]})
            if kind in ("response.completed", "response.incomplete", "response.failed"):
                response = event["response"]
                outcome["outcome"] = {
                    "response.completed": "completed",
                    "response.incomplete": "incomplete",
                    "response.failed": "failed",
                }[kind]
                outcome["response"] = response
    except EnlittError as error:
        return {"outcome": "invalid", "error_code": error.code}
    response = outcome["response"]
    out: dict[str, Any] = {"outcome": outcome["outcome"]}
    if outcome["outcome"] == "failed":
        out["finish_reason"] = "error"
    elif outcome["outcome"] == "incomplete":
        out["finish_reason"] = "length"
    else:
        out["finish_reason"] = "tool-calls" if calls else "stop"
    if text and "".join(text):
        out["output_text"] = "".join(text)
    if calls:
        out["function_calls"] = calls
    assert response is not None
    return out


@pytest.mark.parametrize("size", [1_000_000, 1], ids=["whole", "one-byte"])
@pytest.mark.parametrize(("name", "fixture"), load_fixtures("streams"), ids=lambda v: str(v)[:60])
async def test_stream_fixture(name: str, fixture: dict[str, Any], size: int) -> None:
    result = await run_stream(render(fixture["events"]), size)
    expected = fixture["expected"]
    for key, value in expected.items():
        assert result.get(key) == value, f"{name}: {key} was {result.get(key)!r}"


# ---------------------------------------------------------------------------- requests/

BODY_BUILDERS = {
    "begin-operation": lambda body: build_begin_body(
        PremiumChargeRequest(
            max_charge=body["max_charge_nano_usd"],
            provider=PremiumProvider(**body["provider"]),
        )
    ),
    "report-terminal": lambda body: build_report_body(
        body["report_id"], body["status"], body["charge_nano_usd"], None
    ),
}


@pytest.mark.parametrize(
    ("name", "fixture"),
    [f for f in load_fixtures("requests") if f[1]["valid"] and f[1]["endpoint"] in BODY_BUILDERS],
    ids=lambda v: str(v)[:60],
)
def test_valid_wire_request_fixture_is_rebuilt_byte_for_byte(
    name: str, fixture: dict[str, Any]
) -> None:
    built = BODY_BUILDERS[fixture["endpoint"]](fixture["body"])
    assert canonical(built) == canonical(fixture["body"]), name


def test_every_valid_request_fixture_is_covered() -> None:
    """A new valid fixture must be wired to a builder here or in test_openai.py."""
    covered = set(BODY_BUILDERS) | {"create-response"}
    for name, fixture in load_fixtures("requests"):
        if fixture["valid"]:
            assert fixture["endpoint"] in covered, f"{name} has no test"
