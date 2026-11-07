# Enlitt Sign-In for Unity

Sign players in to your Unity game with Enlitt, without putting any secret in the game.

The kit is a client of the **client sign-in handler** that ships with the Enlitt server SDKs (TypeScript, Python, .NET). Your game backend runs the handler. The kit opens the browser, receives a one-time code, redeems it at **your backend**, stores the session token, and adds the `Enlitt-Session` header to your game's own requests. It never talks to Enlitt directly, holds no key or secret, and contains no model or premium-call code: your backend makes those calls with a server SDK.

Requires Unity 2021.3 or newer. No dependencies.

## Install

In Unity, open **Window > Package Manager > + > Add package from git URL** and enter:

```
https://github.com/enlitt/sdk.git?path=packages/unity-signin/upm
```

Pin a version by appending its tag (for example `...?path=packages/unity-signin/upm#unity-signin-v0.1.0`). To try the sample, select **Enlitt Sign-In** in the Package Manager and import **Sign-In Button** under Samples.

## Backend prerequisites

The kit needs three things on your game backend. All are in the server SDK's documentation.

1. **The client sign-in handler**, mounted under a base path on your app origin, for example `/enlitt/client`. Configure which modes you allow: `loopback` (default on), `returnUrls` (the deep links for mobile), and `pairing` (default off). Use a store shared across your processes in production; the in-memory store is for development only and does not work across processes.
2. **The session middleware with `header: true`** on the routes your game calls. From then on `getEnlittSession()` and every model call work unchanged for requests that carry the `Enlitt-Session` header.
3. **Rate limiting** with your existing limiter on `POST <basePath>/pair` and `POST <basePath>/token`, per client IP. The handler has no limiter of its own.

Signing in through the handler signs that browser out of your website's Enlitt session; this is how the handler guarantees the session it hands your game was minted by this sign-in.

## Use it

```csharp
using Enlitt.SignIn;

var signIn = new EnlittSignIn(new EnlittSignInOptions
{
    // <appOrigin><basePath> of your handler. Must be https (http only for 127.0.0.1 / localhost).
    BackendBaseUrl = "https://game.example.com/enlitt/client",
    // Optional: the deep link for Android and iOS. Must be in the server's returnUrls.
    ReturnUrl = "com.example.game://signin",
});

try
{
    await signIn.SignInAsync();                       // opens the browser
}
catch (EnlittSignInException e)
{
    Debug.Log("Sign-in failed: " + e.Code);           // e.g. access_denied, timeout, cancelled
}

// On every request to YOUR backend (never to another host):
var request = UnityWebRequest.Get("https://game.example.com/api/profile");
signIn.Authorize(request);                            // adds the Enlitt-Session header
```

If your backend answers `401` because the session is no longer valid, call `signIn.ForgetSession()` and sign in again. `signIn.SignOutAsync()` revokes the session at the backend and clears it locally.

Call `SignInAsync` and the other methods from the main thread. Errors are `EnlittSignInException`; its `Code` is one of `access_denied`, `invalid_grant`, `expired_token`, `invalid_request` (from the backend), or `state_mismatch`, `timeout`, `cancelled`, `network`, `not_signed_in`, `configuration` (local).

## The three modes

| Mode | When | How |
| --- | --- | --- |
| **Loopback** | Desktop (Windows, macOS, Linux) and the editor; the default everywhere | The kit listens briefly on `127.0.0.1` on a random port. The browser is sent back to it with a one-time code. |
| **Deep link** | Android and iOS, when `ReturnUrl` is set | The browser returns to your registered URL scheme or https link. Register that URL with the OS (Android intent filter, iOS URL type or associated domain) and list it in the server's `returnUrls`. |
| **Pairing** | Consoles, TVs, and anything without a usable browser | `StartPairingAsync()` returns a short code and a web page. The player enters the code on a phone or computer, and `WaitAsync()` completes when they confirm. |

```csharp
PairingInfo pairing = await signIn.StartPairingAsync();
ShowOnScreen($"Go to {pairing.VerificationUri} and enter {pairing.UserCode}");
await pairing.WaitAsync();                            // throws access_denied or expired_token
```

Pairing must be enabled on the backend (`pairing: true`). The confirmation page warns the player to continue only if the code is on a screen in front of them.

**WebGL is not supported by this kit.** A WebGL game is a web page and should use the web cookie flow; `SignInAsync` fails with `configuration` there.

## Token storage warning

By default the session token is kept in `PlayerPrefs` under the key `enlitt.session`. **`PlayerPrefs` is not encrypted**: on Windows it is the registry, on macOS a plist, on Linux an XML file, all readable by anything running as the player. The token is a bearer credential for that player's session, so for anything sensitive store it in the platform keychain instead by implementing `ITokenStorage` (`Load`, `Save`, `Clear`) and passing it in:

```csharp
new EnlittSignInOptions { BackendBaseUrl = "...", TokenStorage = new MyKeychainStorage() }
```

A built-in keychain storage is planned.

## Security notes

- The kit never embeds an Enlitt key, client secret or business secret, and never calls an Enlitt host.
- The token goes only to `BackendBaseUrl` and to your own requests through `Authorize`. Do not call `Authorize` on a request to a third-party host.
- The kit never logs the token, the one-time code or the PKCE verifier.

## Unity editor and device testing

The package is compiled in CI against a stub of the UnityEngine members it uses, and its sign-in engine is covered by unit tests. Behavior inside the Unity editor, on devices, and with real deep links is not covered by automated tests; check it in your own project before shipping.
