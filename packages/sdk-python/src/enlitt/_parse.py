"""Hand-written tolerant response parsers (``PROTOCOLS.md`` "Strict requests, tolerant responses").

A small declarative DSL builds one parser per wire shape. Tolerant mode differs from strict in
exactly four ways, all implemented here:

1. unknown fields are dropped at every depth;
2. an unknown member of a closed set reads as ``"other"``;
3. an unknown output item, content part or stream event becomes ``{"unknown": True, "type": ...}``
   (a stream event also keeps its ``sequence_number``);
4. identity strings (``object``, ``model``) stay exact.

Everything else is identical to strict: required fields stay required and a wrong-typed field
makes the whole body malformed (:class:`MalformedResponse`).

Parsers return plain ``dict`` values so fixtures can be compared by deep equality.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, cast

from . import _contract
from .errors import EnlittError, is_canonical_nano_usd

Parser = Callable[[object, str], Any]


class MalformedResponse(Exception):
    """A body, event, or envelope that does not match its shape."""


def to_enlitt_error(error: MalformedResponse, what: str) -> EnlittError:
    """Turn a parse failure into the SDK's ``malformed_response`` error (no body content)."""
    return EnlittError(f"Enlitt sent a malformed {what}.", code="malformed_response")


def _fail(path: str, why: str) -> MalformedResponse:
    return MalformedResponse(f"{path or '<root>'}: {why}")


def string(*, min_len: int = 0, max_len: int | None = None) -> Parser:
    """A string with optional length bounds."""

    def parse(value: object, path: str) -> str:
        if not isinstance(value, str):
            raise _fail(path, "expected a string")
        if len(value) < min_len or (max_len is not None and len(value) > max_len):
            raise _fail(path, "string length out of bounds")
        return value

    return parse


def integer(*, minimum: int | None = None, maximum: int | None = None) -> Parser:
    """A JSON integer (booleans are not integers)."""

    def parse(value: object, path: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise _fail(path, "expected an integer")
        if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
            raise _fail(path, "integer out of range")
        return value

    return parse


def boolean() -> Parser:
    """A JSON boolean."""

    def parse(value: object, path: str) -> bool:
        if not isinstance(value, bool):
            raise _fail(path, "expected a boolean")
        return value

    return parse


def nano_usd() -> Parser:
    """A canonical nonnegative NANOUSD integer string, kept exactly as received."""

    def parse(value: object, path: str) -> str:
        if not is_canonical_nano_usd(value):
            raise _fail(path, "expected a canonical NANOUSD string")
        assert isinstance(value, str)
        return value

    return parse


def literal(expected: str) -> Parser:
    """An identity string that must match exactly (``object``, ``model``, event ``type``)."""

    def parse(value: object, path: str) -> str:
        if value != expected:
            raise _fail(path, f"expected {expected!r}")
        return expected

    return parse


def closed_set(name: str) -> Parser:
    """A closed string set from the contract; an unknown member reads as ``"other"``."""
    members = set(_contract.CLOSED_SETS[name])

    def parse(value: object, path: str) -> str:
        if not isinstance(value, str):
            raise _fail(path, "expected a string")
        return value if value in members else _contract.UNKNOWN_ENUM_VALUE

    return parse


def nullable(inner: Parser) -> Parser:
    """``None`` or whatever ``inner`` accepts."""
    return lambda value, path: None if value is None else inner(value, path)


def any_value() -> Parser:
    """An open value passed through unchanged (metadata, JSON schema)."""
    return lambda value, path: value


def open_map() -> Parser:
    """An open string-keyed map whose keys are data; passed through unchanged."""

    def parse(value: object, path: str) -> dict[str, Any]:
        if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
            raise _fail(path, "expected an object")
        return dict(value)

    return parse


def array(item: Parser) -> Parser:
    """A list whose every element is parsed by ``item``."""

    def parse(value: object, path: str) -> list[Any]:
        if not isinstance(value, list):
            raise _fail(path, "expected an array")
        return [item(element, f"{path}[{i}]") for i, element in enumerate(value)]

    return parse


def obj(required: dict[str, Parser], optional: dict[str, Parser] | None = None) -> Parser:
    """An object with known fields; unknown keys are dropped, required keys must exist."""
    optional = optional or {}

    def parse(value: object, path: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise _fail(path, "expected an object")
        out: dict[str, Any] = {}
        for key, parser in required.items():
            if key not in value:
                raise _fail(f"{path}.{key}", "required field is missing")
            out[key] = parser(value[key], f"{path}.{key}")
        for key, parser in optional.items():
            if key in value:
                out[key] = parser(value[key], f"{path}.{key}")
        return out

    return parse


def variant(known: dict[str, Parser], *, keep: tuple[str, ...] = ()) -> Parser:
    """A tagged union on ``type``; an unknown tag becomes an unknown-variant marker.

    ``keep`` names extra fields copied onto the marker (a stream event keeps ``sequence_number``).
    """

    def parse(value: object, path: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise _fail(path, "expected an object")
        tag = value.get("type")
        if not isinstance(tag, str):
            raise _fail(f"{path}.type", "expected a string")
        parser = known.get(tag)
        if parser is not None:
            return cast("dict[str, Any]", parser(value, path))
        if len(tag) > 64:
            raise _fail(f"{path}.type", "unknown type is too long")
        marker: dict[str, Any] = {"unknown": True, "type": tag}
        for key in keep:
            if key not in value:
                raise _fail(f"{path}.{key}", "required field is missing")
            marker[key] = integer()(value[key], f"{path}.{key}")
        return marker

    return parse


def is_unknown_variant(value: object) -> bool:
    """True for the marker an unknown variant is parsed to."""
    return isinstance(value, dict) and value.get("unknown") is True


# ---------------------------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------------------------

_CONTENT_PART = variant(
    {
        "output_text": obj(
            {"type": literal("output_text"), "text": string()}, {"annotations": any_value()}
        ),
    }
)

_OUTPUT_ITEM = variant(
    {
        "message": obj(
            {
                "type": literal("message"),
                "id": string(),
                "role": literal("assistant"),
                "status": closed_set("response.output_item.status"),
                "content": array(_CONTENT_PART),
            }
        ),
        "function_call": obj(
            {
                "type": literal("function_call"),
                "id": string(),
                "call_id": string(),
                "name": string(),
                "arguments": string(),
                "status": closed_set("response.output_item.status"),
            }
        ),
    }
)

_USAGE = obj(
    {
        "input_tokens": integer(minimum=0),
        "output_tokens": integer(minimum=0),
        "total_tokens": integer(minimum=0),
    },
    {
        "input_tokens_details": obj({}, {"cached_tokens": integer(minimum=0)}),
        "output_tokens_details": obj({}, {"reasoning_tokens": integer(minimum=0)}),
    },
)

parse_create_response = obj(
    {
        "id": string(min_len=1),
        "object": literal("response"),
        "created_at": integer(),
        "status": closed_set("response.status"),
        "error": nullable(obj({"code": string(), "message": string()})),
        "incomplete_details": nullable(
            obj({"reason": closed_set("response.incomplete_details.reason")})
        ),
        "model": literal("enlitt-standard"),
        "output": array(_OUTPUT_ITEM),
        "metadata": open_map(),
    },
    {
        "completed_at": integer(),
        "output_text": string(),
        "usage": _USAGE,
    },
)
"""Tolerant parser for the non-streaming ``OpenAIResponse`` body."""


def _event(type_name: str, fields: dict[str, Parser]) -> Parser:
    return obj({"type": literal(type_name), "sequence_number": integer(minimum=0), **fields})


_ITEM_FIELDS = {"item_id": string(), "output_index": integer(minimum=0)}
_TEXT_FIELDS = {**_ITEM_FIELDS, "content_index": integer(minimum=0)}

parse_stream_event = variant(
    {
        **{
            name: _event(name, {"response": parse_create_response})
            for name in (
                "response.created",
                "response.in_progress",
                "response.completed",
                "response.incomplete",
                "response.failed",
            )
        },
        "response.output_item.added": _event(
            "response.output_item.added",
            {"output_index": integer(minimum=0), "item": _OUTPUT_ITEM},
        ),
        "response.output_item.done": _event(
            "response.output_item.done",
            {"output_index": integer(minimum=0), "item": _OUTPUT_ITEM},
        ),
        "response.content_part.added": _event(
            "response.content_part.added", {**_TEXT_FIELDS, "part": _CONTENT_PART}
        ),
        "response.content_part.done": _event(
            "response.content_part.done", {**_TEXT_FIELDS, "part": _CONTENT_PART}
        ),
        "response.output_text.delta": _event(
            "response.output_text.delta", {**_TEXT_FIELDS, "delta": string()}
        ),
        "response.output_text.done": _event(
            "response.output_text.done", {**_TEXT_FIELDS, "text": string()}
        ),
        "response.function_call_arguments.delta": _event(
            "response.function_call_arguments.delta", {**_ITEM_FIELDS, "delta": string()}
        ),
        "response.function_call_arguments.done": _event(
            "response.function_call_arguments.done", {**_ITEM_FIELDS, "arguments": string()}
        ),
    },
    keep=("sequence_number",),
)
"""Tolerant parser for one stream event's JSON data."""

parse_begin_response = obj(
    {
        "operation_id": string(min_len=1),
        "billing": closed_set("premium_operation.billing"),
        "report_terminal": boolean(),
        "effective_max_charge_nano_usd": nano_usd(),
        "reserved_nano_usd": nano_usd(),
        "terminal_deadline": string(min_len=1),
    }
)
"""Tolerant parser for the begin-operation response."""

parse_terminal_response = obj(
    {
        "operation_id": string(min_len=1),
        "status": closed_set("premium_terminal.status"),
        "idempotent_replay": boolean(),
        "settlement": obj(
            {
                "captured_nano_usd": nano_usd(),
                "released_nano_usd": nano_usd(),
                "business_earnings_nano_usd": nano_usd(),
            }
        ),
    }
)
"""Tolerant parser for the terminal-report response."""

_AVAILABILITY = obj(
    {"remaining_percent": integer(minimum=0, maximum=100), "limit_cap_nano_usd": nano_usd()}
)
parse_usage_response = obj({"standard": _AVAILABILITY, "premium": _AVAILABILITY})
"""Tolerant parser for ``GET /v1/enlitt/usage``."""

_SUBJECT = re.compile(r"^[A-Za-z0-9_-]{1,255}$")


def _subject(value: object, path: str) -> str:
    if not isinstance(value, str) or not _SUBJECT.match(value):
        raise _fail(path, "expected an opaque subject")
    return value


parse_exchange_response = obj(
    {"session_token": string(min_len=1, max_len=4096), "subject": _subject}
)
"""Tolerant parser for the authorization-code exchange response."""


def parse_body(parser: Parser, value: object, what: str) -> Any:
    """Run ``parser`` and raise the SDK's ``malformed_response`` error on failure."""
    try:
        return parser(value, "")
    except MalformedResponse as exc:
        raise to_enlitt_error(exc, what) from None
