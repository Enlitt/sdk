/**
 * The server-only boundary that turns a business secret into an outgoing
 * authorization header.
 *
 * There is exactly one export. Resolving a key and formatting a header used to
 * be two of them, which made "resolve the key and forget to use it" a
 * reachable mistake at every call site; there is now no way to obtain the
 * secret through this module's public surface without obtaining the header.
 *
 * A missing or unusable secret throws locally, before any network call, and
 * never yields an unauthenticated client or a credential-free request. That
 * local failure is what stops a managed premium call from silently falling
 * through to a direct, business-funded provider call.
 *
 * The resolved value is a secret. It is never logged, never serialized into a
 * thrown error's message or fields, and never returned to a caller: the
 * `browser` condition on the `./server` subpath keeps this file out of every
 * browser bundle, and the environment assertion below is the second net for a
 * bundler or runtime that ignores that condition.
 *
 * Both local failures — a browser environment and an unusable secret — raise
 * `EnlittConfigurationError`. That is what `enlitt()` documents its callers
 * will see for a missing or invalid secret, and the type has to be right here
 * rather than at one caller's boundary: any other caller of this function
 * (`server/callback.ts`'s handlers among them) would otherwise receive a bare
 * `Error` for exactly the same misconfiguration, and a business catching the
 * package's own error class would miss it.
 */

import { EnlittConfigurationError } from "../core/errors.js";

const ENV_KEY = "ENLITT_SECRET_KEY";

/**
 * A single visible-ASCII run: exactly what an HTTP header value may carry.
 *
 * A secret holding a control character, a space, or a newline is unusable
 * rather than merely unusual — pasted with a trailing newline it would either
 * be rejected by the transport or, worse, split the header. Refusing it here
 * is the same local failure as a missing key.
 */
const USABLE_SECRET = /^[!-~]+$/;

/**
 * Refuse before any secret-related work if this looks like a browser.
 *
 * The heuristic is the simultaneous presence of `window` and `document`,
 * which is reliably absent in Node, Deno, Bun, and Cloudflare Workers and
 * present in every mainstream browser. It is deliberately not exported: a
 * caller has no reason to ask the question separately from asking for the
 * header, and an exported assertion is one more thing that can be called and
 * its answer ignored.
 */
function assertServerEnvironment(): void {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    throw new EnlittConfigurationError(
      "@enlitt/sdk: server-only module imported in a browser environment. " +
        "Use @enlitt/sdk/browser for code you ship to consumers."
    );
  }
}

// Fail on module evaluation too, so a mistaken browser import surfaces at
// import time rather than at the first call that needed a credential.
assertServerEnvironment();

/**
 * Read the environment fallback without assuming a `process` global exists.
 *
 * Workers-style runtimes have no `process`, and reaching for it unguarded
 * would turn "no key configured" into a `ReferenceError` that reads like a
 * bug in the SDK rather than a missing configuration value.
 */
function readEnvironmentSecret(): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[ENV_KEY];
}

/**
 * Resolve the business secret and return the one header value that carries it.
 *
 * Resolution order is explicit configuration first, then the `ENLITT_SECRET_KEY`
 * environment fallback. An explicitly supplied key is never abandoned in
 * favour of the environment: a business that passed an empty or malformed
 * value has misconfigured that value, and silently authenticating as whatever
 * the environment happens to hold would be a different identity than the one
 * the call site asked for.
 *
 * @returns a single `Bearer <secret>` header value.
 * @throws {EnlittConfigurationError} in a browser environment, or when no
 *   usable secret resolves. Neither the message nor any field of the thrown
 *   error carries any part of the secret.
 */
export function resolveBusinessAuthorizationHeader(config: { secretKey?: string }): string {
  // Before resolution, not after: a browser must never reach the code that
  // reads a secret at all, let alone hold the result.
  assertServerEnvironment();

  const configured = config.secretKey;
  // Not `??`: that would treat a `null` from an untyped JavaScript caller as
  // "nothing configured" and fall through to the environment, authenticating as
  // whatever identity the environment happens to hold rather than refusing the
  // misconfigured value. Only `undefined` means the caller configured nothing.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const candidate: unknown = configured === undefined ? readEnvironmentSecret() : configured;

  if (typeof candidate !== "string" || !USABLE_SECRET.test(candidate)) {
    throw new EnlittConfigurationError(
      "@enlitt/sdk: no usable Enlitt secret key. Pass one as { secretKey } or set " +
        `the ${ENV_KEY} environment variable on the server. The value must be a ` +
        "non-empty string of visible ASCII characters."
    );
  }

  return `Bearer ${candidate}`;
}
