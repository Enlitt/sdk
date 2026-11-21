# Changelog

## 0.1.1 (unpublished)

- Premium image, speech, and transcription wrappers in `Enlitt.Extensions.AI`: `EnlittImageGenerator.Premium`, `EnlittTextToSpeechClient.Premium`, and `EnlittSpeechToTextClient.Premium` over the `Microsoft.Extensions.AI` media interfaces. Microsoft marks those interfaces experimental, so suppress `MEAI001` where you use them. Streaming media is not supported, and there are no media price helpers.
- `Enlitt.Extensions.AI` now depends on `Microsoft.Extensions.AI.Abstractions` 10.11.1 (the first line with `ITextToSpeechClient` is 10.5). The standard chat client refuses `ChatOptions.Reasoning`.

## 0.1.0

- First release of the .NET SDK: `Enlitt` (core and sign-in handlers), `Enlitt.AspNetCore`, and `Enlitt.Extensions.AI`.
- Premium charge accounting (`EnlittSdk.WithPremiumChargeAsync`), usage, session handle and ambient session context.
- Standard and premium `IChatClient` adapters.
- Login-start, callback and logout handlers, and the client sign-in handoff (loopback, redirect, pairing).
