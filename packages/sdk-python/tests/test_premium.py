"""Premium lifecycle: begin, run, exactly one terminal report."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx

from _support import TOKEN, load_fixtures
from conftest import FakeClock
from enlitt import (
    EnlittConfigurationError,
    EnlittError,
    EnlittInsufficientCreditsError,
    PremiumChargeHandle,
    PremiumProvider,
    PremiumTerminalFacts,
    WithPremiumChargeOptions,
    enlitt_session,
    with_premium_charge,
)

OPERATION_ID = "op_test_1"
TERMINAL_PATH = f"/v1/enlitt/operations/{OPERATION_ID}/terminal"


def begin_body(effective_max: str = "1000") -> dict[str, Any]:
    return {
        "operation_id": OPERATION_ID,
        "billing": "premium",
        "report_terminal": True,
        "effective_max_charge_nano_usd": effective_max,
        "reserved_nano_usd": effective_max,
        "terminal_deadline": "2026-10-28T12:00:00Z",
    }


SETTLED = dict(load_fixtures("responses"))["report-terminal--settled"]["body"]


def options(**extra: Any) -> WithPremiumChargeOptions:
    base: dict[str, Any] = {
        "session": enlitt_session(TOKEN),
        "max_charge": "1000",
        "provider": PremiumProvider(id="openai", model="gpt-5"),
    }
    base.update(extra)
    return WithPremiumChargeOptions(**base)


def stub(api: respx.MockRouter, effective_max: str = "1000") -> tuple[respx.Route, respx.Route]:
    begin = api.post("/v1/enlitt/operations").mock(
        return_value=httpx.Response(200, json=begin_body(effective_max))
    )
    report = api.post(TERMINAL_PATH).mock(return_value=httpx.Response(200, json=SETTLED))
    return begin, report


def reported(route: respx.Route) -> dict[str, Any]:
    assert route.call_count == 1, "expected exactly one terminal report"
    return json.loads(route.calls.last.request.content)  # type: ignore[no-any-return]


async def test_success_reports_completed_with_the_last_charge(api: respx.MockRouter) -> None:
    begin, report = stub(api)

    async def run(charge: Any, handle: PremiumChargeHandle) -> str:
        charge("100")
        charge("700")
        return "provider result"

    assert await with_premium_charge(options(idempotency_key="my-call-id-0123456"), run) == (
        "provider result"
    )
    sent = begin.calls.last.request
    assert sent.headers["idempotency-key"] == "my-call-id-0123456"
    assert json.loads(sent.content) == {
        "mode": "premium",
        "max_charge_nano_usd": "1000",
        "provider": {"id": "openai", "model": "gpt-5"},
    }  # no call_id body field, no content
    body = reported(report)
    assert body["status"] == "completed"
    assert body["charge_nano_usd"] == "700"
    sent_report = report.calls.last.request
    assert sent_report.headers["idempotency-key"] == body["report_id"]


async def test_no_charge_call_reports_zero(api: respx.MockRouter) -> None:
    _, report = stub(api)

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        return None

    await with_premium_charge(options(), run)
    assert reported(report)["charge_nano_usd"] == "0"


async def test_failure_reports_failed_zero_and_the_error_passes_through(
    api: respx.MockRouter,
) -> None:
    _, report = stub(api)

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        charge("500")
        raise ValueError("provider exploded")

    with pytest.raises(ValueError, match="provider exploded"):
        await with_premium_charge(options(), run)
    body = reported(report)
    assert (body["status"], body["charge_nano_usd"]) == ("failed", "0")


async def test_cancellation_still_sends_the_report_then_reraises(api: respx.MockRouter) -> None:
    _, report = stub(api)
    started = asyncio.Event()

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        charge("300")
        started.set()
        await asyncio.sleep(3600)

    task = asyncio.create_task(with_premium_charge(options(), run))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    body = reported(report)
    assert body["status"] == "canceled"
    assert body["charge_nano_usd"] == "300"


async def test_charge_is_clamped_to_the_effective_max(api: respx.MockRouter) -> None:
    _, report = stub(api, effective_max="400")

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        assert handle.effective_max_charge_nano_usd == "400"
        charge("999")

    await with_premium_charge(options(), run)
    assert reported(report)["charge_nano_usd"] == "400"


async def test_amount_above_two_to_the_63_stays_exact(api: respx.MockRouter) -> None:
    big = str(2**63 + 12345)
    _, report = stub(api, effective_max=big)

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        charge(big)

    await with_premium_charge(options(max_charge=big), run)
    assert reported(report)["charge_nano_usd"] == big


@pytest.mark.parametrize("bad", ["-1", "1.5", "01", "", " 5", 5, "1" * 31])
async def test_invalid_amounts_are_refused_before_any_request(
    api: respx.MockRouter, bad: Any
) -> None:
    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        raise AssertionError("must not run")

    with pytest.raises(EnlittConfigurationError):
        await with_premium_charge(options(max_charge=bad), run)
    assert api.calls.call_count == 0


async def test_invalid_charge_inside_run_is_a_configuration_error(
    api: respx.MockRouter,
) -> None:
    _, report = stub(api)

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        charge("12.5")

    with pytest.raises(EnlittConfigurationError):
        await with_premium_charge(options(), run)
    assert reported(report)["status"] == "failed"


async def test_refused_admission_means_the_run_never_executes(api: respx.MockRouter) -> None:
    api.post("/v1/enlitt/operations").mock(
        return_value=httpx.Response(
            402,
            json={
                "error": {
                    "message": "no credit",
                    "type": "insufficient_quota",
                    "param": None,
                    "code": "premium_balance_exhausted",
                }
            },
        )
    )
    ran = False

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        nonlocal ran
        ran = True

    with pytest.raises(EnlittInsufficientCreditsError) as caught:
        await with_premium_charge(options(), run)
    assert not ran
    assert caught.value.provider_invoked is False


async def test_facts_are_included_in_the_report(api: respx.MockRouter) -> None:
    _, report = stub(api)

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        handle.describe(
            PremiumTerminalFacts(
                usage={"input_tokens": 10, "output_tokens": 20},
                finish_reason="stop",
                provider_response_id="resp_abc",
                delivery={"output_started": True, "output_completed": True},
            )
        )

    await with_premium_charge(options(), run)
    body = reported(report)
    assert body["usage"] == {"input_tokens": 10, "output_tokens": 20}
    assert body["finish_reason"] == "stop"
    assert body["provider_response_id"] == "resp_abc"
    assert body["delivery"] == {"output_started": True, "output_completed": True}


async def test_report_is_retried_with_the_same_report_id(
    api: respx.MockRouter, clock: FakeClock
) -> None:
    api.post("/v1/enlitt/operations").mock(return_value=httpx.Response(200, json=begin_body()))
    report = api.post(TERMINAL_PATH).mock(
        side_effect=[
            httpx.Response(
                500,
                json={
                    "error": {
                        "message": "x",
                        "type": "server_error",
                        "param": None,
                        "code": "server_error",
                    }
                },
            ),
            httpx.ConnectError("reset"),
            httpx.Response(200, json=SETTLED),
        ]
    )

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        charge("5")

    await with_premium_charge(options(), run)
    assert report.call_count == 3
    ids = {json.loads(c.request.content)["report_id"] for c in report.calls}
    keys = {c.request.headers["idempotency-key"] for c in report.calls}
    assert len(ids) == 1
    assert keys == ids
    assert clock.sleeps == [0.25, 1.0]


async def test_undeliverable_report_goes_to_the_hook_and_never_raises(
    api: respx.MockRouter, clock: FakeClock
) -> None:
    api.post("/v1/enlitt/operations").mock(return_value=httpx.Response(200, json=begin_body()))
    report = api.post(TERMINAL_PATH).mock(side_effect=httpx.ConnectError("down"))
    errors: list[EnlittError] = []

    async def run(charge: Any, handle: PremiumChargeHandle) -> str:
        return "delivered"

    result = await with_premium_charge(options(on_terminal_report_error=errors.append), run)
    assert result == "delivered"
    assert report.call_count == 3
    assert [e.code for e in errors] == ["transport_failed"]


async def test_hook_exception_is_swallowed(api: respx.MockRouter, clock: FakeClock) -> None:
    api.post("/v1/enlitt/operations").mock(return_value=httpx.Response(200, json=begin_body()))
    api.post(TERMINAL_PATH).mock(side_effect=httpx.ConnectError("down"))

    def hook(error: EnlittError) -> None:
        raise RuntimeError("hook bug")

    async def run(charge: Any, handle: PremiumChargeHandle) -> int:
        return 1

    assert await with_premium_charge(options(on_terminal_report_error=hook), run) == 1


async def test_non_transient_report_error_is_not_retried(api: respx.MockRouter) -> None:
    api.post("/v1/enlitt/operations").mock(return_value=httpx.Response(200, json=begin_body()))
    report = api.post(TERMINAL_PATH).mock(
        return_value=httpx.Response(
            404,
            json={
                "error": {
                    "message": "x",
                    "type": "invalid_request_error",
                    "param": None,
                    "code": "not_found",
                }
            },
        )
    )
    errors: list[EnlittError] = []

    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        return None

    await with_premium_charge(options(on_terminal_report_error=errors.append), run)
    assert report.call_count == 1
    assert [e.code for e in errors] == ["not_found"]


@pytest.mark.parametrize(
    "bad",
    [
        {"idempotency_key": "short"},
        {"reporting_deadline_ms": -1},
        {"metadata": {"enlitt_reserved": "x"}},
        {"metadata": {"k": 5}},
        {"provider": PremiumProvider(id="", model="m")},
        {"provider": PremiumProvider(id="x" * 200, model="m")},
    ],
)
async def test_bad_options_are_refused_before_any_request(
    api: respx.MockRouter, bad: dict[str, Any]
) -> None:
    async def run(charge: Any, handle: PremiumChargeHandle) -> None:
        raise AssertionError("must not run")

    with pytest.raises(EnlittConfigurationError):
        await with_premium_charge(options(**bad), run)
    assert api.calls.call_count == 0
