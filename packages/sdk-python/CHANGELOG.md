# Changelog

## 0.1.1

- Premium image, speech, and transcription calls in `enlitt.openai`:
  `images.generate()`, `audio.speech.create()`, and `audio.transcriptions.create()` on the
  wrapped `AsyncOpenAI` client. Each is one premium operation with the same maximum, price,
  and settlement rules as `responses.create()`. Pass `enlitt=EnlittMediaCallOptions(...)`.
  There are no media price helpers: use a constant `price`, or write a function of
  `OpenAIPremiumMediaPriceContext`.

## 0.1.0

- First release: the core (`with_premium_charge`, `usage`, sessions, typed errors), the login
  and client sign-in handlers, ASGI and Starlette bindings, and the OpenAI Responses adapter.
