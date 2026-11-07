# Changelog

## Unreleased

- `premium_not_enabled` (the application's premium switch is off) surfaces as
  `EnlittAuthorizationError` with that code, from a premium start (no provider runs) or a terminal
  report (the call is not charged).

## 0.1.0

- First public release: the `@enlitt/sdk/vercel` and `@enlitt/sdk/openai` model adapters, the
  framework-neutral `@enlitt/sdk/core` (session middleware, typed errors, `withPremiumCharge()`,
  `usage()`), the `@enlitt/sdk/server` login, callback, and logout handlers, and the browser-safe
  `@enlitt/sdk/browser` login entry.
