"""Business secret resolution (``secrets.test.ts``)."""

from __future__ import annotations

import pytest

from _support import SECRET
from enlitt import EnlittConfigurationError, _secrets


def test_explicit_secret_beats_the_environment() -> None:
    assert _secrets.resolve_business_authorization_header("sk_explicit") == "Bearer sk_explicit"


def test_environment_secret_is_used_when_no_explicit_one() -> None:
    assert _secrets.resolve_business_authorization_header() == f"Bearer {SECRET}"


def test_missing_secret_fails_locally(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENLITT_SECRET_KEY")
    with pytest.raises(EnlittConfigurationError):
        _secrets.resolve_business_authorization_header()


@pytest.mark.parametrize("bad", ["has space", "tab\there", "ünïcode", "x" * 513])
def test_unusable_secret_fails_without_echoing_it(bad: str) -> None:
    with pytest.raises(EnlittConfigurationError) as caught:
        _secrets.resolve_business_authorization_header(bad)
    assert bad not in str(caught.value)


def test_module_exports_no_bare_secret_accessor() -> None:
    public = [name for name in dir(_secrets) if not name.startswith("_")]
    functions = [n for n in public if callable(getattr(_secrets, n)) and n[0].islower()]
    assert functions == ["resolve_business_authorization_header"]
