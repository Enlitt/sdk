"""Shared fixtures: a stubbed Enlitt API, an injected clock, and a ready session."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
import respx

from _support import BASE_URL, SECRET, TOKEN
from enlitt import EnlittOptions, _transport, enlitt_session


class FakeClock:
    """Replaces the transport's clock, random source and sleep (the ``runtime`` seam).

    ``sleep`` only records the wait and advances the clock; ``uniform`` returns the upper
    bound so jitter is deterministic.
    """

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def uniform(self, low: float, high: float) -> float:
        return high

    def monotonic(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def _environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test runs against a fake origin with a fake business secret."""
    monkeypatch.setenv("ENLITT_SECRET_KEY", SECRET)
    monkeypatch.setenv("ENLITT_BASE_URL", BASE_URL)


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    fake = FakeClock()
    monkeypatch.setattr(_transport.runtime, "sleep", fake.sleep)
    monkeypatch.setattr(_transport.runtime, "uniform", fake.uniform)
    monkeypatch.setattr(_transport.runtime, "monotonic", fake.monotonic)
    return fake


@pytest.fixture
def api() -> Iterator[respx.MockRouter]:
    """A router that refuses any request that was not stubbed (no real network, ever)."""
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


@pytest.fixture
def options() -> EnlittOptions:
    """Construction options carrying an explicit session, so no ambient context is needed."""
    return EnlittOptions(session=enlitt_session(TOKEN))
