# Enlitt SDK for .NET

The .NET binding of the Enlitt SDK. Server-side only: it holds your Enlitt secret key and must never ship in a client app.

| Package | What it is |
| --- | --- |
| `Enlitt` | Core: premium charge accounting, usage, session handle, sign-in handlers. BCL only. |
| `Enlitt.AspNetCore` | Session middleware and sign-in endpoints for ASP.NET Core. |
| `Enlitt.Extensions.AI` | `Microsoft.Extensions.AI` `IChatClient` adapter for the standard and premium models. |

Requires .NET 8. Set `ENLITT_SECRET_KEY` (your application's model key), or pass `SecretKey` in `EnlittOptions`.

## Sign users in and read their session

```csharp
builder.Services.AddSingleton<IStateStore, MemoryStateStore>(); // use a shared store in production

var auth = new CallbackConfig
{
    ClientId = "your-client-id",
    RedirectUri = "https://app.example.com/enlitt/callback",
    AppOrigin = "https://app.example.com",
    DefaultReturnTo = "/",
    StateStore = new MemoryStateStore(),
};

app.UseEnlittSession();      // reads the session cookie into the ambient context
app.MapEnlittAuth(auth);     // /enlitt/login, /enlitt/callback, /enlitt/logout
```

For games and native clients, `app.MapEnlittClientSignIn(new ClientSignInConfig { ... })` serves the client sign-in handoff
and `app.UseEnlittSession(new EnlittSessionMiddlewareOptions { Header = true })` accepts the `Enlitt-Session` header.

## Standard model

```csharp
IChatClient chat = EnlittChatClient.Standard();
ChatResponse reply = await chat.GetResponseAsync("Hello");
```

Outside an HTTP request, pass a session explicitly: `EnlittChatClient.Standard(new EnlittOptions { Session = new EnlittSession(token) })`.

## Premium: your own provider, accounted by Enlitt

```csharp
IChatClient chat = EnlittChatClient.Premium(myProviderClient);
var options = new ChatOptions
{
    AdditionalProperties = new() { ["enlitt"] = new EnlittProviderOptions { MaxCharge = "5000000", Price = "2000000" } },
};
await chat.GetResponseAsync("Hello", options);
```

For code that is not an `IChatClient`, wrap the call yourself:

```csharp
await EnlittSdk.WithPremiumChargeAsync(
    new WithPremiumChargeOptions { MaxCharge = "5000000", Provider = new("openai", "gpt-4o") },
    async (charge, operation, ct) =>
    {
        var result = await CallMyProviderAsync(ct);
        charge("2000000"); // NANOUSD; the last call wins
        return result;
    });
```

Amounts are canonical NANOUSD strings and are kept exact beyond 2^63. A refused call never invokes your provider.
Every call sends exactly one terminal report; a report that cannot be delivered goes to `EnlittOptions.OnTerminalReportError`.

## Images, speech, and transcription

Wrap your own `IImageGenerator`, `ITextToSpeechClient`, or `ISpeechToTextClient` the same way. Media is premium only (there is no standard media client), and each call is one premium operation. Set `EnlittMediaProviderOptions` under `AdditionalProperties["enlitt"]` of the call's options.

```csharp
IImageGenerator images = EnlittImageGenerator.Premium(myImageGenerator);
await images.GenerateAsync(
    new ImageGenerationRequest("A lighthouse at dusk"),
    new ImageGenerationOptions
    {
        Count = 1,
        AdditionalProperties = new() { ["enlitt"] = new EnlittMediaProviderOptions { MaxCharge = "80000000", Price = "40000000" } },
    });

ITextToSpeechClient speech = EnlittTextToSpeechClient.Premium(mySpeechClient);
await speech.GetAudioAsync(
    "Hello there",
    new TextToSpeechOptions
    {
        AdditionalProperties = new()
        {
            ["enlitt"] = new EnlittMediaProviderOptions
            {
                MaxCharge = "5000000",
                // A price function sees the code-point count of the text; the SDK ships no media price helpers.
                Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(c => ValueTask.FromResult((c.Characters!.Value * 1000L).ToString())),
            },
        },
    });

ISpeechToTextClient transcriber = EnlittSpeechToTextClient.Premium(myTranscriber);
await transcriber.GetTextAsync(
    audioStream,
    new SpeechToTextOptions
    {
        AdditionalProperties = new() { ["enlitt"] = new EnlittMediaProviderOptions { MaxCharge = "5000000", Price = "2000000" } },
    });
```

Your inner client must report its metadata (`ImageGeneratorMetadata`, `TextToSpeechClientMetadata`, or `SpeechToTextClientMetadata`) so the call can be labelled. Streaming (`GetStreamingAudioAsync`, `GetStreamingTextAsync`) is not supported through Enlitt and throws `EnlittConfigurationException`. A supplied `IdempotencyKey` is the call identity itself, so reuse one only for a retry of the same call.

These interfaces are experimental in `Microsoft.Extensions.AI` (diagnostic `MEAI001`). Using them in your own project raises that diagnostic, so suppress it there: `<NoWarn>$(NoWarn);MEAI001</NoWarn>` in your csproj.

## Errors

All failures derive from `EnlittException` (`Code`, `ProviderInvoked`, `Retryable`, `RetryAfterMs`, `RequestId`, `AuthorizeUrl`).
A signed-out user raises `EnlittLoginRequiredException`; a missing middleware raises `EnlittConfigurationException`.
Only `rate_limit_exceeded` is retried by the SDK, bounded by `EnlittOptions.RateLimit`.

## Development

```
dotnet build -warnaserror
dotnet test
dotnet format --verify-no-changes
dotnet pack -c Release -o dist
```
