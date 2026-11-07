"""Business secret resolution (port of Account's ``secrets.ts``).

Exactly one function lives here and it returns the formatted ``Authorization`` header value.
There is deliberately no function that returns the bare secret.
"""

from __future__ import annotations

import os

from .errors import EnlittConfigurationError

_MAX_SECRET_LENGTH = 512


def resolve_business_authorization_header(secret_key: str | None = None) -> str:
    """Return ``"Bearer <secret>"`` from ``secret_key`` or ``ENLITT_SECRET_KEY``.

    Raises:
        EnlittConfigurationError: No usable secret. The message never contains the secret.
    """
    secret = secret_key if secret_key else os.environ.get("ENLITT_SECRET_KEY")
    if (
        not secret
        or len(secret) > _MAX_SECRET_LENGTH
        or not secret.isascii()
        or not secret.isprintable()
        or any(ch.isspace() for ch in secret)
    ):
        raise EnlittConfigurationError(
            "No usable Enlitt business secret. Pass secret_key or set ENLITT_SECRET_KEY."
        )
    return f"Bearer {secret}"
