"""The OpenAI adapter (``openai/client.ts``): ``responses.create`` over the Enlitt lifecycle.

The adapter is an interface over the same core as everything else. It contains no
authentication, retry, reservation or settlement logic of its own:

* ``model == ENLITT_STANDARD_MODEL`` is **standard** mode. The OpenAI-shaped request is mapped
  to Enlitt's standard request, sent through the shared transport, and the answer is turned
  back into the official ``openai`` package's ``Response`` / ``ResponseStreamEvent`` models.
  The optional OpenAI client is never touched.
* Any other model is **premium** mode. Enlitt admits the call first, the business's own
  ``AsyncOpenAI`` client runs it, and exactly one content-free report settles it. The
  provider's response and stream events are returned by identity.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import time
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from types import TracebackType
from typing import Any, Literal, TypeVar, cast, overload

import httpx
import openai
from openai import AsyncOpenAI
from openai.types import responses as _r
from openai.types.responses import Response, ResponseStreamEvent
from openai.types.responses.response import IncompleteDetails as _IncompleteDetails
from openai.types.responses.response_usage import (
    InputTokensDetails as _InputTokensDetails,
)
from openai.types.responses.response_usage import (
    OutputTokensDetails as _OutputTokensDetails,
)

from . import _parse, _transport
from ._sse import SseEvent, iter_sse_events
from ._transport import EnlittOptions, InternalEnlittClient
from ._validate import (
    validate_metadata,
    validate_nano_usd,
    validate_reporting_deadline_ms,
)
from .errors import (
    EnlittConfigurationError,
    EnlittError,
    normalize_enlitt_model_error,
)
from .premium import (
    PremiumCall,
    PremiumChargeRequest,
    PremiumProvider,
    PremiumTerminalFacts,
    shielded,
    start_premium_call,
)

T = TypeVar("T")

ENLITT_STANDARD_MODEL = "enlitt-standard"
"""The only model string that selects standard mode (Enlitt alone picks the routed model)."""

PROVIDER_ID = "openai"
"""The provider label every premium operation from this adapter carries."""

_TERMINAL_EVENTS = frozenset({"response.completed", "response.incomplete", "response.failed"})
_CONTENT_DELTA_EVENTS = frozenset(
    {"response.output_text.delta", "response.function_call_arguments.delta"}
)


# ---------------------------------------------------------------------------------------------
# Public option and price types
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class OpenAIPremiumPriceContext:
    """Everything the SDK knows when a premium call ends (and nothing about the user).

    Attributes:
        status: ``"completed"`` or ``"canceled"``; a price function never sees ``failed``.
        response: The provider's response for a non-streaming call.
        events: Every provider event in order, for a streaming call (collected only when the
            price is a function).
        usage: The terminal response's usage, when one supplied it.
        started_at: When the provider call started.
        ended_at: When it ended or was canceled.
        duration_ms: ``ended_at - started_at`` in milliseconds.
        time_to_first_token_ms: Present for a stream whose first content delta was observed.
        effective_max_charge_nano_usd: The most the report can charge.
    """

    status: Literal["completed", "canceled"]
    started_at: datetime
    ended_at: datetime
    duration_ms: int
    effective_max_charge_nano_usd: str
    response: Any = None
    events: tuple[Any, ...] | None = None
    usage: Any = None
    time_to_first_token_ms: int | None = None


EnlittOpenAIPrice = str | Callable[[OpenAIPremiumPriceContext], "str | Awaitable[str]"]
"""A constant NANOUSD string, or a (possibly async) function of the call's context."""


@dataclass(frozen=True, kw_only=True)
class EnlittCallOptions:
    """The per-call ``enlitt=`` argument of :meth:`EnlittOpenAI.responses.create`.

    Attributes:
        idempotency_key: The call ID (16 to 255 visible ASCII characters). Default: random.
        max_charge: Premium only. NANOUSD declared at begin. Defaults to a constant ``price``.
        price: Premium only. A constant or a function; omitted charges ``"0"``.
        reporting_deadline_ms: Premium only. How long the business needs before it reports.
        metadata: At most 16 string entries; merged over the request's own ``metadata`` in
            standard mode and sent with the begin request in premium mode.
    """

    idempotency_key: str | None = None
    max_charge: str | None = None
    price: EnlittOpenAIPrice | None = None
    reporting_deadline_ms: int | None = None
    metadata: Mapping[str, str] | None = None


def per_token(input: str, output: str) -> Callable[[OpenAIPremiumPriceContext], str]:
    """A price function: ``input * usage.input_tokens + output * usage.output_tokens``.

    Both rates are canonical NANOUSD-per-token strings. A missing usage counts as zero. Cached
    input and reasoning output are already inside those totals and are not charged twice.
    """
    input_rate = int(validate_nano_usd(input, "per_token input rate"))
    output_rate = int(validate_nano_usd(output, "per_token output rate"))

    def price(context: OpenAIPremiumPriceContext) -> str:
        usage = context.usage
        input_tokens = _count(getattr(usage, "input_tokens", None))
        output_tokens = _count(getattr(usage, "output_tokens", None))
        return str(input_rate * input_tokens + output_rate * output_tokens)

    return price


def _count(value: object) -> int:
    """A usage count, with anything absent or malformed read as zero."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


# ---------------------------------------------------------------------------------------------
# Reading the per-call options
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _ResolvedCall:
    """The validated per-call options, ready to use."""

    call_id: str | None
    max_charge: str | None
    price: EnlittOpenAIPrice | None
    reporting_deadline_ms: int | None
    metadata: dict[str, str] | None


def read_call_options(
    options: EnlittCallOptions | None, mode: Literal["standard", "premium"]
) -> _ResolvedCall:
    """Validate ``enlitt=`` for one mode. Every failure is an ``EnlittConfigurationError``."""
    if options is None:
        options = EnlittCallOptions()
    if not isinstance(options, EnlittCallOptions):
        raise EnlittConfigurationError("enlitt must be an EnlittCallOptions.")
    call_id = (
        _transport.validate_idempotency_key(options.idempotency_key)
        if options.idempotency_key is not None
        else None
    )
    metadata = validate_metadata(options.metadata)
    deadline = validate_reporting_deadline_ms(options.reporting_deadline_ms)
    if mode == "standard":
        for name, value in (
            ("max_charge", options.max_charge),
            ("price", options.price),
            ("reporting_deadline_ms", deadline),
        ):
            if value is not None:
                raise EnlittConfigurationError(
                    f"{name} is premium-only and cannot be used with {ENLITT_STANDARD_MODEL}."
                )
        return _ResolvedCall(call_id, None, None, None, metadata)

    price = options.price
    if price is not None and not isinstance(price, str) and not callable(price):
        raise EnlittConfigurationError("price must be a NANOUSD string or a function.")
    constant = validate_nano_usd(price, "price") if isinstance(price, str) else None
    max_charge = options.max_charge
    if max_charge is not None:
        max_charge = validate_nano_usd(max_charge, "max_charge")
    elif constant is not None:
        max_charge = constant
    else:
        raise EnlittConfigurationError(
            "A premium call needs max_charge unless price is a constant: a price function "
            "is only known after the provider has run, and the maximum must be known before."
        )
    if constant is not None and int(constant) > int(max_charge):
        raise EnlittConfigurationError("A constant price above max_charge could never be charged.")
    return _ResolvedCall(call_id, max_charge, price, deadline, metadata)


def _check_timeout(timeout: float | None) -> float | None:
    """A positive number of seconds, or ``None`` for no limit."""
    if timeout is None:
        return None
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
        raise EnlittConfigurationError("timeout must be a positive number of seconds.")
    return float(timeout)


# ---------------------------------------------------------------------------------------------
# Standard mode: OpenAI request -> EnlittStandardRequest
# ---------------------------------------------------------------------------------------------

_STANDARD_FIELDS = frozenset(
    {
        "model",
        "input",
        "instructions",
        "max_output_tokens",
        "tools",
        "tool_choice",
        "metadata",
        "stream",
        "background",
    }
)


def _unsupported(what: str) -> EnlittConfigurationError:
    return EnlittConfigurationError(
        f"{what} is not supported with {ENLITT_STANDARD_MODEL}. Only text and image input, "
        "function tools, max_output_tokens, metadata and stream are."
    )


def _text_of(content: object, what: str, part_types: tuple[str, ...]) -> str:
    """Flatten message content that must be text only (system and assistant messages)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts: list[str] = []
        for part in content:
            if not isinstance(part, Mapping) or part.get("type") not in part_types:
                raise _unsupported(f"A non-text part in {what} content")
            texts.append(str(part.get("text", "")))
        return "".join(texts)
    raise _unsupported(f"{what} content of this shape")


def _image_source(url: object) -> dict[str, Any]:
    """An ``input_image`` URL: an absolute https URL or a base64 PNG/JPEG data URL."""
    if not isinstance(url, str) or not url:
        raise _unsupported("An input_image without an image_url (file ids)")
    if url.startswith("data:"):
        header, _, data = url.partition(",")
        media_type, _, encoding = header[5:].partition(";")
        if encoding != "base64" or media_type not in ("image/png", "image/jpeg") or not data:
            raise _unsupported("A data URL that is not a base64 PNG or JPEG")
        return {"type": "base64", "media_type": media_type, "data": data}
    if not url.startswith("https://"):
        raise _unsupported("An image URL that is not an absolute https URL")
    return {"type": "url", "url": url}


def _user_parts(content: object) -> list[dict[str, Any]]:
    """User content as ordered standard parts."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        raise _unsupported("User content of this shape")
    parts: list[dict[str, Any]] = []
    for part in content:
        kind = part.get("type") if isinstance(part, Mapping) else None
        if kind == "input_text":
            parts.append({"type": "text", "text": part.get("text", "")})
        elif kind == "input_image":
            parts.append({"type": "image", "source": _image_source(part.get("image_url"))})
        else:
            raise _unsupported(f"A {kind!r} input part")
    return parts


def _map_input(value: object) -> list[dict[str, Any]]:
    """The ``input`` field as standard messages."""
    if isinstance(value, str):
        return [{"role": "user", "content": [{"type": "text", "text": value}]}]
    if not isinstance(value, list):
        raise _unsupported("input of this shape")
    messages: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            raise _unsupported("An input item of this shape")
        kind = item.get("type", "message")
        if kind == "message":
            role = item.get("role")
            content = item.get("content")
            if role == "user":
                messages.append({"role": "user", "content": _user_parts(content)})
            elif role in ("system", "developer"):
                text = _text_of(content, "system", ("input_text",))
                messages.append({"role": "system", "content": text})
            elif role == "assistant":
                text = _text_of(content, "assistant", ("output_text", "input_text"))
                messages.append({"role": "assistant", "content": text})
            else:
                raise _unsupported(f"A message with role {role!r}")
        elif kind == "function_call":
            call = {
                "id": item.get("call_id"),
                "name": item.get("name"),
                "arguments": item.get("arguments"),
            }
            previous = messages[-1] if messages else None
            if previous is not None and previous["role"] == "assistant":
                previous.setdefault("tool_calls", []).append(call)
            else:
                messages.append({"role": "assistant", "tool_calls": [call]})
        elif kind == "function_call_output":
            output = item.get("output")
            if not isinstance(output, str):
                raise _unsupported("A function_call_output that is not a string")
            messages.append(
                {"role": "tool", "tool_call_id": item.get("call_id"), "content": output}
            )
        else:
            raise _unsupported(f"An input item of type {kind!r}")
    return messages


def _map_tools(tools: object) -> list[dict[str, Any]]:
    """Function tools only; ``strict`` structured-output enforcement is not a guarantee."""
    if not isinstance(tools, list):
        raise _unsupported("tools of this shape")
    mapped: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, Mapping) or tool.get("type") != "function":
            raise _unsupported("A tool that is not a function tool")
        if tool.get("strict") not in (None, False):
            raise _unsupported("Strict function schemas")
        entry: dict[str, Any] = {
            "name": tool.get("name"),
            "input_schema": tool.get("parameters") or {"type": "object"},
        }
        if tool.get("description") is not None:
            entry["description"] = tool["description"]
        mapped.append(entry)
    return mapped


def build_standard_request(
    body: Mapping[str, Any], *, stream: bool, extra_metadata: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Map an OpenAI ``responses.create`` body to an ``EnlittStandardRequest``.

    Fields whose value is ``None`` count as absent. Anything outside the standard capability
    set raises ``EnlittConfigurationError`` before any request.
    """
    present = {key: value for key, value in body.items() if value is not None}
    for key in present:
        if key not in _STANDARD_FIELDS:
            raise _unsupported(f"The {key!r} field")
    if present.get("background"):
        raise _unsupported("Background responses")
    if present.get("tool_choice", "auto") != "auto":
        raise _unsupported("A tool_choice other than 'auto'")
    if "input" not in present:
        raise EnlittConfigurationError("input is required.")

    messages = _map_input(present["input"])
    if present.get("instructions") is not None:
        instructions = present["instructions"]
        if not isinstance(instructions, str):
            raise _unsupported("instructions that are not a string")
        messages.insert(0, {"role": "system", "content": instructions})

    request: dict[str, Any] = {"model": ENLITT_STANDARD_MODEL, "messages": messages}
    if "tools" in present:
        request["tools"] = _map_tools(present["tools"])
    if "max_output_tokens" in present:
        limit = present["max_output_tokens"]
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise EnlittConfigurationError("max_output_tokens must be a positive integer.")
        request["max_output_tokens"] = limit
    metadata = {**(validate_metadata(present.get("metadata")) or {}), **(extra_metadata or {})}
    if metadata:
        request["metadata"] = validate_metadata(metadata)
    if stream:
        request["stream"] = True
    return request


# ---------------------------------------------------------------------------------------------
# Standard mode: normalized response -> openai models
# ---------------------------------------------------------------------------------------------


def _build_part(part: Mapping[str, Any]) -> Any:
    return _r.ResponseOutputText.model_construct(
        type="output_text", text=part["text"], annotations=list(part.get("annotations") or [])
    )


def _build_item(item: Mapping[str, Any]) -> Any:
    """One normalized output item as the openai model, or ``None`` for an unknown variant."""
    if _parse.is_unknown_variant(item):
        return None
    if item["type"] == "message":
        parts = [_build_part(p) for p in item["content"] if not _parse.is_unknown_variant(p)]
        return _r.ResponseOutputMessage.model_construct(
            id=item["id"], type="message", role="assistant", status=item["status"], content=parts
        )
    return _r.ResponseFunctionToolCall.model_construct(
        id=item["id"],
        type="function_call",
        call_id=item["call_id"],
        name=item["name"],
        arguments=item["arguments"],
        status=item["status"],
    )


def _build_usage(usage: Mapping[str, Any]) -> Any:
    details_in = usage.get("input_tokens_details") or {}
    details_out = usage.get("output_tokens_details") or {}
    return _r.ResponseUsage.model_construct(
        input_tokens=usage["input_tokens"],
        output_tokens=usage["output_tokens"],
        total_tokens=usage["total_tokens"],
        input_tokens_details=_InputTokensDetails.model_construct(
            cached_tokens=details_in.get("cached_tokens", 0)
        ),
        output_tokens_details=_OutputTokensDetails.model_construct(
            reasoning_tokens=details_out.get("reasoning_tokens", 0)
        ),
    )


def build_openai_response(parsed: Mapping[str, Any]) -> Response:
    """The tolerant-parsed normalized response as the official ``Response`` model.

    Built with ``model_construct`` so a field a newer server adds can never raise, and the
    routed provider is never exposed.
    """
    fields: dict[str, Any] = {
        "id": parsed["id"],
        "object": "response",
        "created_at": float(parsed["created_at"]),
        "status": parsed["status"],
        "model": parsed["model"],
        "output": [i for i in map(_build_item, parsed["output"]) if i is not None],
        "metadata": dict(parsed["metadata"]),
        "error": (
            _r.ResponseError.model_construct(**parsed["error"])
            if parsed["error"] is not None
            else None
        ),
        "incomplete_details": (
            _IncompleteDetails.model_construct(reason=parsed["incomplete_details"]["reason"])
            if parsed["incomplete_details"] is not None
            else None
        ),
        # Required by the model, meaningless for a stateless standard call.
        "instructions": None,
        "parallel_tool_calls": False,
        "temperature": None,
        "tool_choice": "auto",
        "tools": [],
        "top_p": None,
    }
    if "completed_at" in parsed:
        fields["completed_at"] = float(parsed["completed_at"])
    if "usage" in parsed:
        fields["usage"] = _build_usage(parsed["usage"])
    return Response.model_construct(**fields)


_RESPONSE_EVENTS: dict[str, Any] = {
    "response.created": _r.ResponseCreatedEvent,
    "response.in_progress": _r.ResponseInProgressEvent,
    "response.completed": _r.ResponseCompletedEvent,
    "response.incomplete": _r.ResponseIncompleteEvent,
    "response.failed": _r.ResponseFailedEvent,
}


def build_openai_event(parsed: Mapping[str, Any], names: dict[str, str]) -> Any:
    """One normalized stream event as the openai event model.

    ``names`` remembers each function call's name by item ID, because the openai
    arguments-done event carries a name the Enlitt wire event does not.
    """
    kind = parsed["type"]
    common = {"type": kind, "sequence_number": parsed["sequence_number"]}
    response_event = _RESPONSE_EVENTS.get(kind)
    if response_event is not None:
        return response_event.model_construct(
            response=build_openai_response(parsed["response"]), **common
        )
    if kind in ("response.output_item.added", "response.output_item.done"):
        item = _build_item(parsed["item"])
        if parsed["item"].get("type") == "function_call":
            names[parsed["item"]["id"]] = parsed["item"]["name"]
        event = (
            _r.ResponseOutputItemAddedEvent
            if kind.endswith("added")
            else _r.ResponseOutputItemDoneEvent
        )
        return event.model_construct(output_index=parsed["output_index"], item=item, **common)
    if kind in ("response.content_part.added", "response.content_part.done"):
        part_event = (
            _r.ResponseContentPartAddedEvent
            if kind.endswith("added")
            else _r.ResponseContentPartDoneEvent
        )
        return part_event.model_construct(
            item_id=parsed["item_id"],
            output_index=parsed["output_index"],
            content_index=parsed["content_index"],
            part=_build_part(parsed["part"]),
            **common,
        )
    if kind == "response.output_text.delta":
        return _r.ResponseTextDeltaEvent.model_construct(
            item_id=parsed["item_id"],
            output_index=parsed["output_index"],
            content_index=parsed["content_index"],
            delta=parsed["delta"],
            logprobs=[],
            **common,
        )
    if kind == "response.output_text.done":
        return _r.ResponseTextDoneEvent.model_construct(
            item_id=parsed["item_id"],
            output_index=parsed["output_index"],
            content_index=parsed["content_index"],
            text=parsed["text"],
            logprobs=[],
            **common,
        )
    if kind == "response.function_call_arguments.delta":
        return _r.ResponseFunctionCallArgumentsDeltaEvent.model_construct(
            item_id=parsed["item_id"],
            output_index=parsed["output_index"],
            delta=parsed["delta"],
            **common,
        )
    return _r.ResponseFunctionCallArgumentsDoneEvent.model_construct(
        item_id=parsed["item_id"],
        output_index=parsed["output_index"],
        arguments=parsed["arguments"],
        name=names.get(parsed["item_id"], ""),
        **common,
    )


# ---------------------------------------------------------------------------------------------
# Standard mode: the stream mapper
# ---------------------------------------------------------------------------------------------


def _malformed(why: str) -> EnlittError:
    return EnlittError(f"Enlitt sent a malformed stream: {why}.", code="malformed_response")


async def map_standard_stream(source: AsyncIterator[SseEvent]) -> AsyncIterator[dict[str, Any]]:
    """Validate the stream's sequencing and yield each recognized event, normalized.

    * ``sequence_number`` starts at 0 and rises by exactly one per event.
    * An identical repeat of the last event is dropped; a conflicting one is malformed.
    * An unknown event type is skipped, but its sequence number still counts.
    * Exactly one terminal event ends the stream; data after it, or no terminal event at all,
      is malformed. So is anything that is not JSON.
    """
    last_sequence = -1
    last_raw: object = None
    terminal = False
    async for sse in source:
        try:
            raw = json.loads(sse.data)
        except ValueError:
            raise _malformed("an event was not JSON") from None
        parsed = _parse.parse_body(_parse.parse_stream_event, raw, "stream event")
        sequence = parsed["sequence_number"]
        if sequence == last_sequence:
            if raw == last_raw:
                continue
            raise _malformed("a repeated sequence number carried different data")
        if terminal:
            raise _malformed("data followed the terminal event")
        if sequence != last_sequence + 1:
            raise _malformed("sequence numbers had a gap or went backwards")
        last_sequence, last_raw = sequence, raw
        if _parse.is_unknown_variant(parsed):
            continue
        terminal = parsed["type"] in _TERMINAL_EVENTS
        yield parsed
    if not terminal:
        raise _malformed("it ended without a terminal event")


# ---------------------------------------------------------------------------------------------
# Streams returned to the caller
# ---------------------------------------------------------------------------------------------


class EnlittOpenAIStream:
    """An ``async for``-iterable of ``ResponseStreamEvent`` with an explicit ``aclose()``.

    It promises only ``async for`` and ``async with``; none of the official SDK's
    ``AsyncStream`` helpers.
    """

    def __aiter__(self) -> EnlittOpenAIStream:
        return self

    async def __anext__(self) -> ResponseStreamEvent:
        raise NotImplementedError

    async def aclose(self) -> None:
        """Stop the stream early and release its connection."""
        raise NotImplementedError

    async def __aenter__(self) -> EnlittOpenAIStream:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()


class _StandardStream(EnlittOpenAIStream):
    """A standard-mode stream: SSE frames -> validated events -> openai events."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self._events = self._run()

    async def _run(self) -> AsyncGenerator[Any, None]:
        names: dict[str, str] = {}
        try:
            frames = iter_sse_events(self._response.aiter_bytes())
            async for parsed in map_standard_stream(frames):
                yield build_openai_event(parsed, names)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise normalize_enlitt_model_error(exc) from None
        finally:
            await self._response.aclose()

    async def __anext__(self) -> ResponseStreamEvent:
        return cast(ResponseStreamEvent, await self._events.__anext__())

    async def aclose(self) -> None:
        await self._events.aclose()
        await self._response.aclose()


# ---------------------------------------------------------------------------------------------
# Premium mode
# ---------------------------------------------------------------------------------------------


def _rfc3339(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _error_category(
    error: BaseException,
) -> Literal["provider", "timeout", "network", "invalid_request", "canceled", "unknown"]:
    """A coarse, content-free category for the failure the provider raised."""
    if isinstance(error, asyncio.CancelledError):
        return "canceled"
    if isinstance(error, (TimeoutError, openai.APITimeoutError)):
        return "timeout"
    if isinstance(error, openai.APIConnectionError):
        return "network"
    if isinstance(error, openai.APIStatusError):
        return "invalid_request" if error.status_code in (400, 422) else "provider"
    if isinstance(error, openai.APIError):
        return "provider"
    return "unknown"


def _finish_reason(status: str, response: object) -> str | None:
    """The report's finish reason from a terminal response."""
    if status == "failed":
        return "error"
    if status == "incomplete":
        reason = getattr(getattr(response, "incomplete_details", None), "reason", None)
        return {"max_output_tokens": "length", "content_filter": "content-filter"}.get(
            reason or "", "other"
        )
    if status == "completed":
        items = getattr(response, "output", None) or []
        return (
            "tool-calls"
            if any(getattr(i, "type", None) == "function_call" for i in items)
            else "stop"
        )
    return None


def _usage_facts(usage: object) -> dict[str, int]:
    """Token counts as report facts. Absent or malformed counts are omitted."""
    facts: dict[str, int] = {}
    for name, value in (
        ("input_tokens", getattr(usage, "input_tokens", None)),
        ("output_tokens", getattr(usage, "output_tokens", None)),
        (
            "cached_input_tokens",
            getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", None),
        ),
        (
            "reasoning_tokens",
            getattr(getattr(usage, "output_tokens_details", None), "reasoning_tokens", None),
        ),
    ):
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            facts[name] = value
    return facts


class _PremiumRun:
    """One premium provider call: what it observed and how it settles."""

    def __init__(
        self,
        client: InternalEnlittClient,
        call: PremiumCall,
        price: EnlittOpenAIPrice | None,
        *,
        streaming: bool,
    ) -> None:
        self.client = client
        self.call = call
        self.price = price
        self.started_at = datetime.now(timezone.utc)
        self._started = time.monotonic()
        self._first_content: float | None = None
        # Events are only collected for a streaming call whose price is a function.
        self.events: list[Any] | None = [] if streaming and callable(price) else None
        self.output_started = False

    def observe(self, event: object) -> None:
        """Note one provider event (for time-to-first-token, delivery and the price context)."""
        if self.events is not None:
            self.events.append(event)
        if getattr(event, "type", None) in _CONTENT_DELTA_EVENTS and self._first_content is None:
            self._first_content = time.monotonic()
            self.output_started = True

    async def settle(
        self,
        status: Literal["completed", "failed", "canceled"],
        *,
        response: object = None,
        error: BaseException | None = None,
    ) -> None:
        """Price, describe and report. Exactly once; a second call does nothing."""
        if self.call.settled:
            return
        ended = datetime.now(timezone.utc)
        elapsed = time.monotonic() - self._started
        usage = getattr(response, "usage", None)
        wire_status = getattr(response, "status", status)
        self._describe(status, response, usage, ended, wire_status=str(wire_status), error=error)
        if status != "failed":
            await self._price(
                status,
                response,
                usage,
                ended,
                elapsed,
            )
        await self.call.settle(status)

    def _describe(
        self,
        status: str,
        response: object,
        usage: object,
        ended: datetime,
        *,
        wire_status: str,
        error: BaseException | None,
    ) -> None:
        """Record the safe facts. A fact that fails validation is dropped, never fatal."""
        facts = PremiumTerminalFacts(
            usage=cast(Any, _usage_facts(usage)) or None,
            finish_reason=_finish_reason(wire_status, response),
            provider_response_id=_response_id(response),
            delivery={
                "output_started": self.output_started or response is not None,
                "output_completed": status == "completed",
            },
            timing={"started_at": _rfc3339(self.started_at), "ended_at": _rfc3339(ended)},
            error_category=(
                (_error_category(error) if error is not None else "unknown")
                if status == "failed"
                else ("canceled" if status == "canceled" else None)
            ),
        )
        try:
            self.call.handle.describe(facts)
        except EnlittConfigurationError:
            self.call.handle.describe(
                PremiumTerminalFacts(
                    timing={"started_at": _rfc3339(self.started_at), "ended_at": _rfc3339(ended)}
                )
            )

    async def _price(
        self,
        status: Literal["completed", "canceled"],
        response: object,
        usage: object,
        ended: datetime,
        elapsed: float,
    ) -> None:
        """Charge the constant, or run the function once. A bad function charges zero."""
        price = self.price
        if price is None:
            return
        if isinstance(price, str):
            self.call.charge(price)
            return
        first = self._first_content
        context = OpenAIPremiumPriceContext(
            status=status,
            started_at=self.started_at,
            ended_at=ended,
            duration_ms=round(elapsed * 1000),
            effective_max_charge_nano_usd=self.call.handle.effective_max_charge_nano_usd,
            response=response if self.events is None else None,
            events=tuple(self.events) if self.events is not None else None,
            usage=usage,
            time_to_first_token_ms=(
                round((first - self._started) * 1000) if first is not None else None
            ),
        )
        try:
            amount = price(context)
            if inspect.isawaitable(amount):
                amount = await amount
            self.call.charge(amount)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.call.charge("0")
            handler = self.client.on_terminal_report_error
            if handler is not None:
                error = EnlittConfigurationError(
                    "The price function failed or returned an invalid amount "
                    f"({type(exc).__name__}); the call was charged 0."
                )
                with contextlib.suppress(Exception):
                    handler(error)


def _response_id(response: object) -> str | None:
    value = getattr(response, "id", None)
    return value if isinstance(value, str) and 1 <= len(value) <= 255 else None


class _PremiumStream(EnlittOpenAIStream):
    """The provider's stream, forwarded event by event, settled exactly once."""

    def __init__(self, run: _PremiumRun, source: Any) -> None:
        self._run = run
        self._source = source
        self._iterator = source.__aiter__()
        self._terminal_seen = False

    async def __anext__(self) -> ResponseStreamEvent:
        run = self._run
        try:
            event = await self._iterator.__anext__()
        except StopAsyncIteration:
            # Exhaustion without a recognized terminal event is a failure.
            await run.settle("failed")
            raise
        except asyncio.CancelledError:
            await shielded(run.settle("canceled"))
            raise
        except BaseException as exc:
            await run.settle("failed", error=exc)
            raise
        run.observe(event)
        kind = getattr(event, "type", None)
        if kind in _TERMINAL_EVENTS and not self._terminal_seen:
            self._terminal_seen = True
            response = getattr(event, "response", None)
            await run.settle(
                "failed" if kind == "response.failed" else "completed", response=response
            )
        return cast(ResponseStreamEvent, event)

    async def aclose(self) -> None:
        # Closing before a terminal event is a cancellation.
        await shielded(self._run.settle("canceled"))
        for name in ("aclose", "close"):
            closer = getattr(self._source, name, None)
            if closer is not None:
                result = closer()
                if inspect.isawaitable(result):
                    await result
                break


# ---------------------------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------------------------


class _Responses:
    """The ``responses`` namespace. Its only method is :meth:`create`."""

    def __init__(self, owner: EnlittOpenAI) -> None:
        self._owner = owner

    @overload
    async def create(
        self,
        *,
        stream: Literal[True],
        enlitt: EnlittCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> EnlittOpenAIStream: ...

    @overload
    async def create(
        self,
        *,
        stream: Literal[False] | None = None,
        enlitt: EnlittCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> Response: ...

    async def create(
        self,
        *,
        stream: bool | None = None,
        enlitt: EnlittCallOptions | None = None,
        timeout: float | None = None,
        **body: Any,
    ) -> Response | EnlittOpenAIStream:
        """Run one model call under Enlitt. See the module docstring for the two modes.

        Args:
            stream: ``True`` returns an async iterator of ``ResponseStreamEvent``.
            enlitt: Enlitt's per-call options. Never forwarded to the provider.
            timeout: Seconds. Premium forwards it to the OpenAI client; standard bounds the
                wait for Enlitt's answer (for a stream, the wait for the first response).
            **body: The ``openai`` ``responses.create`` arguments.
        """
        model = body.get("model")
        if not isinstance(model, str) or not model:
            raise EnlittConfigurationError("model is required.")
        seconds = _check_timeout(timeout)
        streaming = stream is True
        if model == ENLITT_STANDARD_MODEL:
            return await self._owner.standard(body, streaming, enlitt, seconds)
        return await self._owner.premium(body, streaming, enlitt, seconds)


class EnlittOpenAI:
    """The Responses-only OpenAI-shaped client returned by :func:`enlitt`."""

    def __init__(self, client: AsyncOpenAI | None, enlitt_client: InternalEnlittClient) -> None:
        self._provider = client
        self._client = enlitt_client
        self.responses = _Responses(self)

    def __repr__(self) -> str:
        return "EnlittOpenAI()"

    # -- standard ------------------------------------------------------------------------------

    async def standard(
        self,
        body: Mapping[str, Any],
        streaming: bool,
        options: EnlittCallOptions | None,
        timeout: float | None,
    ) -> Response | EnlittOpenAIStream:
        """Standard mode: map, send through the shared transport, convert back."""
        resolved = read_call_options(options, "standard")
        request = build_standard_request(body, stream=streaming, extra_metadata=resolved.metadata)
        call_id = resolved.call_id or _transport.generate_call_id()
        send = _transport.request_enlitt(
            self._client,
            path="/v1/responses",
            body=request,
            call_id=call_id,
            accept="text/event-stream" if streaming else "application/json",
        )
        if not streaming:
            return await _with_timeout(self._read_response(send), timeout)
        return _StandardStream(await _with_timeout(send, timeout))

    @staticmethod
    async def _read_response(send: Awaitable[httpx.Response]) -> Response:
        response = await send
        raw = await _transport.read_json_body(response)
        parsed = _parse.parse_body(_parse.parse_create_response, raw, "response")
        return build_openai_response(parsed)

    # -- premium -------------------------------------------------------------------------------

    async def premium(
        self,
        body: Mapping[str, Any],
        streaming: bool,
        options: EnlittCallOptions | None,
        timeout: float | None,
    ) -> Response | EnlittOpenAIStream:
        """Premium mode: admit, run the business's own client, report once."""
        if self._provider is None:
            raise EnlittConfigurationError(
                f"This client was built without an AsyncOpenAI client, so it can only run "
                f"{ENLITT_STANDARD_MODEL}."
            )
        if body.get("background"):
            raise EnlittConfigurationError(
                "Background responses cannot be accounted: the result is not known when the "
                "call returns."
            )
        resolved = read_call_options(options, "premium")
        assert resolved.max_charge is not None
        call = await start_premium_call(
            self._client,
            PremiumChargeRequest(
                max_charge=resolved.max_charge,
                provider=PremiumProvider(id=PROVIDER_ID, model=body["model"]),
                call_id=resolved.call_id,
                reporting_deadline_ms=resolved.reporting_deadline_ms,
                metadata=resolved.metadata,
            ),
        )
        run = _PremiumRun(self._client, call, resolved.price, streaming=streaming)
        provider_args = dict(body)
        if streaming:
            provider_args["stream"] = True
        if timeout is not None:
            provider_args["timeout"] = timeout
        try:
            result = await self._provider.responses.create(**provider_args)
        except asyncio.CancelledError:
            await shielded(run.settle("canceled"))
            raise
        except BaseException as exc:
            await shielded(run.settle("failed", error=exc))
            raise
        if streaming:
            return _PremiumStream(run, result)
        status = getattr(result, "status", None)
        outcome: Literal["completed", "failed", "canceled"] = (
            "failed" if status == "failed" else "canceled" if status == "cancelled" else "completed"
        )
        await run.settle(outcome, response=result)
        return cast(Response, result)


async def _with_timeout(awaitable: Awaitable[T], timeout: float | None) -> T:
    """Bound ``awaitable`` by ``timeout`` seconds, mapping expiry to ``transport_failed``."""
    if timeout is None:
        return await awaitable
    try:
        return await asyncio.wait_for(awaitable, timeout)
    except asyncio.TimeoutError:
        raise EnlittError("The request to Enlitt timed out.", code="transport_failed") from None


def enlitt(client: AsyncOpenAI | None = None, options: EnlittOptions | None = None) -> EnlittOpenAI:
    """Build the Enlitt-managed OpenAI client.

    Args:
        client: The business's own ``AsyncOpenAI`` client, needed only for premium models.
            A synchronous ``OpenAI`` client is refused. For standard-only use pass ``None``
            and give the options by keyword.
        options: The shared Enlitt construction options.

    Raises:
        EnlittConfigurationError: A bad client, a missing secret key, or a bad base URL.
    """
    candidate: object = client
    if isinstance(candidate, EnlittOptions):
        if options is not None:
            raise EnlittConfigurationError("Pass the Enlitt options once, not twice.")
        options, candidate = candidate, None
    if isinstance(candidate, openai.OpenAI):
        raise EnlittConfigurationError(
            "enlitt() needs an AsyncOpenAI client; the SDK is asyncio-only."
        )
    if candidate is not None and not callable(
        getattr(getattr(candidate, "responses", None), "create", None)
    ):
        raise EnlittConfigurationError("client must be an AsyncOpenAI client.")
    internal = _transport.create_internal_client(options)
    return EnlittOpenAI(cast("AsyncOpenAI | None", candidate), internal)
