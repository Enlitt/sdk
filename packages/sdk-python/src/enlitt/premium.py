"""Premium accounting (``core/premium.ts``): begin, run, exactly one terminal report.

A premium call is one provider call the business makes itself. Enlitt admits it first
(``begin``), the business runs it, and exactly one content-free report settles it.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict, TypeVar
from urllib.parse import quote

from . import _parse, _transport
from ._transport import EnlittOptions, InternalEnlittClient
from ._validate import (
    MAX_FACT_STRING_LENGTH,
    validate_label,
    validate_metadata,
    validate_nano_usd,
    validate_reporting_deadline_ms,
)
from .errors import EnlittConfigurationError, EnlittError, normalize_enlitt_model_error

T = TypeVar("T")

PremiumChargeFunction = Callable[[str], None]
"""``charge(amount)`` records the NANOUSD string to report; the last call wins."""

ERROR_CATEGORIES = ("provider", "timeout", "network", "invalid_request", "canceled", "unknown")

TERMINAL_REPORT_MAX_ATTEMPTS = 3
"""Total delivery attempts for one terminal report (first try plus two retries)."""

TERMINAL_REPORT_RETRY_DELAYS_MS = (250, 1_000)
"""Fixed waits before the second and third attempt."""


class UsageFacts(TypedDict, total=False):
    """Optional token counts for the terminal report."""

    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    reasoning_tokens: int


class DeliveryFacts(TypedDict):
    """Whether output reached the caller."""

    output_started: bool
    output_completed: bool


class TimingFacts(TypedDict):
    """RFC 3339 start and end instants of the provider call."""

    started_at: str
    ended_at: str


@dataclass(frozen=True, kw_only=True)
class PremiumTerminalFacts:
    """Safe, content-free facts for the terminal report. None has a financial effect."""

    usage: UsageFacts | None = None
    finish_reason: str | None = None
    provider_response_id: str | None = None
    delivery: DeliveryFacts | None = None
    timing: TimingFacts | None = None
    error_category: (
        Literal["provider", "timeout", "network", "invalid_request", "canceled", "unknown"] | None
    ) = None


@dataclass(frozen=True, kw_only=True)
class PremiumProvider:
    """Bounded disclosure labels for the provider that will run the call."""

    id: str
    model: str


@dataclass(frozen=True, kw_only=True)
class WithPremiumChargeOptions(EnlittOptions):
    """Options for :func:`with_premium_charge` (the construction options plus the call's)."""

    max_charge: str
    provider: PremiumProvider
    idempotency_key: str | None = None
    reporting_deadline_ms: int | None = None
    metadata: Mapping[str, str] | None = None


@dataclass(frozen=True, kw_only=True)
class PremiumChargeRequest:
    """The validated facts ``begin`` needs (``PremiumChargeRequest``)."""

    max_charge: str
    provider: PremiumProvider
    call_id: str | None = None
    reporting_deadline_ms: int | None = None
    metadata: Mapping[str, str] | None = None


@dataclass(frozen=True)
class PremiumOperation:
    """An admitted operation as returned by Enlitt."""

    operation_id: str
    effective_max_charge_nano_usd: str
    terminal_deadline: str


class PremiumChargeHandle:
    """What ``run`` receives besides ``charge``: the admitted operation and ``describe``."""

    def __init__(self, operation: PremiumOperation) -> None:
        self.operation_id = operation.operation_id
        self.effective_max_charge_nano_usd = operation.effective_max_charge_nano_usd
        self.terminal_deadline = operation.terminal_deadline
        self._facts: PremiumTerminalFacts | None = None
        self.outcome: Literal["completed", "failed", "canceled"] | None = None
        """Set by an adapter whose call resolved but must settle as failed or canceled."""

    def describe(self, facts: PremiumTerminalFacts) -> None:
        """Record safe facts for the report; the last call wins."""
        _check_facts(facts)
        self._facts = facts

    @property
    def facts(self) -> PremiumTerminalFacts | None:
        """The facts recorded so far (for the report builder)."""
        return self._facts

    def __repr__(self) -> str:
        return f"PremiumChargeHandle(operation_id={self.operation_id!r})"


def _check_facts(facts: PremiumTerminalFacts) -> None:
    if not isinstance(facts, PremiumTerminalFacts):
        raise EnlittConfigurationError("describe() takes a PremiumTerminalFacts.")
    for name, value in (
        ("finish_reason", facts.finish_reason),
        ("provider_response_id", facts.provider_response_id),
    ):
        if value is not None and (
            not isinstance(value, str) or not 1 <= len(value) <= MAX_FACT_STRING_LENGTH
        ):
            raise EnlittConfigurationError(
                f"{name} must be a string of 1 to {MAX_FACT_STRING_LENGTH} characters."
            )
    if facts.usage is not None:
        allowed = {"input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens"}
        for key, count in facts.usage.items():
            if (
                key not in allowed
                or isinstance(count, bool)
                or not isinstance(count, int)
                or count < 0
            ):
                raise EnlittConfigurationError(
                    "usage holds nonnegative integer input_tokens, output_tokens, "
                    "cached_input_tokens, and reasoning_tokens only."
                )
    if facts.delivery is not None and not (
        set(facts.delivery) == {"output_started", "output_completed"}
        and all(isinstance(v, bool) for v in facts.delivery.values())
    ):
        raise EnlittConfigurationError(
            "delivery needs boolean output_started and output_completed."
        )
    if facts.timing is not None and not (
        set(facts.timing) == {"started_at", "ended_at"}
        and all(isinstance(v, str) and 1 <= len(v) <= 64 for v in facts.timing.values())
    ):
        raise EnlittConfigurationError("timing needs started_at and ended_at RFC 3339 strings.")
    if facts.error_category is not None and facts.error_category not in ERROR_CATEGORIES:
        raise EnlittConfigurationError(f"error_category must be one of {ERROR_CATEGORIES}.")


# ---------------------------------------------------------------------------------------------
# Wire bodies (strict out)
# ---------------------------------------------------------------------------------------------


def build_begin_body(request: PremiumChargeRequest) -> dict[str, Any]:
    """The ``POST /v1/enlitt/operations`` body. Content-free by construction."""
    body: dict[str, Any] = {
        "mode": "premium",
        "max_charge_nano_usd": validate_nano_usd(request.max_charge, "max_charge"),
        "provider": {
            "id": validate_label(request.provider.id, "provider.id"),
            "model": validate_label(request.provider.model, "provider.model"),
        },
    }
    deadline = validate_reporting_deadline_ms(request.reporting_deadline_ms)
    if deadline is not None:
        body["reporting_deadline_ms"] = deadline
    metadata = validate_metadata(request.metadata)
    if metadata is not None:
        body["metadata"] = metadata
    return body


def build_report_body(
    report_id: str, status: str, charge_nano_usd: str, facts: PremiumTerminalFacts | None
) -> dict[str, Any]:
    """The ``POST /v1/enlitt/operations/{id}/terminal`` body."""
    body: dict[str, Any] = {
        "report_id": report_id,
        "status": status,
        "charge_nano_usd": charge_nano_usd,
    }
    if facts is None:
        return body
    if facts.usage:
        body["usage"] = dict(facts.usage)
    if facts.finish_reason is not None:
        body["finish_reason"] = facts.finish_reason
    if facts.provider_response_id is not None:
        body["provider_response_id"] = facts.provider_response_id
    if facts.delivery is not None:
        body["delivery"] = dict(facts.delivery)
    if facts.timing is not None:
        body["timing"] = dict(facts.timing)
    if facts.error_category is not None:
        body["error_category"] = facts.error_category
    return body


# ---------------------------------------------------------------------------------------------
# Begin and report
# ---------------------------------------------------------------------------------------------


async def begin_premium_operation(
    client: InternalEnlittClient, request: PremiumChargeRequest, call_id: str
) -> PremiumOperation:
    """Ask Enlitt to admit one premium call. Any refusal raises with ``provider_invoked=False``."""
    response = await _transport.request_enlitt(
        client, path="/v1/enlitt/operations", body=build_begin_body(request), call_id=call_id
    )
    raw = await _transport.read_json_body(response)
    parsed = _parse.parse_body(_parse.parse_begin_response, raw, "begin response")
    return PremiumOperation(
        operation_id=parsed["operation_id"],
        effective_max_charge_nano_usd=parsed["effective_max_charge_nano_usd"],
        terminal_deadline=parsed["terminal_deadline"],
    )


def _is_transient(error: EnlittError) -> bool:
    return error.retryable or error.code == "transport_failed"


async def report_premium_terminal_state(
    client: InternalEnlittClient,
    operation: PremiumOperation,
    *,
    report_id: str,
    status: str,
    charge_nano_usd: str,
    facts: PremiumTerminalFacts | None,
) -> None:
    """Deliver one terminal report; never raises an ``EnlittError``.

    The same ``report_id`` (also the ``Idempotency-Key``) is used for every attempt, so a retry
    is a replay. An undeliverable report goes to ``client.on_terminal_report_error`` and is
    otherwise dropped, because the business's delivered output must not become an error.
    """
    body = build_report_body(report_id, status, charge_nano_usd, facts)
    path = f"/v1/enlitt/operations/{quote(operation.operation_id, safe='')}/terminal"
    error: EnlittError | None = None
    for attempt in range(TERMINAL_REPORT_MAX_ATTEMPTS):
        try:
            response = await _transport.request_enlitt(
                client, path=path, body=body, call_id=report_id
            )
            raw = await _transport.read_json_body(response)
            _parse.parse_body(_parse.parse_terminal_response, raw, "terminal report response")
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = normalize_enlitt_model_error(exc)
        if not _is_transient(error) or attempt == TERMINAL_REPORT_MAX_ATTEMPTS - 1:
            break
        await _transport.runtime.sleep(TERMINAL_REPORT_RETRY_DELAYS_MS[attempt] / 1000)
    if error is not None and client.on_terminal_report_error is not None:
        with contextlib.suppress(Exception):
            client.on_terminal_report_error(error)


# ---------------------------------------------------------------------------------------------
# The one lifecycle
# ---------------------------------------------------------------------------------------------


@dataclass
class _Recorder:
    """Mutable record of what ``run`` asked to report."""

    charge: str = "0"
    sent: bool = False


def _clamp(charge: str, effective_max: str) -> str:
    """Lower ``charge`` to the effective maximum with exact integer arithmetic."""
    return str(min(int(charge), int(effective_max)))


class PremiumCall:
    """One admitted operation plus the exactly-once settlement of it.

    ``run_premium_charge`` drives this for a simple awaited call. The OpenAI adapter drives it
    directly for a stream, whose lifetime outlasts the call that created it.
    """

    def __init__(self, client: InternalEnlittClient, operation: PremiumOperation) -> None:
        self._client = client
        self._operation = operation
        self._recorder = _Recorder()
        self.handle = PremiumChargeHandle(operation)

    @property
    def settled(self) -> bool:
        """True once the terminal report has been attempted."""
        return self._recorder.sent

    def charge(self, amount: str) -> None:
        """Record the NANOUSD string to report; the last call wins."""
        if self._recorder.sent:
            raise EnlittConfigurationError("charge() was called after the report was sent.")
        self._recorder.charge = validate_nano_usd(amount, "The charge")

    async def settle(self, status: str) -> None:
        """Send the one terminal report. A second call is a no-op."""
        if self._recorder.sent:
            return
        self._recorder.sent = True
        amount = (
            "0"
            if status == "failed"
            else _clamp(self._recorder.charge, self._operation.effective_max_charge_nano_usd)
        )
        await report_premium_terminal_state(
            self._client,
            self._operation,
            report_id=uuid.uuid4().hex,
            status=status,
            charge_nano_usd=amount,
            facts=self.handle.facts,
        )


async def start_premium_call(
    client: InternalEnlittClient, request: PremiumChargeRequest
) -> PremiumCall:
    """Resolve the call ID and ask Enlitt to admit the call. A refusal raises."""
    call_id = (
        _transport.validate_idempotency_key(request.call_id, what="call ID")
        if request.call_id is not None
        else _transport.generate_call_id()
    )
    operation = await begin_premium_operation(client, request, call_id)
    return PremiumCall(client, operation)


async def run_premium_charge(
    client: InternalEnlittClient,
    request: PremiumChargeRequest,
    run: Callable[[PremiumChargeFunction, PremiumChargeHandle], Awaitable[T]],
) -> T:
    """Begin one operation, run the call, send exactly one terminal report.

    ``run`` settling decides the status: returning is ``completed`` (unless it set
    ``handle.outcome``), task cancellation is ``canceled`` (the cancellation still propagates,
    after a shielded report), any other exception is ``failed``. The business's own result or
    exception passes through unchanged.
    """
    call = await start_premium_call(client, request)
    try:
        result = await run(call.charge, call.handle)
    except asyncio.CancelledError:
        await shielded(call.settle("canceled"))
        raise
    except BaseException:
        await shielded(call.settle("failed"))
        raise
    await call.settle(call.handle.outcome or "completed")
    return result


async def shielded(report: Awaitable[None]) -> None:
    """Finish ``report`` even if the surrounding task is cancelled again while it runs."""
    task = asyncio.ensure_future(report)
    await asyncio.shield(task)


async def with_premium_charge(
    options: WithPremiumChargeOptions,
    run: Callable[[PremiumChargeFunction, PremiumChargeHandle], Awaitable[T]],
) -> T:
    """Account one premium model call made outside the SDK's adapters.

    Validates the options (``EnlittConfigurationError`` before any request), then runs the
    one premium lifecycle. One call is one model call: retrying with the same
    ``idempotency_key`` replays the operation instead of charging again.
    """
    client = _transport.create_internal_client(options)
    request = PremiumChargeRequest(
        max_charge=validate_nano_usd(options.max_charge, "max_charge"),
        provider=options.provider,
        call_id=(
            _transport.validate_idempotency_key(options.idempotency_key)
            if options.idempotency_key is not None
            else None
        ),
        reporting_deadline_ms=validate_reporting_deadline_ms(options.reporting_deadline_ms),
        metadata=validate_metadata(options.metadata),
    )
    build_begin_body(request)  # validates provider labels before anything is sent
    return await run_premium_charge(client, request, run)
