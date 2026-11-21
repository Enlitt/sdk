# Changelog

## 0.1.1

- The Vercel adapter's premium wrappers accept Vercel AI SDK v4 models (`ai@7`, for example
  `@ai-sdk/openai` 4.x) as well as v3 models (`ai@6`); a wrapped model keeps its version. Streaming
  speech and transcription are not exposed through Enlitt.

- Premium image generation, text-to-speech, and speech-to-text: `enlitt()` from
  `@enlitt/sdk/vercel` wraps Vercel AI SDK image, speech, and transcription models, and the
  `@enlitt/sdk/openai` client adds premium-only `images.generate()`, `audio.speech.create()`, and
  `audio.transcriptions.create()`. A media call is priced with a constant `price` or the
  business's own price function, which receives the image, speech, or transcription result.

- `premium_not_enabled` (the application's premium switch is off) surfaces as
  `EnlittAuthorizationError` with that code, from a premium start (no provider runs) or a terminal
  report (the call is not charged).

## 0.1.0

- First public release: the `@enlitt/sdk/vercel` and `@enlitt/sdk/openai` model adapters, the
  framework-neutral `@enlitt/sdk/core` (session middleware, typed errors, `withPremiumCharge()`,
  `usage()`), the `@enlitt/sdk/server` login, callback, and logout handlers, and the browser-safe
  `@enlitt/sdk/browser` login entry.
