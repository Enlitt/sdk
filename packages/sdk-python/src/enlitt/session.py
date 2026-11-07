"""Ambient and explicit personal sessions (port of ``core/session.ts``).

The session is an opaque Enlitt-issued token. The ambient session lives in a
:class:`contextvars.ContextVar` with three distinct states that must never collapse:

* no context at all: :func:`get_enlitt_session` raises (middleware is not installed);
* a context holding ``None``: the visitor is signed out;
* a context holding a session.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import TypeVar

from .errors import EnlittConfigurationError

T = TypeVar("T")

ENLITT_SESSION_COOKIE_NAME = "enlitt_session"
"""Canonical cookie name. Pass the same value to ``CallbackConfig`` and the middleware."""

ENLITT_SESSION_HEADER_NAME = "Enlitt-Session"
"""Request header carrying a token from a client without a cookie jar (opt-in)."""

MAX_SESSION_TOKEN_LENGTH = 4096


@dataclass(frozen=True, repr=False)
class EnlittSession:
    """Opaque handle around Enlitt's session token. Its text form never shows the token."""

    token: str

    def __repr__(self) -> str:
        return "EnlittSession(<redacted>)"

    __str__ = __repr__


def enlitt_session(token: str) -> EnlittSession:
    """Wrap a stored token. Only checks that it is a non-empty, bounded string; never parses it."""
    if not isinstance(token, str) or not 0 < len(token) <= MAX_SESSION_TOKEN_LENGTH:
        raise EnlittConfigurationError(
            "An Enlitt session token must be a string of 1 to "
            f"{MAX_SESSION_TOKEN_LENGTH} characters."
        )
    return EnlittSession(token)


class _NoContext:
    """Sentinel for 'no session context was ever established on this path'."""


_NO_CONTEXT = _NoContext()
_current: ContextVar[EnlittSession | _NoContext | None] = ContextVar(
    "enlitt_session", default=_NO_CONTEXT
)


async def run_with_enlitt_session(
    session: EnlittSession | None, fn: Callable[[], Awaitable[T]]
) -> T:
    """Run ``fn`` with ``session`` (or an explicit signed-out ``None``) as the ambient context.

    The context is set, ``fn()`` is awaited, and the context is reset in ``finally``. A task
    created before this call does not see it; a task created inside ``fn`` does.
    """
    token = _current.set(session)
    try:
        return await fn()
    finally:
        _current.reset(token)


def get_enlitt_session() -> EnlittSession | None:
    """Return the ambient session, or ``None`` when signed out.

    Raises:
        EnlittConfigurationError: There is no context at all. That is a deployment bug (the
            middleware is not installed on this path) and must never read as 'signed out'.
    """
    value = _current.get()
    if isinstance(value, _NoContext):
        raise EnlittConfigurationError(
            "No Enlitt session context exists on this path. Install EnlittSessionMiddleware "
            "(or wrap the call in run_with_enlitt_session) before calling Enlitt."
        )
    return value
