# Changelog

## 0.1.1

- Premium image generation, text-to-speech, and speech-to-text: `enlitt()` from
  `@enlitt/sdk/vercel` wraps Vercel AI SDK image, speech, and transcription models, and the
  `@enlitt/sdk/openai` client adds premium-only `images.generate()`, `audio.speech.create()`, and
  `audio.transcriptions.create()`. New price helpers `perImage()`, `perCharacter()`, and
  `perAudioSecond()` in both entries.

- `premium_not_enabled` (the application's premium switch is off) surfaces as
  `EnlittAuthorizationError` with that code, from a premium start (no provider runs) or a terminal
  report (the call is not charged).

## 0.1.0

- First public release: the `@enlitt/sdk/vercel` and `@enlitt/sdk/openai` model adapters, the
  framework-neutral `@enlitt/sdk/core` (session middleware, typed errors, `withPremiumCharge()`,
  `usage()`), the `@enlitt/sdk/server` login, callback, and logout handlers, and the browser-safe
  `@enlitt/sdk/browser` login entry.
