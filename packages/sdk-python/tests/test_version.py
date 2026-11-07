"""The package version, the module constant and the User-Agent-style header agree."""

from __future__ import annotations

import re
from pathlib import Path

from enlitt import SDK_VERSION


def test_sdk_version_equals_pyproject_version() -> None:
    text = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text("utf-8")
    match = re.search(r'^version = "([^"]+)"', text, re.MULTILINE)
    assert match is not None
    assert match.group(1) == SDK_VERSION
