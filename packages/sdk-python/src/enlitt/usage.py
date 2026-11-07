"""Advisory usage (``core/usage.ts``): how much of each credit type the signed-in user may use."""

from __future__ import annotations

from dataclasses import dataclass

from . import _parse, _transport
from ._transport import EnlittOptions


@dataclass(frozen=True)
class UsageAvailability:
    """One credit type's availability.

    Attributes:
        remaining_percent: Integer percentage (0 to 100) of what the user may still use.
        limit_cap_nano_usd: Canonical NANOUSD string, the most one call could be charged now.
    """

    remaining_percent: int
    limit_cap_nano_usd: str


@dataclass(frozen=True)
class UsageResult:
    """Availability for both credit types. Advisory: a concurrent call can consume capacity."""

    standard: UsageAvailability
    premium: UsageAvailability


async def usage(options: EnlittOptions | None = None) -> UsageResult:
    """Read ``GET /v1/enlitt/usage`` for the current session.

    Resolves the session exactly like a model call (ambient context, or ``options.session``).
    No conversion, caching, or admission inference is performed.
    """
    client = _transport.create_internal_client(options)
    response = await _transport.request_enlitt(client, path="/v1/enlitt/usage", method="GET")
    raw = await _transport.read_json_body(response)
    parsed = _parse.parse_body(_parse.parse_usage_response, raw, "usage response")
    return UsageResult(
        standard=UsageAvailability(**parsed["standard"]),
        premium=UsageAvailability(**parsed["premium"]),
    )
