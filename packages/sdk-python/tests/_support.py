"""Shared helpers for the test suite (no test lives here)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx

BASE_URL = "https://api.enlitt.test"
SECRET = "sk_test_business_secret_value"
TOKEN = "session_token_for_tests_0001"

# tests/ -> sdk-python -> packages -> repository root.
REPO_ROOT = Path(__file__).resolve().parents[3]
PROTOCOL_DIR = REPO_ROOT / "packages" / "protocol"
FIXTURES_DIR = PROTOCOL_DIR / "fixtures"


def load_fixtures(group: str) -> list[tuple[str, dict[str, Any]]]:
    """Every fixture in ``fixtures/<group>/`` as ``(file stem, parsed JSON)``, sorted."""
    files = sorted((FIXTURES_DIR / group).glob("*.json"))
    assert files, f"no fixtures found in {FIXTURES_DIR / group}"
    return [(path.stem, json.loads(path.read_text("utf-8"))) for path in files]


def canonical(value: object) -> str:
    """Key-sorted JSON with no whitespace, so two bodies compare structurally."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def json_response(
    body: object, status: int = 200, headers: dict[str, str] | None = None
) -> httpx.Response:
    """A JSON (or raw string) response for a respx route."""
    if isinstance(body, str):
        return httpx.Response(status, content=body.encode(), headers=headers)
    return httpx.Response(status, json=body, headers=headers)


def sse_body(events: list[tuple[str, object]]) -> bytes:
    """Render ``(event, data)`` pairs as a server-sent-event byte stream."""
    chunks = [f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events]
    return "".join(chunks).encode("utf-8")


def sent_json(call: Any) -> Any:
    """The parsed JSON body of a recorded respx call."""
    return json.loads(call.request.content)


# ----------------------------------------------------------------------- account handlers
APP_ORIGIN = "https://app.example.test"
CLIENT_ID = "client_test_123"
REDIRECT_URI = f"{APP_ORIGIN}/enlitt/callback"
DASHBOARD_ORIGIN = "https://dash.enlitt.test"
EXCHANGED_TOKEN = "exchanged_session_token_0001"
EXCHANGED_SUBJECT = "subject_abc-123"


def callback_config(**overrides: Any) -> Any:
    """A :class:`enlitt.auth.CallbackConfig` wired to the stubbed API and a memory store."""
    from enlitt.auth import CallbackConfig, MemoryStateStore

    values: dict[str, Any] = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "app_origin": APP_ORIGIN,
        "default_return_to": "/home",
        "state_store": MemoryStateStore(),
        "enlitt_origin": DASHBOARD_ORIGIN,
        "enlitt_api_origin": BASE_URL,
    }
    values.update(overrides)
    return CallbackConfig(**values)


def request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes = b"",
) -> Any:
    """A neutral handler request."""
    from enlitt.auth import HandlerRequest

    return HandlerRequest(method=method, url=url, headers=headers or {}, body=body)


def header_values(response: Any, name: str) -> list[str]:
    """Every value of one response header (names compared lowercase)."""
    return [v for k, v in response.headers if k.lower() == name]


def exchange_ok() -> httpx.Response:
    """A successful code exchange answer."""
    return httpx.Response(
        200,
        json={"session_token": EXCHANGED_TOKEN, "subject": EXCHANGED_SUBJECT, "extra": "ignored"},
    )
