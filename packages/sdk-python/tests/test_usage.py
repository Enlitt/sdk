"""``usage()`` against the shared response fixtures."""

from __future__ import annotations

import httpx
import pytest
import respx

from _support import TOKEN, load_fixtures
from enlitt import EnlittError, EnlittOptions, enlitt_session, usage


@pytest.mark.parametrize(
    ("name", "fixture"),
    [f for f in load_fixtures("responses") if f[1]["endpoint"] == "usage"],
    ids=lambda v: str(v)[:40],
)
async def test_usage_fixture(name: str, fixture: dict, api: respx.MockRouter) -> None:  # type: ignore[type-arg]
    route = api.get("/v1/enlitt/usage").mock(
        return_value=httpx.Response(fixture["http_status"], json=fixture["body"])
    )
    result = await usage(EnlittOptions(session=enlitt_session(TOKEN)))
    body = fixture["body"]
    assert result.standard.remaining_percent == body["standard"]["remaining_percent"]
    assert result.standard.limit_cap_nano_usd == body["standard"]["limit_cap_nano_usd"]
    assert result.premium.remaining_percent == body["premium"]["remaining_percent"]
    assert result.premium.limit_cap_nano_usd == body["premium"]["limit_cap_nano_usd"]
    assert route.call_count == 1


async def test_usage_malformed_body_is_malformed_response(api: respx.MockRouter) -> None:
    api.get("/v1/enlitt/usage").mock(return_value=httpx.Response(200, json={"standard": 1}))
    with pytest.raises(EnlittError) as caught:
        await usage(EnlittOptions(session=enlitt_session(TOKEN)))
    assert caught.value.code == "malformed_response"


async def test_usage_uses_the_ambient_session(api: respx.MockRouter) -> None:
    from enlitt import run_with_enlitt_session

    route = api.get("/v1/enlitt/usage").mock(
        return_value=httpx.Response(
            200,
            json={
                "standard": {"remaining_percent": 1, "limit_cap_nano_usd": "1"},
                "premium": {"remaining_percent": 2, "limit_cap_nano_usd": "2"},
            },
        )
    )

    async def call() -> int:
        return (await usage()).premium.remaining_percent

    assert await run_with_enlitt_session(enlitt_session("ambient_token_0001"), call) == 2
    assert route.calls.last.request.headers["x-enlitt-user-authorization"] == (
        "Bearer ambient_token_0001"
    )
