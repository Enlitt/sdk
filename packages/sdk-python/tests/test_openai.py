"""Group 5: the OpenAI adapter - mapping, refusals, results, streams, premium accounting."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
import respx

from _support import TOKEN, canonical, load_fixtures, sse_body
from enlitt import (
    EnlittConfigurationError,
    EnlittError,
    EnlittInsufficientCreditsError,
    EnlittOptions,
    enlitt_session,
)
from enlitt.openai import (
    EnlittCallOptions,
    OpenAIPremiumPriceContext,
    enlitt,
    per_token,
)

OP_ID = "op_adapter_1"
TERMINAL_PATH = f"/v1/enlitt/operations/{OP_ID}/terminal"
SETTLED = dict(load_fixtures("responses"))["report-terminal--settled"]["body"]
COMPLETED = dict(load_fixtures("responses"))["create-response--completed"]["body"]
STREAMS = dict(load_fixtures("streams"))
OPTIONS = EnlittOptions(session=enlitt_session(TOKEN))


def standard_client() -> Any:
    return enlitt(None, OPTIONS)


# ------------------------------------------------------------------------ request mapping

IMAGE_INPUT = [
    {
        "role": "user",
        "content": [
            {"type": "input_text", "text": "Describe this image."},
            {"type": "input_image", "image_url": "https://example.com/image.png"},
        ],
    }
]
TOOL_INPUT = [
    {"role": "user", "content": "What is the weather?"},
    {
        "type": "function_call",
        "call_id": "call_weather",
        "name": "weather",
        "arguments": '{"city":"Boston"}',
    },
    {"type": "function_call_output", "call_id": "call_weather", "output": "Sunny"},
]
WEATHER_TOOL = {
    "type": "function",
    "name": "weather",
    "description": "Gets the weather.",
    "parameters": {"type": "object"},
}

# OpenAI-shaped arguments that must map onto each valid create-response fixture.
VALID_SCENARIOS: dict[str, dict[str, Any]] = {
    "create-response--text": {"input": "Hello"},
    "create-response--image-input": {"input": IMAGE_INPUT},
    "create-response--tools-and-results": {"input": TOOL_INPUT, "tools": [WEATHER_TOOL]},
}
# Arguments that attempt what each invalid fixture forbids.
INVALID_SCENARIOS: dict[str, dict[str, Any]] = {
    "create-response--unknown-field": {"input": "Hello", "future_field": True},
    "create-response--unsupported-structured-output": {
        "input": "Hello",
        "text": {"format": {"type": "json_schema"}},
    },
    "create-response--unsupported-tool-choice": {"input": "Hello", "tool_choice": "required"},
}


def test_every_create_response_fixture_has_a_scenario() -> None:
    for name, fixture in load_fixtures("requests"):
        if fixture["endpoint"] != "create-response":
            continue
        table = VALID_SCENARIOS if fixture["valid"] else INVALID_SCENARIOS
        assert name in table, f"{name} has no scenario in test_openai.py"


@pytest.mark.parametrize(
    ("name", "fixture"),
    [
        f
        for f in load_fixtures("requests")
        if f[1]["endpoint"] == "create-response" and f[1]["valid"]
    ],
)
async def test_valid_fixture_is_what_the_adapter_sends(
    name: str, fixture: dict[str, Any], api: respx.MockRouter
) -> None:
    route = api.post("/v1/responses").mock(return_value=httpx.Response(200, json=COMPLETED))
    await standard_client().responses.create(model="enlitt-standard", **VALID_SCENARIOS[name])
    sent = route.calls.last.request
    assert canonical(json.loads(sent.content)) == canonical(fixture["body"]), name
    assert sent.headers["accept"] == "application/json"
    assert len(sent.headers["idempotency-key"]) >= 16


@pytest.mark.parametrize(
    ("name", "fixture"),
    [
        f
        for f in load_fixtures("requests")
        if f[1]["endpoint"] == "create-response" and not f[1]["valid"]
    ],
)
async def test_invalid_fixture_is_refused_before_any_request(
    name: str, fixture: dict[str, Any], api: respx.MockRouter
) -> None:
    with pytest.raises(EnlittConfigurationError):
        await standard_client().responses.create(model="enlitt-standard", **INVALID_SCENARIOS[name])
    assert api.calls.call_count == 0


@pytest.mark.parametrize(
    "extra",
    [
        {"background": True},
        {"previous_response_id": "resp_1"},
        {"temperature": 0.2},
        {"reasoning": {"effort": "low"}},
        {"store": True},
        {"input": [{"type": "input_file", "file_id": "f"}]},
        {
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "input_image", "image_url": "http://x/y.png"}],
                }
            ]
        },
        {"input": [{"role": "user", "content": [{"type": "input_image", "file_id": "f"}]}]},
        {"tools": [{"type": "web_search"}]},
        {"tools": [{**WEATHER_TOOL, "strict": True}]},
        {"max_output_tokens": 0},
        {"metadata": {"enlitt_x": "1"}},
    ],
)
async def test_unsupported_standard_features_are_refused_before_any_request(
    extra: dict[str, Any], api: respx.MockRouter
) -> None:
    arguments: dict[str, Any] = {"model": "enlitt-standard", "input": "Hi", **extra}
    with pytest.raises(EnlittConfigurationError):
        await standard_client().responses.create(**arguments)
    assert api.calls.call_count == 0


@pytest.mark.parametrize(
    "options",
    [
        EnlittCallOptions(max_charge="5"),
        EnlittCallOptions(price="5"),
        EnlittCallOptions(reporting_deadline_ms=1000),
        EnlittCallOptions(idempotency_key="short"),
    ],
)
async def test_premium_only_options_are_refused_in_standard_mode(
    options: EnlittCallOptions, api: respx.MockRouter
) -> None:
    with pytest.raises(EnlittConfigurationError):
        await standard_client().responses.create(
            model="enlitt-standard", input="Hi", enlitt=options
        )
    assert api.calls.call_count == 0


async def test_model_and_timeout_are_validated_locally(api: respx.MockRouter) -> None:
    client = standard_client()
    with pytest.raises(EnlittConfigurationError):
        await client.responses.create(input="Hi")
    for bad in (0, -1, True, "5"):
        with pytest.raises(EnlittConfigurationError):
            await client.responses.create(model="enlitt-standard", input="Hi", timeout=bad)
    assert api.calls.call_count == 0


async def test_a_new_call_id_is_used_per_invocation_and_can_be_pinned(
    api: respx.MockRouter,
) -> None:
    route = api.post("/v1/responses").mock(return_value=httpx.Response(200, json=COMPLETED))
    client = standard_client()
    await client.responses.create(model="enlitt-standard", input="a")
    await client.responses.create(model="enlitt-standard", input="a")
    await client.responses.create(
        model="enlitt-standard",
        input="a",
        enlitt=EnlittCallOptions(idempotency_key="pinned-call-id-0001", metadata={"k": "v"}),
    )
    keys = [c.request.headers["idempotency-key"] for c in route.calls]
    assert keys[0] != keys[1] and keys[2] == "pinned-call-id-0001"
    assert json.loads(route.calls[2].request.content)["metadata"] == {"k": "v"}


async def test_instructions_system_and_assistant_messages_map() -> None:
    from enlitt.openai import build_standard_request

    body = build_standard_request(
        {
            "model": "enlitt-standard",
            "instructions": "Be brief.",
            "input": [
                {"role": "developer", "content": [{"type": "input_text", "text": "dev"}]},
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": [{"type": "output_text", "text": "a"}]},
            ],
            "max_output_tokens": 50,
            "metadata": {"a": "1"},
        },
        stream=True,
        extra_metadata={"b": "2"},
    )
    assert body == {
        "model": "enlitt-standard",
        "messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "system", "content": "dev"},
            {"role": "user", "content": [{"type": "text", "text": "q"}]},
            {"role": "assistant", "content": "a"},
        ],
        "max_output_tokens": 50,
        "metadata": {"a": "1", "b": "2"},
        "stream": True,
    }


# ------------------------------------------------------------------- construction and refusals


def test_a_synchronous_openai_client_is_refused() -> None:
    with pytest.raises(EnlittConfigurationError):
        enlitt(openai.OpenAI(api_key="sk-test-unused"), OPTIONS)  # type: ignore[arg-type]


def test_a_client_without_responses_create_is_refused() -> None:
    with pytest.raises(EnlittConfigurationError):
        enlitt(SimpleNamespace(), OPTIONS)  # type: ignore[arg-type]


def test_options_may_be_the_only_argument() -> None:
    assert repr(enlitt(OPTIONS)) == "EnlittOpenAI()"  # type: ignore[arg-type]


def test_an_async_openai_client_is_accepted() -> None:
    enlitt(openai.AsyncOpenAI(api_key="sk-test-unused"), OPTIONS)


async def test_a_standard_only_client_refuses_premium_models(api: respx.MockRouter) -> None:
    with pytest.raises(EnlittConfigurationError):
        await standard_client().responses.create(
            model="gpt-5", input="Hi", enlitt=EnlittCallOptions(price="5")
        )
    assert api.calls.call_count == 0


# -------------------------------------------------------------------------- standard results


async def test_standard_non_stream_result_is_an_openai_response(api: respx.MockRouter) -> None:
    api.post("/v1/responses").mock(return_value=httpx.Response(200, json=COMPLETED))
    result = await standard_client().responses.create(model="enlitt-standard", input="Hi")
    assert isinstance(result, openai.types.responses.Response)
    assert (result.id, result.status, result.model) == (
        "resp_fixture_1",
        "completed",
        "enlitt-standard",
    )
    assert result.output_text == "Hello"


async def test_standard_errors_are_enlitt_errors(api: respx.MockRouter) -> None:
    api.post("/v1/responses").mock(
        return_value=httpx.Response(
            402,
            json={
                "error": {
                    "message": "none left",
                    "type": "insufficient_quota",
                    "param": None,
                    "code": "standard_balance_exhausted",
                }
            },
        )
    )
    with pytest.raises(EnlittInsufficientCreditsError) as caught:
        await standard_client().responses.create(model="enlitt-standard", input="Hi")
    assert caught.value.provider_invoked is False


async def test_standard_timeout_is_transport_failed(api: respx.MockRouter) -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(3600)
        return httpx.Response(200, json=COMPLETED)

    api.post("/v1/responses").mock(side_effect=slow)
    with pytest.raises(EnlittError) as caught:
        await standard_client().responses.create(model="enlitt-standard", input="Hi", timeout=0.05)
    assert caught.value.code == "transport_failed"


def stream_response(name: str) -> httpx.Response:
    events = [(e["event"], e["data"]) for e in STREAMS[name]["events"]]
    return httpx.Response(
        200, content=sse_body(events), headers={"content-type": "text/event-stream"}
    )


async def test_standard_stream_yields_openai_events_ending_in_one_terminal(
    api: respx.MockRouter,
) -> None:
    route = api.post("/v1/responses").mock(
        return_value=stream_response("create-response--text-deltas")
    )
    stream = await standard_client().responses.create(
        model="enlitt-standard", input="Hi", stream=True
    )
    types: list[str] = []
    text = ""
    async with stream:
        async for event in stream:
            types.append(event.type)
            if event.type == "response.output_text.delta":
                text += event.delta
    assert text == "Hello"
    assert types[0] == "response.created" and types[-1] == "response.completed"
    assert sum(t.startswith("response.completed") for t in types) == 1
    sent = route.calls.last.request
    assert sent.headers["accept"] == "text/event-stream"
    assert json.loads(sent.content)["stream"] is True


async def test_standard_stream_function_call_events(api: respx.MockRouter) -> None:
    api.post("/v1/responses").mock(return_value=stream_response("create-response--function-call"))
    stream = await standard_client().responses.create(
        model="enlitt-standard", input="Hi", stream=True
    )
    done = [e async for e in stream if e.type == "response.function_call_arguments.done"]
    assert len(done) == 1
    assert done[0].arguments == '{"city":"Boston"}'
    assert done[0].name == "weather"


@pytest.mark.parametrize(
    "name", ["create-response--sequence-gap", "create-response--missing-terminal"]
)
async def test_invalid_standard_streams_raise_malformed_response(
    name: str, api: respx.MockRouter
) -> None:
    api.post("/v1/responses").mock(return_value=stream_response(name))
    stream = await standard_client().responses.create(
        model="enlitt-standard", input="Hi", stream=True
    )
    with pytest.raises(EnlittError) as caught:
        async for _ in stream:
            pass
    assert caught.value.code == "malformed_response"


# ---------------------------------------------------------------------------- price helpers


def context(usage: Any) -> OpenAIPremiumPriceContext:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    return OpenAIPremiumPriceContext(
        status="completed",
        started_at=now,
        ended_at=now,
        duration_ms=1,
        effective_max_charge_nano_usd="9",
        usage=usage,
    )


def test_per_token_multiplies_each_rate_by_its_count() -> None:
    price = per_token("3", "5")
    assert price(context(SimpleNamespace(input_tokens=10, output_tokens=20))) == "130"
    assert price(context(None)) == "0"
    assert price(context(SimpleNamespace(input_tokens=True, output_tokens=-1))) == "0"


def test_per_token_rates_are_validated() -> None:
    for bad in ("-1", "1.5", ""):
        with pytest.raises(EnlittConfigurationError):
            per_token(bad, "1")


def test_per_token_is_exact_above_two_to_the_63() -> None:
    big = str(2**63)
    price = per_token(big, "0")
    assert price(context(SimpleNamespace(input_tokens=3, output_tokens=0))) == str(3 * 2**63)


# ---------------------------------------------------------------------------------- premium


class Provider:
    """A stand-in for ``AsyncOpenAI`` that records the arguments it receives."""

    def __init__(self, result: Any = None, error: BaseException | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result
        self.error = error
        self.responses = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.result


class FakeStream:
    """A provider stream that replays ``events`` and then optionally raises."""

    def __init__(self, events: list[Any], error: BaseException | None = None) -> None:
        self._events = list(events)
        self._error = error
        self.closed = False

    def __aiter__(self) -> AsyncIterator[Any]:
        return self

    async def __anext__(self) -> Any:
        if self._events:
            return self._events.pop(0)
        if self._error is not None:
            raise self._error
        raise StopAsyncIteration

    async def aclose(self) -> None:
        self.closed = True


def provider_response(status: str = "completed", **extra: Any) -> Any:
    usage = SimpleNamespace(
        input_tokens=10,
        output_tokens=20,
        input_tokens_details=SimpleNamespace(cached_tokens=4),
        output_tokens_details=SimpleNamespace(reasoning_tokens=2),
    )
    return SimpleNamespace(id="resp_provider_1", status=status, usage=usage, output=[], **extra)


def stub_premium(
    api: respx.MockRouter, effective_max: str = "1000"
) -> tuple[respx.Route, respx.Route]:
    begin = api.post("/v1/enlitt/operations").mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": OP_ID,
                "billing": "premium",
                "report_terminal": True,
                "effective_max_charge_nano_usd": effective_max,
                "reserved_nano_usd": effective_max,
                "terminal_deadline": "2026-10-28T12:00:00Z",
            },
        )
    )
    report = api.post(TERMINAL_PATH).mock(return_value=httpx.Response(200, json=SETTLED))
    return begin, report


def premium_client(provider: Provider) -> Any:
    return enlitt(provider, OPTIONS)  # type: ignore[arg-type]


def the_report(route: respx.Route) -> dict[str, Any]:
    assert route.call_count == 1, "expected exactly one terminal report"
    return json.loads(route.calls.last.request.content)  # type: ignore[no-any-return]


async def test_premium_passes_the_provider_result_through_by_identity(
    api: respx.MockRouter,
) -> None:
    begin, report = stub_premium(api)
    result = provider_response()
    provider = Provider(result)
    returned = await premium_client(provider).responses.create(
        model="gpt-5",
        input="Hi",
        temperature=0.2,
        timeout=12,
        enlitt=EnlittCallOptions(price="700", idempotency_key="premium-call-id-0001"),
    )
    assert returned is result
    # The provider got its own arguments, and never the Enlitt options.
    assert provider.calls == [
        {"model": "gpt-5", "input": "Hi", "temperature": 0.2, "timeout": 12.0}
    ]
    sent = begin.calls.last.request
    assert json.loads(sent.content) == {
        "mode": "premium",
        "max_charge_nano_usd": "700",
        "provider": {"id": "openai", "model": "gpt-5"},
    }
    assert sent.headers["idempotency-key"] == "premium-call-id-0001"
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"]) == ("completed", "700")
    assert body["usage"] == {
        "input_tokens": 10,
        "output_tokens": 20,
        "cached_input_tokens": 4,
        "reasoning_tokens": 2,
    }
    assert body["provider_response_id"] == "resp_provider_1"
    assert body["finish_reason"] == "stop"


async def test_premium_price_function_runs_once_and_is_clamped(api: respx.MockRouter) -> None:
    _, report = stub_premium(api, effective_max="500")
    seen: list[OpenAIPremiumPriceContext] = []

    def price(ctx: OpenAIPremiumPriceContext) -> str:
        seen.append(ctx)
        return per_token("30", "30")(ctx)  # 900, above the 500 ceiling

    await premium_client(Provider(provider_response())).responses.create(
        model="gpt-5", input="Hi", enlitt=EnlittCallOptions(max_charge="500", price=price)
    )
    assert len(seen) == 1 and seen[0].status == "completed"
    assert seen[0].response is not None and seen[0].events is None
    assert the_report(report)["charge_nano_usd"] == "500"


async def test_async_price_function_is_awaited(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)

    async def price(ctx: OpenAIPremiumPriceContext) -> str:
        return "42"

    await premium_client(Provider(provider_response())).responses.create(
        model="gpt-5", input="Hi", enlitt=EnlittCallOptions(max_charge="100", price=price)
    )
    assert the_report(report)["charge_nano_usd"] == "42"


async def test_a_failing_price_function_charges_zero_and_reports_to_the_hook(
    api: respx.MockRouter,
) -> None:
    _, report = stub_premium(api)
    errors: list[EnlittError] = []

    def price(ctx: OpenAIPremiumPriceContext) -> str:
        raise RuntimeError("bug in business code")

    client = enlitt(
        Provider(provider_response()),  # type: ignore[arg-type]
        EnlittOptions(session=enlitt_session(TOKEN), on_terminal_report_error=errors.append),
    )
    await client.responses.create(
        model="gpt-5", input="Hi", enlitt=EnlittCallOptions(max_charge="100", price=price)
    )
    assert the_report(report)["charge_nano_usd"] == "0"
    assert [type(e) for e in errors] == [EnlittConfigurationError]


async def test_no_price_charges_zero(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)
    await premium_client(Provider(provider_response())).responses.create(
        model="gpt-5", input="Hi", enlitt=EnlittCallOptions(max_charge="100")
    )
    assert the_report(report)["charge_nano_usd"] == "0"


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("failed", "failed"),
        ("cancelled", "canceled"),
        ("incomplete", "completed"),
        ("completed", "completed"),
    ],
)
async def test_resolved_response_status_decides_the_report_status(
    api: respx.MockRouter, status: str, expected: str
) -> None:
    _, report = stub_premium(api)
    await premium_client(Provider(provider_response(status))).responses.create(
        model="gpt-5", input="Hi", enlitt=EnlittCallOptions(price="10")
    )
    body = the_report(report)
    assert body["status"] == expected
    assert body["charge_nano_usd"] == ("0" if expected == "failed" else "10")


async def test_provider_exception_is_reported_failed_zero_and_reraised(
    api: respx.MockRouter,
) -> None:
    _, report = stub_premium(api)
    failure = openai.APITimeoutError(request=httpx.Request("POST", "https://api.openai.test/"))
    with pytest.raises(openai.APITimeoutError):
        await premium_client(Provider(error=failure)).responses.create(
            model="gpt-5", input="Hi", enlitt=EnlittCallOptions(price="10")
        )
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"], body["error_category"]) == (
        "failed",
        "0",
        "timeout",
    )


async def test_cancellation_is_reported_canceled_and_reraised(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)
    started = asyncio.Event()

    class Hanging(Provider):
        async def _create(self, **kwargs: Any) -> Any:
            started.set()
            await asyncio.sleep(3600)

    task = asyncio.create_task(
        premium_client(Hanging()).responses.create(
            model="gpt-5", input="Hi", enlitt=EnlittCallOptions(price="10")
        )
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert the_report(report)["status"] == "canceled"


@pytest.mark.parametrize(
    "options",
    [
        EnlittCallOptions(),  # no price, no max_charge
        EnlittCallOptions(price=lambda ctx: "1"),  # function price needs a max_charge
        EnlittCallOptions(price="500", max_charge="100"),  # constant above the ceiling
        EnlittCallOptions(price=5),  # type: ignore[arg-type]
    ],
)
async def test_bad_premium_options_never_reach_the_provider_or_enlitt(
    options: EnlittCallOptions, api: respx.MockRouter
) -> None:
    provider = Provider(provider_response())
    with pytest.raises(EnlittConfigurationError):
        await premium_client(provider).responses.create(model="gpt-5", input="Hi", enlitt=options)
    assert provider.calls == [] and api.calls.call_count == 0


async def test_background_is_rejected_before_admission(api: respx.MockRouter) -> None:
    provider = Provider(provider_response())
    with pytest.raises(EnlittConfigurationError):
        await premium_client(provider).responses.create(
            model="gpt-5", input="Hi", background=True, enlitt=EnlittCallOptions(price="5")
        )
    assert provider.calls == [] and api.calls.call_count == 0


async def test_refused_admission_never_calls_the_provider(api: respx.MockRouter) -> None:
    api.post("/v1/enlitt/operations").mock(
        return_value=httpx.Response(
            402,
            json={
                "error": {
                    "message": "none",
                    "type": "insufficient_quota",
                    "param": None,
                    "code": "premium_balance_exhausted",
                }
            },
        )
    )
    provider = Provider(provider_response())
    with pytest.raises(EnlittInsufficientCreditsError):
        await premium_client(provider).responses.create(
            model="gpt-5", input="Hi", enlitt=EnlittCallOptions(price="5")
        )
    assert provider.calls == []


# ---------------------------------------------------------------------------- premium streams


def delta(text: str) -> Any:
    return SimpleNamespace(type="response.output_text.delta", delta=text)


def terminal(kind: str = "response.completed", status: str = "completed") -> Any:
    return SimpleNamespace(type=kind, response=provider_response(status))


async def open_stream(
    api: respx.MockRouter, source: FakeStream, **options: Any
) -> tuple[Any, respx.Route, Provider]:
    _, report = stub_premium(api)
    provider = Provider(source)
    stream = await premium_client(provider).responses.create(
        model="gpt-5",
        input="Hi",
        stream=True,
        enlitt=EnlittCallOptions(**({"price": "30"} | options)),
    )
    return stream, report, provider


async def test_premium_stream_forwards_events_by_identity_and_settles_on_the_terminal(
    api: respx.MockRouter,
) -> None:
    events = [delta("a"), delta("b"), terminal()]
    stream, report, provider = await open_stream(api, FakeStream(list(events)))
    assert provider.calls[0]["stream"] is True
    got = []
    async for event in stream:
        got.append(event)
        if event is events[1]:
            assert report.call_count == 0  # not settled before the terminal event
    assert [a is b for a, b in zip(got, events, strict=True)] == [True, True, True]
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"]) == ("completed", "30")
    assert body["delivery"] == {"output_started": True, "output_completed": True}


async def test_premium_stream_failed_event_is_reported_failed(api: respx.MockRouter) -> None:
    stream, report, _ = await open_stream(
        api, FakeStream([delta("a"), terminal("response.failed", "failed")])
    )
    async for _ in stream:
        pass
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"]) == ("failed", "0")


async def test_premium_stream_closed_early_is_canceled(api: respx.MockRouter) -> None:
    source = FakeStream([delta("a"), delta("b"), terminal()])
    stream, report, _ = await open_stream(api, source)
    async with stream:
        await stream.__anext__()
    assert source.closed
    assert the_report(report)["status"] == "canceled"
    await stream.aclose()  # a second close sends no second report
    assert report.call_count == 1


async def test_premium_stream_without_a_terminal_is_failed(api: respx.MockRouter) -> None:
    stream, report, _ = await open_stream(api, FakeStream([delta("a")]))
    async for _ in stream:
        pass
    assert the_report(report)["status"] == "failed"


async def test_premium_stream_error_is_failed_and_reraised(api: respx.MockRouter) -> None:
    stream, report, _ = await open_stream(api, FakeStream([delta("a")], error=ValueError("boom")))
    with pytest.raises(ValueError, match="boom"):
        async for _ in stream:
            pass
    assert the_report(report)["status"] == "failed"


async def test_premium_stream_price_function_sees_every_event(api: respx.MockRouter) -> None:
    seen: list[OpenAIPremiumPriceContext] = []

    def price(ctx: OpenAIPremiumPriceContext) -> str:
        seen.append(ctx)
        return "7"

    events = [delta("a"), terminal()]
    stream, report, _ = await open_stream(
        api, FakeStream(list(events)), price=price, max_charge="100"
    )
    async for _ in stream:
        pass
    assert len(seen) == 1
    assert seen[0].events is not None and len(seen[0].events) == 2
    assert seen[0].time_to_first_token_ms is not None
    assert the_report(report)["charge_nano_usd"] == "7"
