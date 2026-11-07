"""Loader for the vendored wire contract (``_contract.json``).

The file is a byte-identical copy of ``packages/protocol/generated/contract.json``. Every
error-code property, closed set, API version and idempotency bound the SDK needs is read from
it, never restated as a literal.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any, cast

_RAW: bytes = resources.files("enlitt").joinpath("_contract.json").read_bytes()
CONTRACT: dict[str, Any] = cast("dict[str, Any]", json.loads(_RAW))

API_VERSION: str = CONTRACT["api_version"]
"""Value sent as the ``Enlitt-Version`` header."""

VERSION_HEADER: str = CONTRACT["version_header"]
UNKNOWN_ENUM_VALUE: str = CONTRACT["unknown_enum_value"]
"""The reserved value (``"other"``) an unknown closed-set member reads as."""

UNRECOGNIZED_ERROR_CODE: str = CONTRACT["unrecognized_error_code"]
IDEMPOTENCY_KEY_MIN_LENGTH: int = CONTRACT["idempotency_key"]["min_length"]
IDEMPOTENCY_KEY_MAX_LENGTH: int = CONTRACT["idempotency_key"]["max_length"]
ERROR_TYPES: list[str] = CONTRACT["error_types"]
ERROR_CODES: dict[str, dict[str, Any]] = CONTRACT["error_codes"]
CLOSED_SETS: dict[str, list[str]] = CONTRACT["closed_sets"]


def raw_contract_bytes() -> bytes:
    """Return the vendored file's exact bytes (used by the staleness test)."""
    return _RAW
