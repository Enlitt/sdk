/**
 * The `browser` condition for `@enlitt/sdk/server`, `@enlitt/sdk/core`, and
 * `@enlitt/sdk/vercel`, and `@enlitt/sdk/openai` resolves here.
 *
 * A bundler that follows browser conditions can therefore never pull the real
 * server module — and with it `process.env.ENLITT_SECRET_KEY` — into a client
 * bundle. Failing at import time makes the mistake loud at build or first
 * load rather than silently shipping a secret read to consumers.
 */

throw new Error(
  "This @enlitt/sdk entry (server, core, vercel, or openai) is a server-only entry point and was resolved in a " +
    "browser bundle. Import it from server code only; use @enlitt/sdk/browser " +
    "in code you ship to consumers."
);

export {};
