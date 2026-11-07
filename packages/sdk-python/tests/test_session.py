"""Session helpers: three states, isolation, and redaction."""

from __future__ import annotations

import asyncio

import pytest

from enlitt import (
    EnlittConfigurationError,
    enlitt_session,
    get_enlitt_session,
    run_with_enlitt_session,
)


async def test_no_context_raises_instead_of_reading_as_signed_out() -> None:
    with pytest.raises(EnlittConfigurationError):
        get_enlitt_session()


async def test_explicit_none_is_signed_out() -> None:
    async def read() -> object:
        return get_enlitt_session()

    assert await run_with_enlitt_session(None, read) is None


async def test_session_context_is_visible_inside_and_reset_after() -> None:
    session = enlitt_session("token_value_one")

    async def read() -> object:
        return get_enlitt_session()

    assert await run_with_enlitt_session(session, read) is session
    with pytest.raises(EnlittConfigurationError):
        get_enlitt_session()


async def test_concurrent_tasks_do_not_see_each_other() -> None:
    seen: dict[str, object] = {}
    gate = asyncio.Event()

    async def request(name: str, token: str) -> None:
        async def body() -> None:
            await gate.wait()
            current = get_enlitt_session()
            seen[name] = current.token if current else None

        await run_with_enlitt_session(enlitt_session(token), body)

    tasks = [asyncio.create_task(request(f"r{i}", f"token_number_{i}")) for i in range(5)]
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*tasks)
    assert seen == {f"r{i}": f"token_number_{i}" for i in range(5)}


async def test_task_created_before_the_context_does_not_see_it() -> None:
    results: dict[str, bool] = {}
    start = asyncio.Event()

    async def early() -> None:
        await start.wait()
        try:
            get_enlitt_session()
            results["early_sees_session"] = True
        except EnlittConfigurationError:
            results["early_sees_session"] = False

    early_task = asyncio.create_task(early())

    async def inside() -> None:
        async def late() -> None:
            current = get_enlitt_session()
            results["late_sees_session"] = current is not None

        await asyncio.create_task(late())
        start.set()
        await early_task

    await run_with_enlitt_session(enlitt_session("token_value_two"), inside)
    assert results == {"early_sees_session": False, "late_sees_session": True}


def test_token_never_appears_in_repr_or_str() -> None:
    session = enlitt_session("super_secret_token_value")
    assert "super_secret_token_value" not in repr(session)
    assert "super_secret_token_value" not in str(session)
    assert "super_secret_token_value" not in f"{session}"


@pytest.mark.parametrize("bad", ["", "x" * 4097])
def test_token_bounds(bad: str) -> None:
    with pytest.raises(EnlittConfigurationError):
        enlitt_session(bad)
