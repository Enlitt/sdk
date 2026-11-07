# `@enlitt/sdk`

TypeScript SDK for integrating your application with Enlitt. Offer standard
AI calls through Enlitt or charge premium calls made directly to your provider.
Both require your application's App key and a personal user's Enlitt session.

Install it with `npm i @enlitt/sdk`. The package requires Node.js
22 or later; model, authentication, and reporting APIs run on your server.

## Start here

1. Register an application in the Enlitt business dashboard.
2. Create an App key (`scope: "model"` on the wire) and store it on your server as `ENLITT_SECRET_KEY`.
3. Mount the login handlers and session middleware.
4. Call a model inside the user's session context.

```ts
import { enlitt, ENLITT_STANDARD_MODEL } from "@enlitt/sdk/vercel";
import { generateText } from "ai";

// Inside enlittSessionMiddleware(), after the user signs in:
const result = await generateText({
  model: enlitt(ENLITT_STANDARD_MODEL),
  prompt: "Write a short welcome message."
});
```

## Link application-owned users

The server-side login exchange returns an application-scoped stable `subject`
alongside the opaque session token. Set the optional `CallbackConfig.onSignIn`
hook to find/create your own user by that subject and append your own secure
session cookie to the supplied redirect `Response`. The SDK awaits the hook
before adding its Enlitt cookie. The subject is stable across future logins and
reauthorization, differs between applications, and is not a credential.

The hook receives only `{ subject }`, never an identity supplied in the callback
URL. Hook failures propagate to your server rather than completing login.
Protect your history with your own authenticated session and clear that session
on logout. `getEnlittSession()` continues to expose only the opaque token used
for Enlitt calls. Updated callback handlers require the backend's subject field;
existing callers can omit the hook, and older SDKs ignore the added field.

## Public entries

| Import               | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `@enlitt/sdk/vercel` | Vercel AI SDK model wrapping and pricing.               |
| `@enlitt/sdk/openai` | Official OpenAI `responses.create()` adapter.           |
| `@enlitt/sdk/core`   | Sessions, errors, `usage()`, and `withPremiumCharge()`. |
| `@enlitt/sdk/server` | Login handlers and core/Vercel compatibility exports.   |

All four entries are server-only. The root and browser entries currently
export no integration APIs. Never put a business key in browser code.

Premium pricing uses exact NANOUSD strings with `maxCharge` and `price`.
Test applications consume real credits.

Read the [developer guide](https://enlitt.com/docs), starting with
[login and sessions](https://enlitt.com/docs/authentication) and
[models and pricing](https://enlitt.com/docs/models). The versioned MDX sources
live in `apps/frontend/content/docs/` in this repository.
