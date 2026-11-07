"""Local validation of caller input (the Python equivalent of ``readEnlittCallOptions``)."""

from __future__ import annotations

from collections.abc import Mapping

from .errors import EnlittConfigurationError, is_canonical_nano_usd

MAX_METADATA_ENTRIES = 16
MAX_METADATA_KEY_LENGTH = 64
MAX_METADATA_VALUE_LENGTH = 512
RESERVED_METADATA_PREFIX = "enlitt_"
MAX_LABEL_LENGTH = 128
MAX_NANO_USD_DIGITS = 30
MAX_FACT_STRING_LENGTH = 255


def validate_nano_usd(value: object, what: str) -> str:
    """Require a canonical nonnegative NANOUSD integer string of at most 30 digits."""
    if not is_canonical_nano_usd(value) or len(str(value)) > MAX_NANO_USD_DIGITS:
        raise EnlittConfigurationError(
            f"{what} must be a canonical nonnegative NANOUSD integer string "
            f"(no sign, fraction, exponent, or leading zero; at most {MAX_NANO_USD_DIGITS} digits)."
        )
    assert isinstance(value, str)
    return value


def validate_metadata(value: object) -> dict[str, str] | None:
    """Metadata under the ``/v1/responses`` bounds; returns a copy, or ``None`` when absent."""
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise EnlittConfigurationError("metadata must be a mapping of strings to strings.")
    if len(value) > MAX_METADATA_ENTRIES:
        raise EnlittConfigurationError(f"metadata allows at most {MAX_METADATA_ENTRIES} entries.")
    out: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise EnlittConfigurationError("metadata keys and values must be strings.")
        if not 1 <= len(key) <= MAX_METADATA_KEY_LENGTH:
            raise EnlittConfigurationError(
                f"metadata keys must be 1 to {MAX_METADATA_KEY_LENGTH} characters."
            )
        if len(item) > MAX_METADATA_VALUE_LENGTH:
            raise EnlittConfigurationError(
                f"metadata values must be at most {MAX_METADATA_VALUE_LENGTH} characters."
            )
        if key.startswith(RESERVED_METADATA_PREFIX):
            raise EnlittConfigurationError(
                f"metadata keys cannot begin with {RESERVED_METADATA_PREFIX!r}."
            )
        out[key] = item
    return out


def validate_reporting_deadline_ms(value: object) -> int | None:
    """A positive integer, or ``None`` when absent (the server default then applies)."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise EnlittConfigurationError("reporting_deadline_ms must be a positive integer.")
    return value


def validate_label(value: object, what: str) -> str:
    """A bounded nonempty label such as a provider id or model name."""
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_LABEL_LENGTH:
        raise EnlittConfigurationError(
            f"{what} must be a string of 1 to {MAX_LABEL_LENGTH} characters."
        )
    return value
