"""Group 1: the vendored contract is byte-identical to the protocol package's."""

from __future__ import annotations

from _support import PROTOCOL_DIR
from enlitt import _contract


def test_vendored_contract_matches_protocol_byte_for_byte() -> None:
    source = (PROTOCOL_DIR / "generated" / "contract.json").read_bytes()
    assert _contract.raw_contract_bytes() == source, (
        "src/enlitt/_contract.json is stale: copy packages/protocol/generated/contract.json"
    )


def test_contract_exposes_what_the_sdk_reads() -> None:
    assert _contract.VERSION_HEADER == "Enlitt-Version"
    assert _contract.UNKNOWN_ENUM_VALUE == "other"
    assert _contract.IDEMPOTENCY_KEY_MIN_LENGTH <= _contract.IDEMPOTENCY_KEY_MAX_LENGTH
