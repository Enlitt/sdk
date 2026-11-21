"""Premium image, speech, and transcription calls for the OpenAI adapter (``openai/media.ts``).

These are the premium-only ``images.generate``, ``audio.speech.create`` and
``audio.transcriptions.create`` methods of :class:`enlitt.openai.EnlittOpenAI`. Each call is one
provider call wrapped in the shared premium lifecycle:

1. The arguments and the ``enlitt=`` options are checked locally. A refusal raises
   ``EnlittConfigurationError`` before any request.
2. Enlitt admits the call (``begin``) with the declared maximum.
3. The business's own ``AsyncOpenAI`` client runs the call. Its result or exception is
   passed through by identity.
4. The price is evaluated (a constant, or the business's own function), and exactly one
   content-free terminal report settles the call.

There is no standard image or audio model, so ``"enlitt-standard"`` is refused here. There
are no media price helpers either (owner decision 2026-11-20): a business that wants a
per-image or per-second price writes that function from :class:`OpenAIPremiumMediaPriceContext`.

Enlitt never receives the prompt, the text, the audio or the images. The price context holds
them only inside the business's process.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal, cast

from .errors import EnlittConfigurationError
from .openai import (
    ENLITT_STANDARD_MODEL,
    PROVIDER_ID,
    _check_timeout,
    _rfc3339,
    read_call_options,
)
from .premium import (
    PremiumCall,
    PremiumChargeRequest,
    PremiumProvider,
    PremiumTerminalFacts,
    shielded,
    start_premium_call,
)

if TYPE_CHECKING:
    from openai._legacy_response import HttpxBinaryResponseContent
    from openai.types import ImagesResponse
    from openai.types.audio import Transcription, TranscriptionVerbose

    from .openai import EnlittOpenAI

MediaKind = Literal["image", "speech", "transcription"]


@dataclass(frozen=True)
class OpenAIPremiumMediaPriceContext:
    """What a media price function receives when the call ends completed or canceled.

    A price function never runs for a failed call. The context never leaves the business's
    process.

    Attributes:
        kind: Which method ran: ``"image"``, ``"speech"``, or ``"transcription"``.
        status: ``"completed"`` or ``"canceled"``.
        request: The call's arguments (without ``enlitt`` and ``timeout``), read-only.
        started_at: When the provider call started.
        ended_at: When it returned, failed, or was canceled.
        duration_ms: ``ended_at - started_at`` in milliseconds.
        effective_max_charge_nano_usd: The most the report can charge; every price is
            lowered to it.
        response: The ``ImagesResponse`` or the transcription result, on a completed image
            or transcription call. Always ``None`` for speech, so pricing cannot consume the
            audio body, and ``None`` on cancellation.
        characters: Speech only. The number of Unicode code points in ``input`` (Python's
            ``len``). ``None`` for the other kinds.
    """

    kind: MediaKind
    status: Literal["completed", "canceled"]
    request: Mapping[str, Any]
    started_at: datetime
    ended_at: datetime
    duration_ms: int
    effective_max_charge_nano_usd: str
    response: Any = None
    characters: int | None = None


EnlittOpenAIMediaPrice = str | Callable[[OpenAIPremiumMediaPriceContext], "str | Awaitable[str]"]
"""A constant NANOUSD string, or a (possibly async) function of the media call's context."""


@dataclass(frozen=True, kw_only=True)
class EnlittMediaCallOptions:
    """The per-call ``enlitt=`` argument of the media methods.

    The fields and their rules are :class:`enlitt.openai.EnlittCallOptions`' premium ones.
    Only the price function's argument differs.

    Attributes:
        idempotency_key: The call ID itself (16 to 255 visible ASCII characters). Default:
            a fresh random ID per call.
        max_charge: NANOUSD declared at begin. Defaults to a constant ``price``. Required
            for a price function.
        price: A constant NANOUSD string or a function. Omitted charges ``"0"``.
        reporting_deadline_ms: How long the business needs before it reports.
        metadata: At most 16 string entries, sent with the begin request.
    """

    idempotency_key: str | None = None
    max_charge: str | None = None
    price: EnlittOpenAIMediaPrice | None = None
    reporting_deadline_ms: int | None = None
    metadata: Mapping[str, str] | None = None


# ---------------------------------------------------------------------------------------------
# The one media call
# ---------------------------------------------------------------------------------------------


def _model_of(body: Mapping[str, Any]) -> str:
    """The call's model. It labels the operation, so it is required on every media call."""
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise EnlittConfigurationError(
            "model is required: the premium operation's label must name the model, and the "
            "provider's default can change."
        )
    if model == ENLITT_STANDARD_MODEL:
        raise EnlittConfigurationError(
            f"{ENLITT_STANDARD_MODEL} is a language model; Enlitt has no standard image or "
            "audio model. Use your own provider model for premium media calls."
        )
    return model


def _image_usage(response: object) -> dict[str, int] | None:
    """An ``ImagesResponse``'s token counts, each only when it is a nonnegative integer."""
    usage = getattr(response, "usage", None)
    counts: dict[str, int] = {}
    for name in ("input_tokens", "output_tokens"):
        value = getattr(usage, name, None)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            counts[name] = value
    return counts or None


async def _run_media_call(
    owner: EnlittOpenAI,
    kind: MediaKind,
    method: Callable[..., Awaitable[Any]] | None,
    body: dict[str, Any],
    options: EnlittMediaCallOptions | None,
    timeout: float | None,
) -> Any:
    """Check, admit, run the provider ``method``, price, and report once.

    ``method`` is the matching ``AsyncOpenAI`` method, or ``None`` when this client was
    built without one.
    """
    # 1. Local refusals, before any request.
    if method is None:
        raise EnlittConfigurationError(
            "This client was built without an AsyncOpenAI client, and media calls are "
            "premium only: pass your AsyncOpenAI client to enlitt()."
        )
    model = _model_of(body)
    if kind != "speech" and body.get("stream") is True:
        raise EnlittConfigurationError(
            f"Streaming {kind}s cannot be accounted through Enlitt; omit stream=True."
        )
    characters: int | None = None
    if kind == "speech":
        text = body.get("input")
        if not isinstance(text, str):
            raise EnlittConfigurationError("audio.speech.create needs a string input.")
        characters = len(text)  # code points, so an emoji counts as one
    seconds = _check_timeout(timeout)
    resolved = read_call_options(options, "premium", options_type=EnlittMediaCallOptions)
    assert resolved.max_charge is not None  # premium mode always resolves a maximum

    # 2. Admission. A refusal raises here and the provider is never called.
    call = await start_premium_call(
        owner.internal_client,
        PremiumChargeRequest(
            max_charge=resolved.max_charge,
            provider=PremiumProvider(id=PROVIDER_ID, model=model),
            call_id=resolved.call_id,
            reporting_deadline_ms=resolved.reporting_deadline_ms,
            metadata=resolved.metadata,
        ),
    )
    settlement = _MediaSettlement(
        owner, call, kind, cast("EnlittOpenAIMediaPrice | None", resolved.price), body, characters
    )

    # 3. The business's own provider call. Its result and errors pass through by identity.
    provider_args = dict(body)
    if seconds is not None:
        provider_args["timeout"] = seconds
    try:
        result = await method(**provider_args)
    except asyncio.CancelledError:
        await shielded(settlement.settle("canceled"))
        raise
    except BaseException:
        await shielded(settlement.settle("failed"))
        raise

    # 4. Price and report.
    await settlement.settle("completed", result)
    return result


class _MediaSettlement:
    """The timing and price of one media call, settled exactly once."""

    def __init__(
        self,
        owner: EnlittOpenAI,
        call: PremiumCall,
        kind: MediaKind,
        price: EnlittOpenAIMediaPrice | None,
        body: Mapping[str, Any],
        characters: int | None,
    ) -> None:
        self._owner = owner
        self._call = call
        self._kind = kind
        self._price = price
        # A copy, so a caller mutating its own dict later cannot change what pricing sees.
        self._request = MappingProxyType(dict(body))
        self._characters = characters
        self._started_at = datetime.now(timezone.utc)
        self._started = time.monotonic()

    async def settle(
        self, status: Literal["completed", "failed", "canceled"], result: object = None
    ) -> None:
        """Record the safe facts, evaluate the price (never for ``failed``), and report."""
        if self._call.settled:
            return
        ended_at = datetime.now(timezone.utc)
        elapsed = time.monotonic() - self._started
        # Only timing, and an image response's token counts, are ever reported.
        self._call.handle.describe(
            PremiumTerminalFacts(
                usage=cast(Any, _image_usage(result)) if self._kind == "image" else None,
                timing={
                    "started_at": _rfc3339(self._started_at),
                    "ended_at": _rfc3339(ended_at),
                },
            )
        )
        if status != "failed":
            await self._charge(status, result, ended_at, elapsed)
        await self._call.settle(status)

    async def _charge(
        self,
        status: Literal["completed", "canceled"],
        result: object,
        ended_at: datetime,
        elapsed: float,
    ) -> None:
        """Charge the constant, or run the price function once. A bad function charges 0."""
        price = self._price
        if price is None:
            return
        if isinstance(price, str):
            self._call.charge(price)
            return
        context = OpenAIPremiumMediaPriceContext(
            kind=self._kind,
            status=status,
            request=self._request,
            started_at=self._started_at,
            ended_at=ended_at,
            duration_ms=round(elapsed * 1000),
            effective_max_charge_nano_usd=self._call.handle.effective_max_charge_nano_usd,
            # Speech never carries its response: the audio body is the caller's to read.
            response=result if status == "completed" and self._kind != "speech" else None,
            characters=self._characters,
        )
        try:
            amount = price(context)
            if inspect.isawaitable(amount):
                amount = await amount
            self._call.charge(amount)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._call.charge("0")
            handler = self._owner.internal_client.on_terminal_report_error
            if handler is not None:
                error = EnlittConfigurationError(
                    "The price function failed or returned an invalid amount "
                    f"({type(exc).__name__}); the call was charged 0."
                )
                with contextlib.suppress(Exception):
                    handler(error)


# ---------------------------------------------------------------------------------------------
# The namespaces on EnlittOpenAI
# ---------------------------------------------------------------------------------------------


def _provider_method(owner: EnlittOpenAI, *path: str) -> Callable[..., Awaitable[Any]] | None:
    """``owner.provider.<path>``, or ``None`` when the client has no provider."""
    target: Any = owner.provider
    if target is None:
        return None
    for name in path:
        target = getattr(target, name)
    return cast("Callable[..., Awaitable[Any]]", target)


class Images:
    """The ``images`` namespace. Its only method is :meth:`generate`."""

    def __init__(self, owner: EnlittOpenAI) -> None:
        self._owner = owner

    async def generate(
        self,
        *,
        enlitt: EnlittMediaCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> ImagesResponse:
        """Generate images with the business's own client, as one premium operation.

        Args:
            enlitt: Enlitt's per-call options. Never forwarded to the provider.
            timeout: Seconds, forwarded to the OpenAI client.
            **body: The ``AsyncOpenAI.images.generate`` arguments. ``model`` is required,
                and ``stream=True`` is refused.

        Returns:
            The provider's ``openai.types.ImagesResponse``, by identity.
        """
        method = _provider_method(self._owner, "images", "generate")
        result = await _run_media_call(self._owner, "image", method, body, enlitt, timeout)
        return cast("ImagesResponse", result)


class _Speech:
    """The ``audio.speech`` namespace."""

    def __init__(self, owner: EnlittOpenAI) -> None:
        self._owner = owner

    async def create(
        self,
        *,
        enlitt: EnlittMediaCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> HttpxBinaryResponseContent:
        """Turn text into speech with the business's own client, as one premium operation.

        Args:
            enlitt: Enlitt's per-call options. Never forwarded to the provider.
            timeout: Seconds, forwarded to the OpenAI client.
            **body: The ``AsyncOpenAI.audio.speech.create`` arguments. ``model`` and a
                string ``input`` are required.

        Returns:
            The provider's ``HttpxBinaryResponseContent``, by identity. The adapter never
            reads its body.
        """
        method = _provider_method(self._owner, "audio", "speech", "create")
        result = await _run_media_call(self._owner, "speech", method, body, enlitt, timeout)
        return cast("HttpxBinaryResponseContent", result)


class _Transcriptions:
    """The ``audio.transcriptions`` namespace."""

    def __init__(self, owner: EnlittOpenAI) -> None:
        self._owner = owner

    async def create(
        self,
        *,
        enlitt: EnlittMediaCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> Transcription | TranscriptionVerbose | str:
        """Transcribe audio with the business's own client, as one premium operation.

        Args:
            enlitt: Enlitt's per-call options. Never forwarded to the provider.
            timeout: Seconds, forwarded to the OpenAI client.
            **body: The ``AsyncOpenAI.audio.transcriptions.create`` arguments. ``model``
                is required, and ``stream=True`` is refused.

        Returns:
            The provider's ``Transcription``, ``TranscriptionVerbose``, or ``str``, by
            identity.
        """
        method = _provider_method(self._owner, "audio", "transcriptions", "create")
        result = await _run_media_call(self._owner, "transcription", method, body, enlitt, timeout)
        return cast("Transcription | TranscriptionVerbose | str", result)


class Audio:
    """The ``audio`` namespace: ``speech`` and ``transcriptions``."""

    def __init__(self, owner: EnlittOpenAI) -> None:
        self.speech = _Speech(owner)
        self.transcriptions = _Transcriptions(owner)
