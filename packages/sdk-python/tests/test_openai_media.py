"""Group 5 (media): premium image, speech, and transcription through ``enlitt.openai``.

The cases port the OpenAI ones of ``premium-media-model.test.ts`` / ``media.test.ts``. A
fake ``AsyncOpenAI`` records what the provider receives, and ``respx`` stands in for Enlitt.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
import respx

import enlitt.openai as enlitt_openai
from _support import TOKEN, load_fixtures
from enlitt import (
    EnlittConfigurationError,
    EnlittInsufficientCreditsError,
    EnlittOptions,
    enlitt_session,
)
from enlitt.openai import (
    EnlittCallOptions,
    EnlittMediaCallOptions,
    OpenAIPremiumMediaPriceContext,
    enlitt,
)

OP_ID = "op_media_1"
BEGIN_PATH = "/v1/enlitt/operations"
TERMINAL_PATH = f"/v1/enlitt/operations/{OP_ID}/terminal"
SETTLED = dict(load_fixtures("responses"))["report-terminal--settled"]["body"]
OPTIONS = EnlittOptions(session=enlitt_session(TOKEN))

# Content that must never reach Enlitt, in any request.
PROMPT = "A watercolor fox, secret-prompt-marker"
SPOKEN = "Hello there, secret-speech-marker"
AUDIO = b"secret-audio-bytes"

# ----------------------------------------------------------------------------------- fakes


class FakeMethod:
    """One provider method: records its keyword arguments, then returns or raises."""

    def __init__(self, result: Any = None, error: BaseException | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result
        self.error = error
        self.hang: asyncio.Event | None = None
        # Called when the provider runs, so a test can see what had happened by then.
        self.probe: Any = None
        self.probed: list[Any] = []

    async def __call__(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self.probe is not None:
            self.probed.append(self.probe())
        if self.hang is not None:
            self.hang.set()
            await asyncio.sleep(3600)
        if self.error is not None:
            raise self.error
        return self.result


class FakeOpenAI:
    """A stand-in for ``AsyncOpenAI`` with the three media methods and ``responses``."""

    def __init__(self) -> None:
        self.generate = FakeMethod(image_response())
        self.speak = FakeMethod(SimpleNamespace(content=b"mp3 bytes the adapter never reads"))
        self.transcribe = FakeMethod(SimpleNamespace(text="hello", usage=None))
        self.responses = SimpleNamespace(create=FakeMethod())
        self.images = SimpleNamespace(generate=self.generate)
        self.audio = SimpleNamespace(
            speech=SimpleNamespace(create=self.speak),
            transcriptions=SimpleNamespace(create=self.transcribe),
        )

    @property
    def every_call(self) -> list[dict[str, Any]]:
        return self.generate.calls + self.speak.calls + self.transcribe.calls


def image_response(**usage: int) -> Any:
    return SimpleNamespace(
        data=[SimpleNamespace(b64_json="aW1hZ2U="), SimpleNamespace(b64_json="aW1hZ2U=")],
        usage=SimpleNamespace(**usage) if usage else None,
    )


def client(provider: FakeOpenAI) -> Any:
    return enlitt(provider, OPTIONS)  # type: ignore[arg-type]


def stub_premium(
    api: respx.MockRouter, effective_max: str = "1000"
) -> tuple[respx.Route, respx.Route]:
    begin = api.post(BEGIN_PATH).mock(
        return_value=httpx.Response(
            200,
            json={
                "operation_id": OP_ID,
                "billing": "premium",
                "report_terminal": True,
                "effective_max_charge_nano_usd": effective_max,
                "reserved_nano_usd": effective_max,
                "terminal_deadline": "2026-11-20T12:00:00Z",
            },
        )
    )
    report = api.post(TERMINAL_PATH).mock(return_value=httpx.Response(200, json=SETTLED))
    return begin, report


def the_report(route: respx.Route) -> dict[str, Any]:
    assert route.call_count == 1, "expected exactly one terminal report"
    return json.loads(route.calls.last.request.content)  # type: ignore[no-any-return]


async def call(kind: str, c: Any, **kwargs: Any) -> Any:
    """Run one media call of ``kind`` with its minimal valid arguments plus ``kwargs``."""
    if kind == "image":
        return await c.images.generate(model="gpt-image-1", prompt=PROMPT, **kwargs)
    if kind == "speech":
        return await c.audio.speech.create(
            model="gpt-4o-mini-tts", voice="alloy", input=SPOKEN, **kwargs
        )
    return await c.audio.transcriptions.create(
        model="gpt-4o-mini-transcribe", file=("a.mp3", AUDIO), **kwargs
    )


KINDS = ["image", "speech", "transcription"]
MODELS = {
    "image": "gpt-image-1",
    "speech": "gpt-4o-mini-tts",
    "transcription": "gpt-4o-mini-transcribe",
}


def method_of(provider: FakeOpenAI, kind: str) -> FakeMethod:
    return {
        "image": provider.generate,
        "speech": provider.speak,
        "transcription": provider.transcribe,
    }[kind]


# ------------------------------------------------------------------- admission and wire


@pytest.mark.parametrize("kind", KINDS)
async def test_admission_precedes_the_provider_and_no_content_reaches_enlitt(
    kind: str, api: respx.MockRouter
) -> None:
    begin, report = stub_premium(api)
    provider = FakeOpenAI()
    method = method_of(provider, kind)
    method.probe = lambda: (begin.call_count, report.call_count)

    returned = await call(kind, client(provider), enlitt=EnlittMediaCallOptions(price="7"))

    # When the provider ran, Enlitt had admitted the call and nothing was reported yet.
    assert method.probed == [(1, 0)]
    assert returned is method.result
    begin_body = json.loads(begin.calls.last.request.content)
    assert begin_body == {
        "mode": "premium",
        "max_charge_nano_usd": "7",
        "provider": {"id": "openai", "model": MODELS[kind]},
    }
    report_body = the_report(report)
    assert (report_body["status"], report_body["charge_nano_usd"]) == ("completed", "7")
    for sent in api.calls:
        raw = sent.request.content
        for marker in (b"secret-prompt-marker", b"secret-speech-marker", AUDIO, b"aW1hZ2U="):
            assert marker not in raw, f"{marker!r} reached Enlitt at {sent.request.url}"


async def test_the_provider_gets_its_own_arguments_and_the_timeout(api: respx.MockRouter) -> None:
    stub_premium(api)
    provider = FakeOpenAI()
    await client(provider).images.generate(
        model="gpt-image-1",
        prompt=PROMPT,
        size="1024x1024",
        timeout=12,
        enlitt=EnlittMediaCallOptions(price="5"),
    )
    assert provider.generate.calls == [
        {"model": "gpt-image-1", "prompt": PROMPT, "size": "1024x1024", "timeout": 12.0}
    ]


async def test_image_usage_is_the_only_reported_fact_besides_timing(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)
    provider = FakeOpenAI()
    provider.generate.result = image_response(input_tokens=11, output_tokens=22)
    await client(provider).images.generate(
        model="gpt-image-1", prompt=PROMPT, enlitt=EnlittMediaCallOptions(price="5")
    )
    body = the_report(report)
    assert body["usage"] == {"input_tokens": 11, "output_tokens": 22}
    assert set(body["timing"]) == {"started_at", "ended_at"}
    for absent in ("finish_reason", "provider_response_id", "delivery", "error_category"):
        assert absent not in body


# ------------------------------------------------------------------------ local refusals


@pytest.mark.parametrize(
    ("kind", "arguments"),
    [
        ("image", {"prompt": PROMPT}),  # no model
        ("image", {"model": "enlitt-standard", "prompt": PROMPT}),
        ("image", {"model": "gpt-image-1", "prompt": PROMPT, "stream": True}),
        ("transcription", {"model": "whisper-1", "file": ("a.mp3", AUDIO), "stream": True}),
        ("transcription", {"file": ("a.mp3", AUDIO)}),  # no model
        ("speech", {"model": "tts-1", "voice": "alloy"}),  # no input
        ("speech", {"model": "", "voice": "alloy", "input": SPOKEN}),
    ],
)
async def test_local_refusals_make_no_request(
    kind: str, arguments: dict[str, Any], api: respx.MockRouter
) -> None:
    provider = FakeOpenAI()
    c = client(provider)
    target = {
        "image": c.images.generate,
        "speech": c.audio.speech.create,
        "transcription": c.audio.transcriptions.create,
    }[kind]
    with pytest.raises(EnlittConfigurationError):
        await target(**arguments, enlitt=EnlittMediaCallOptions(price="5"))
    assert provider.every_call == [] and api.calls.call_count == 0


@pytest.mark.parametrize("kind", KINDS)
async def test_a_standard_only_client_refuses_media(kind: str, api: respx.MockRouter) -> None:
    with pytest.raises(EnlittConfigurationError):
        await call(kind, enlitt(None, OPTIONS), enlitt=EnlittMediaCallOptions(price="5"))
    assert api.calls.call_count == 0


@pytest.mark.parametrize(
    "options",
    [
        None,  # neither max_charge nor price
        EnlittMediaCallOptions(),
        EnlittMediaCallOptions(price=lambda ctx: "1"),  # a function needs max_charge
        EnlittMediaCallOptions(price="500", max_charge="100"),  # constant above the maximum
        EnlittMediaCallOptions(price="1.5"),  # not a NANOUSD integer string
        EnlittCallOptions(price="5"),  # the Responses options type
    ],
)
async def test_bad_options_never_reach_the_provider_or_enlitt(
    options: Any, api: respx.MockRouter
) -> None:
    provider = FakeOpenAI()
    with pytest.raises(EnlittConfigurationError):
        await call("image", client(provider), enlitt=options)
    assert provider.every_call == [] and api.calls.call_count == 0


async def test_bad_timeout_is_refused_locally(api: respx.MockRouter) -> None:
    provider = FakeOpenAI()
    with pytest.raises(EnlittConfigurationError):
        await call("speech", client(provider), timeout=0, enlitt=EnlittMediaCallOptions(price="5"))
    assert provider.every_call == [] and api.calls.call_count == 0


async def test_refused_admission_never_calls_the_provider(api: respx.MockRouter) -> None:
    api.post(BEGIN_PATH).mock(
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
    provider = FakeOpenAI()
    with pytest.raises(EnlittInsufficientCreditsError):
        await call("transcription", client(provider), enlitt=EnlittMediaCallOptions(price="5"))
    assert provider.every_call == []


# -------------------------------------------------------------------- status and price


@pytest.mark.parametrize("kind", KINDS)
async def test_a_price_function_runs_once_and_is_clamped(kind: str, api: respx.MockRouter) -> None:
    _, report = stub_premium(api, effective_max="500")
    seen: list[OpenAIPremiumMediaPriceContext] = []

    def price(context: OpenAIPremiumMediaPriceContext) -> str:
        seen.append(context)
        return "900"

    await call(
        kind, client(FakeOpenAI()), enlitt=EnlittMediaCallOptions(max_charge="1000", price=price)
    )
    assert len(seen) == 1
    assert seen[0].kind == kind and seen[0].status == "completed"
    assert seen[0].effective_max_charge_nano_usd == "500"
    assert the_report(report)["charge_nano_usd"] == "500"


async def test_an_async_price_function_is_awaited(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)

    async def price(context: OpenAIPremiumMediaPriceContext) -> str:
        await asyncio.sleep(0)
        return "42"

    await call(
        "speech", client(FakeOpenAI()), enlitt=EnlittMediaCallOptions(max_charge="100", price=price)
    )
    assert the_report(report)["charge_nano_usd"] == "42"


async def test_a_business_written_per_image_price(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)

    def per_image(context: OpenAIPremiumMediaPriceContext) -> str:
        images = len(context.response.data) if context.response is not None else 0
        return str(40 * images)

    await call(
        "image",
        client(FakeOpenAI()),
        enlitt=EnlittMediaCallOptions(max_charge="1000", price=per_image),
    )
    assert the_report(report)["charge_nano_usd"] == "80"  # two images in the fake response


async def test_a_failing_price_function_charges_zero_and_reaches_the_hook(
    api: respx.MockRouter,
) -> None:
    _, report = stub_premium(api)
    errors: list[BaseException] = []
    c = enlitt(
        FakeOpenAI(),  # type: ignore[arg-type]
        EnlittOptions(session=enlitt_session(TOKEN), on_terminal_report_error=errors.append),
    )

    def broken(context: OpenAIPremiumMediaPriceContext) -> str:
        raise RuntimeError("pricing bug")

    result = await call("image", c, enlitt=EnlittMediaCallOptions(max_charge="100", price=broken))
    assert result is not None
    assert the_report(report)["charge_nano_usd"] == "0"
    assert len(errors) == 1 and isinstance(errors[0], EnlittConfigurationError)


async def test_no_price_charges_zero(api: respx.MockRouter) -> None:
    _, report = stub_premium(api)
    await call(
        "transcription", client(FakeOpenAI()), enlitt=EnlittMediaCallOptions(max_charge="100")
    )
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"]) == ("completed", "0")


@pytest.mark.parametrize("kind", KINDS)
async def test_a_provider_error_is_failed_at_zero_never_priced_and_reraised(
    kind: str, api: respx.MockRouter
) -> None:
    _, report = stub_premium(api)
    provider = FakeOpenAI()
    failure = openai.APITimeoutError(request=httpx.Request("POST", "https://api.openai.test/"))
    method_of(provider, kind).error = failure
    priced: list[OpenAIPremiumMediaPriceContext] = []

    def price(context: OpenAIPremiumMediaPriceContext) -> str:
        priced.append(context)
        return "9"

    with pytest.raises(openai.APITimeoutError) as raised:
        await call(
            kind, client(provider), enlitt=EnlittMediaCallOptions(max_charge="100", price=price)
        )
    assert raised.value is failure
    assert priced == []
    body = the_report(report)
    # Even a timeout is "provider", as in TypeScript.
    assert (body["status"], body["charge_nano_usd"], body["error_category"]) == (
        "failed",
        "0",
        "provider",
    )


@pytest.mark.parametrize("kind", KINDS)
async def test_cancellation_is_priced_without_a_response_and_reraised(
    kind: str, api: respx.MockRouter
) -> None:
    _, report = stub_premium(api)
    provider = FakeOpenAI()
    started = asyncio.Event()
    method_of(provider, kind).hang = started
    seen: list[OpenAIPremiumMediaPriceContext] = []

    def price(context: OpenAIPremiumMediaPriceContext) -> str:
        seen.append(context)
        return "3"

    task = asyncio.create_task(
        call(kind, client(provider), enlitt=EnlittMediaCallOptions(max_charge="100", price=price))
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(seen) == 1 and seen[0].status == "canceled" and seen[0].response is None
    body = the_report(report)
    assert (body["status"], body["charge_nano_usd"], body["error_category"]) == (
        "canceled",
        "3",
        "canceled",
    )


# --------------------------------------------------------------------------- price context


async def test_the_price_context_per_kind(api: respx.MockRouter) -> None:
    stub_premium(api)
    provider = FakeOpenAI()
    c = client(provider)
    seen: list[OpenAIPremiumMediaPriceContext] = []

    def price(context: OpenAIPremiumMediaPriceContext) -> str:
        seen.append(context)
        return "1"

    options = EnlittMediaCallOptions(max_charge="100", price=price)
    await c.images.generate(model="gpt-image-1", prompt=PROMPT, n=2, enlitt=options)
    # An emoji is one code point, so this is 3 characters.
    await c.audio.speech.create(model="tts-1", voice="alloy", input="a🦊b", enlitt=options)
    await c.audio.transcriptions.create(model="whisper-1", file=("a.mp3", AUDIO), enlitt=options)

    image, speech, transcription = seen
    assert image.kind == "image" and image.response is provider.generate.result
    assert dict(image.request) == {"model": "gpt-image-1", "prompt": PROMPT, "n": 2}
    assert image.characters is None
    assert speech.kind == "speech" and speech.characters == 3
    assert speech.response is None  # the audio body is never handed to pricing
    assert transcription.kind == "transcription"
    assert transcription.response is provider.transcribe.result
    assert transcription.characters is None
    for context in seen:
        assert context.ended_at >= context.started_at and context.duration_ms >= 0
        with pytest.raises(TypeError):
            context.request["model"] = "changed"  # type: ignore[index]


# --------------------------------------------------------------------------- call identity


async def test_a_supplied_idempotency_key_is_the_call_id_and_each_call_is_fresh_otherwise(
    api: respx.MockRouter,
) -> None:
    begin, _ = stub_premium(api)
    c = client(FakeOpenAI())
    key = "media-call-id-00001"
    await call("image", c, enlitt=EnlittMediaCallOptions(price="1", idempotency_key=key))
    assert begin.calls.last.request.headers["idempotency-key"] == key
    await call("image", c, enlitt=EnlittMediaCallOptions(price="1"))
    await call("image", c, enlitt=EnlittMediaCallOptions(price="1"))
    first, second = (begin.calls[i].request.headers["idempotency-key"] for i in (1, 2))
    assert first != second and key not in (first, second)


# ------------------------------------------------------------------------------- exports


def test_there_are_no_media_price_helpers() -> None:
    for name in ("per_image", "per_character", "per_audio_second"):
        assert not hasattr(enlitt_openai, name)
    for name in (
        "EnlittMediaCallOptions",
        "EnlittOpenAIMediaPrice",
        "OpenAIPremiumMediaPriceContext",
    ):
        assert name in enlitt_openai.__all__
