"""Typed Enlitt errors and the error-response classifier (port of ``core/errors.ts``).

Every failure Enlitt originates is an :class:`EnlittError`. Which class a wire code maps to is
decided here; whether it is retryable, and whether it may carry an authorize URL, is read from
the vendored contract and never decided per instance.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

from . import _contract

LocalCode = Literal[
    "configuration_invalid", "transport_failed", "malformed_response", "request_canceled"
]
LOCAL_CODES: frozenset[str] = frozenset(
    {"configuration_invalid", "transport_failed", "malformed_response", "request_canceled"}
)
"""The only codes this module originates. Disjoint from the contract's wire codes."""

_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_CANONICAL_NANOUSD = re.compile(r"^(0|[1-9][0-9]*)$")
_MESSAGE_LIMIT = 512
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_BEARER = re.compile(r"Bearer\s+\S+", re.IGNORECASE)


def redact(text: str) -> str:
    """Strip anything that looks like a bearer credential from a message."""
    return _BEARER.sub("Bearer [redacted]", text)


def is_canonical_nano_usd(value: object) -> bool:
    """True for a canonical nonnegative base-10 integer string (no sign, fraction, or zeros)."""
    return (
        isinstance(value, str) and value.isascii() and _CANONICAL_NANOUSD.match(value) is not None
    )


class EnlittError(Exception):
    """Base class for every Enlitt-originated failure.

    Attributes:
        code: A contract wire code, a local code, the raw code of a newer server, or
            ``"unrecognized"``. Treat it as an open string and keep a default branch.
        provider_invoked: Always ``False`` for Enlitt errors; Enlitt refuses before a provider.
        retryable: Read from the contract record, never decided per instance.
        retry_after_ms: Only on the rate-limit error, converted from seconds once.
        request_id: The ``x-request-id`` response header, when present.
        authorize_url: Present only when the record permits it and the response carried one.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str,
        provider_invoked: bool = False,
        retryable: bool = False,
        retry_after_ms: int | None = None,
        request_id: str | None = None,
        authorize_url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.provider_invoked = provider_invoked
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.request_id = request_id
        self.authorize_url = authorize_url


class EnlittConfigurationError(EnlittError):
    """Missing or invalid SDK configuration, raised locally before any network call."""

    def __init__(self, message: str, *, provider_invoked: bool = False) -> None:
        super().__init__(message, code="configuration_invalid", provider_invoked=provider_invoked)


class EnlittLoginRequiredError(EnlittError):
    """No usable personal session (``personal_login_required``). Send the user through login."""


class EnlittLimitExceededError(EnlittError):
    """``spending_limit_exceeded``. ``limit_rule`` names the rule that refused, never an amount."""

    def __init__(self, message: str, *, limit_rule: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.limit_rule = limit_rule


class EnlittInsufficientCreditsError(EnlittError):
    """A credit refusal (both balance codes, or an unrecognized ``insufficient_credits_error``).

    ``admissible_max_charge_nano_usd`` is present only on a premium ``premium_balance_exhausted``.
    """

    def __init__(
        self, message: str, *, admissible_max_charge_nano_usd: str | None = None, **kwargs: Any
    ) -> None:
        super().__init__(message, **kwargs)
        self.admissible_max_charge_nano_usd = admissible_max_charge_nano_usd


class EnlittSubscriptionInactiveError(EnlittError):
    """``subscription_inactive``: no subscription period covers the current instant."""


class EnlittRateLimitError(EnlittError):
    """``rate_limit_exceeded``: the only retryable refusal; carries ``retry_after_ms``."""


class EnlittAuthenticationError(EnlittError):
    """``invalid_api_key``: the business key is missing, invalid, or revoked."""


class EnlittAuthorizationError(EnlittError):
    """``insufficient_permissions`` or ``premium_not_enabled``: a business configuration problem."""


_CLASS_BY_CODE: dict[str, type[EnlittError]] = {
    "personal_login_required": EnlittLoginRequiredError,
    "spending_limit_exceeded": EnlittLimitExceededError,
    "premium_balance_exhausted": EnlittInsufficientCreditsError,
    "standard_balance_exhausted": EnlittInsufficientCreditsError,
    "subscription_inactive": EnlittSubscriptionInactiveError,
    "rate_limit_exceeded": EnlittRateLimitError,
    "invalid_api_key": EnlittAuthenticationError,
    "insufficient_permissions": EnlittAuthorizationError,
    "premium_not_enabled": EnlittAuthorizationError,
}
"""Wire code to class. Any record code not listed here is the base class."""


def local_error(code: str, message: str) -> EnlittError:
    """Build a locally originated error (non-retryable, ``provider_invoked`` false)."""
    if code == "configuration_invalid":
        return EnlittConfigurationError(message)
    return EnlittError(message, code=code)


def _loopback_or_https(url: str) -> bool:
    """True for an absolute https URL, or an http URL on a loopback host."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    if parts.scheme == "https":
        return bool(host)
    return parts.scheme == "http" and host in _LOOPBACK_HOSTS


@dataclass(frozen=True)
class ClassifiedEnlittError:
    """Result of :func:`classify_enlitt_error_response` (``PROTOCOLS.md`` "Unknown error codes")."""

    code: str
    recognized: bool
    status: int
    type: str | None
    retryable: bool
    credit_refusal: bool
    message: str | None
    authorize_url: str | None = None
    admissible_max_charge_nano_usd: str | None = None
    limit_rule: str | None = None


def classify_enlitt_error_response(status: int, body: object) -> ClassifiedEnlittError | None:
    """Classify an error body; ``None`` when it is neither error envelope. Never raises."""
    envelope = _read_envelope(body)
    if envelope is None:
        return None
    raw_code, error_type, message, enlitt = envelope
    message = message[:_MESSAGE_LIMIT]
    record = _contract.ERROR_CODES.get(raw_code) if isinstance(raw_code, str) else None

    if record is not None and isinstance(raw_code, str):
        authorize_url = None
        if record["authorize_url"] == "allowed":
            authorize_url = _read_authorize_url(enlitt)
        admissible = None
        if record["admissible_max_charge"] == "allowed":
            value = enlitt.get("admissible_max_charge_nano_usd")
            if is_canonical_nano_usd(value):
                admissible = value
        limit_rule = None
        if record["limit_rule"] == "required":
            value = enlitt.get("limit_rule")
            if not (isinstance(value, str) and 0 < len(value) <= 64):
                return None  # a missing required rule makes the envelope invalid
            limit_rule = value
        return ClassifiedEnlittError(
            code=raw_code,
            recognized=True,
            status=status,
            type=error_type,
            retryable=bool(record["retryable"]),
            credit_refusal=record["type"] == "insufficient_credits_error",
            message=message,
            authorize_url=authorize_url,
            admissible_max_charge_nano_usd=admissible,
            limit_rule=limit_rule,
        )

    code = (
        raw_code
        if isinstance(raw_code, str) and _CODE_PATTERN.match(raw_code)
        else _contract.UNRECOGNIZED_ERROR_CODE
    )
    credit_refusal = error_type == "insufficient_credits_error"  # rule 1
    return ClassifiedEnlittError(
        code=code,
        recognized=False,
        status=status,
        type=error_type,
        retryable=(not credit_refusal) and 500 <= status <= 599,  # rules 2 and 3
        credit_refusal=credit_refusal,
        message=message,
        authorize_url=_read_authorize_url(enlitt) if credit_refusal else None,
    )


def _read_authorize_url(enlitt: dict[str, Any]) -> str | None:
    value = enlitt.get("authorize_url")
    return value if isinstance(value, str) and _loopback_or_https(value) else None


def _read_envelope(body: object) -> tuple[object, str | None, str, dict[str, Any]] | None:
    """Read the OpenAI-shaped envelope, else the dashboard envelope. ``None`` if neither."""
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    if not isinstance(error, dict):
        return None
    message = error.get("message")
    if not isinstance(message, str):
        return None
    enlitt = error.get("enlitt")
    enlitt_dict: dict[str, Any] = enlitt if isinstance(enlitt, dict) else {}
    error_type = error.get("type")
    if isinstance(error_type, str):
        return error.get("code"), error_type, message, enlitt_dict
    # Dashboard envelope: { error: { code, message }, request_id } with no type.
    if (
        "type" not in error
        and isinstance(error.get("code"), str)
        and isinstance(body.get("request_id"), str)
    ):
        return error["code"], None, message, enlitt_dict
    return None


def _unrecognized_message(c: ClassifiedEnlittError) -> str:
    text = (
        f'Enlitt returned error code "{c.code}" (HTTP {c.status}, type "{c.type or "none"}"), '
        "which this version of @enlitt/sdk does not recognize. "
        "Upgrade @enlitt/sdk to handle it."
    )
    return f"{text} {c.message}" if c.message else text


def parse_retry_after_ms(value: str | None) -> int | None:
    """Convert a ``Retry-After`` header (whole seconds) to milliseconds, else ``None``."""
    if value is None:
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():
        return int(value) * 1000
    return None


def enlitt_error_from_response(
    status: int,
    headers: dict[str, str],
    body: object,
    *,
    provider_invoked: bool = False,
) -> EnlittError:
    """Map one HTTP error response to exactly one error class.

    ``headers`` must have lowercase names. ``body`` is the parsed JSON (or the raw string when
    it was not JSON).
    """
    request_id = headers.get("x-request-id")
    classified = classify_enlitt_error_response(status, body)
    if classified is None:
        return EnlittError(
            f"Enlitt returned an unreadable error response (HTTP {status}).",
            code="malformed_response",
            provider_invoked=provider_invoked,
            request_id=request_id,
        )
    common: dict[str, Any] = {
        "code": classified.code,
        "provider_invoked": provider_invoked,
        "retryable": classified.retryable,
        "request_id": request_id,
        "authorize_url": classified.authorize_url,
    }
    if not classified.recognized:
        message = _unrecognized_message(classified)
        if classified.credit_refusal:
            return EnlittInsufficientCreditsError(redact(message), **common)
        return EnlittError(redact(message), **common)

    message = redact(
        classified.message or f"Enlitt refused the request ({classified.code}, HTTP {status})."
    )
    cls = _CLASS_BY_CODE.get(classified.code, EnlittError)
    if cls is EnlittRateLimitError:
        common["retry_after_ms"] = parse_retry_after_ms(headers.get("retry-after"))
        return EnlittRateLimitError(message, **common)
    if cls is EnlittLimitExceededError:
        return EnlittLimitExceededError(message, limit_rule=classified.limit_rule or "", **common)
    if cls is EnlittInsufficientCreditsError:
        return EnlittInsufficientCreditsError(
            message,
            admissible_max_charge_nano_usd=classified.admissible_max_charge_nano_usd,
            **common,
        )
    return cls(message, **common)


def normalize_enlitt_model_error(error: object, provider_invoked: bool = False) -> EnlittError:
    """Map any thrown failure to an :class:`EnlittError`.

    An existing ``EnlittError`` passes through; cancellation becomes ``request_canceled``; every
    other failure (including ``httpx`` errors) becomes ``transport_failed``. The original
    exception's text is not copied, so nothing it carried can leak.
    """
    if isinstance(error, EnlittError):
        return error
    if isinstance(error, asyncio.CancelledError):
        return EnlittError(
            "The Enlitt request was canceled.",
            code="request_canceled",
            provider_invoked=provider_invoked,
        )
    name = type(error).__name__
    return EnlittError(
        f"The request to Enlitt failed before a response arrived ({name}).",
        code="transport_failed",
        provider_invoked=provider_invoked,
    )
