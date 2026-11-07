"""Error classes, classification and redaction."""

from __future__ import annotations

import pytest

from enlitt import (
    EnlittAuthenticationError,
    EnlittAuthorizationError,
    EnlittError,
    EnlittInsufficientCreditsError,
    EnlittLimitExceededError,
    EnlittLoginRequiredError,
    EnlittRateLimitError,
    EnlittSubscriptionInactiveError,
)
from enlitt.errors import (
    enlitt_error_from_response,
    normalize_enlitt_model_error,
    parse_retry_after_ms,
    redact,
)


def envelope(code: str | None, message: str = "A refusal.") -> dict[str, object]:
    return {
        "error": {"message": message, "type": "invalid_request_error", "param": None, "code": code}
    }


def test_every_error_class_derives_from_enlitt_error() -> None:
    for cls in (
        EnlittAuthenticationError,
        EnlittAuthorizationError,
        EnlittInsufficientCreditsError,
        EnlittLimitExceededError,
        EnlittLoginRequiredError,
        EnlittRateLimitError,
        EnlittSubscriptionInactiveError,
    ):
        assert issubclass(cls, EnlittError)


def test_retry_after_seconds_become_milliseconds_once() -> None:
    assert parse_retry_after_ms("2") == 2000
    assert parse_retry_after_ms(None) is None
    assert parse_retry_after_ms("soon") is None


def test_recognized_code_picks_its_class_and_keeps_provider_flag_false() -> None:
    error = enlitt_error_from_response(
        429, {"retry-after": "3", "x-request-id": "req_1"}, envelope("rate_limit_exceeded")
    )
    assert isinstance(error, EnlittRateLimitError)
    assert error.retry_after_ms == 3000
    assert error.request_id == "req_1"
    assert error.provider_invoked is False
    assert error.retryable is True


def test_unreadable_body_is_malformed_response() -> None:
    error = enlitt_error_from_response(502, {}, "<html>bad gateway</html>")
    assert error.code == "malformed_response"


def test_bearer_credentials_are_redacted_from_messages() -> None:
    assert "abc123" not in redact("failed with Bearer abc123 attached")
    error = enlitt_error_from_response(
        500, {}, envelope("server_error", "upstream said Bearer topsecretvalue")
    )
    assert "topsecretvalue" not in str(error)


def test_existing_enlitt_error_passes_through_normalization() -> None:
    original = EnlittError("x", code="slow_down")
    assert normalize_enlitt_model_error(original) is original


def test_foreign_failure_becomes_transport_failed() -> None:
    error = normalize_enlitt_model_error(RuntimeError("socket closed"))
    assert error.code == "transport_failed"


@pytest.mark.parametrize("value", ["", None, 5])
def test_non_string_codes_do_not_crash_classification(value: object) -> None:
    error = enlitt_error_from_response(500, {}, envelope(value))  # type: ignore[arg-type]
    assert isinstance(error, EnlittError)
