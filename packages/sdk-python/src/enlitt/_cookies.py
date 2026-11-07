"""Cookie header helpers shared by the account handlers and the session middleware."""

from __future__ import annotations


def parse_cookie_header(value: str | None) -> dict[str, str]:
    """Parse a ``Cookie`` request header into name -> value (the first occurrence wins)."""
    cookies: dict[str, str] = {}
    if not value:
        return cookies
    for part in value.split(";"):
        name, sep, raw = part.strip().partition("=")
        if sep and name and name not in cookies:
            cookies[name] = raw.strip().strip('"')
    return cookies


def session_cookie(name: str, value: str) -> str:
    """The ``Set-Cookie`` value for the session: HttpOnly, Secure, SameSite=Lax, host-only."""
    return f"{name}={value}; Path=/; HttpOnly; Secure; SameSite=Lax"


def clearing_cookie(name: str) -> str:
    """A ``Set-Cookie`` value that deletes the session cookie."""
    return f"{name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
