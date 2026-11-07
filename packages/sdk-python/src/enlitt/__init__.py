"""Enlitt SDK for Python: per-user model calls and premium-call accounting.

The core entry points are re-exported here. The OpenAI adapter lives in :mod:`enlitt.openai`,
the account handlers in :mod:`enlitt.auth` and :mod:`enlitt.client_sign_in`, and the ASGI and
Starlette helpers in :mod:`enlitt.asgi` and :mod:`enlitt.starlette`.
"""

from ._transport import EnlittOptions, EnlittRateLimitRetryOptions
from ._version import SDK_VERSION
from .errors import (
    EnlittAuthenticationError,
    EnlittAuthorizationError,
    EnlittConfigurationError,
    EnlittError,
    EnlittInsufficientCreditsError,
    EnlittLimitExceededError,
    EnlittLoginRequiredError,
    EnlittRateLimitError,
    EnlittSubscriptionInactiveError,
)
from .premium import (
    PremiumChargeFunction,
    PremiumChargeHandle,
    PremiumProvider,
    PremiumTerminalFacts,
    WithPremiumChargeOptions,
    with_premium_charge,
)
from .session import (
    ENLITT_SESSION_COOKIE_NAME,
    ENLITT_SESSION_HEADER_NAME,
    EnlittSession,
    enlitt_session,
    get_enlitt_session,
    run_with_enlitt_session,
)
from .usage import UsageAvailability, UsageResult, usage

__all__ = [
    "ENLITT_SESSION_COOKIE_NAME",
    "ENLITT_SESSION_HEADER_NAME",
    "SDK_VERSION",
    "EnlittAuthenticationError",
    "EnlittAuthorizationError",
    "EnlittConfigurationError",
    "EnlittError",
    "EnlittInsufficientCreditsError",
    "EnlittLimitExceededError",
    "EnlittLoginRequiredError",
    "EnlittOptions",
    "EnlittRateLimitError",
    "EnlittRateLimitRetryOptions",
    "EnlittSession",
    "EnlittSubscriptionInactiveError",
    "PremiumChargeFunction",
    "PremiumChargeHandle",
    "PremiumProvider",
    "PremiumTerminalFacts",
    "UsageAvailability",
    "UsageResult",
    "WithPremiumChargeOptions",
    "enlitt_session",
    "get_enlitt_session",
    "run_with_enlitt_session",
    "usage",
    "with_premium_charge",
]
