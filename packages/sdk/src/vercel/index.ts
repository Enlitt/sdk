/**
 * `@enlitt/sdk/vercel` — the Vercel AI SDK adapter entry.
 *
 * Exactly the surface a business using the Vercel AI SDK needs: the `enlitt()`
 * model factory, the one standard model string, the `perToken()` price helper,
 * and the types a business writes down when it wraps `enlitt()` or builds a
 * premium price. Shared construction options (`EnlittOptions`), errors, and
 * session helpers are not redeclared here; they live in `@enlitt/sdk/core`.
 *
 * Everything reachable from here may read the business secret key, so the
 * package export map resolves this subpath's `browser` condition to
 * `server-unavailable.ts`.
 */

export {
  enlitt,
  ENLITT_STANDARD_MODEL,
  type EnlittPrice,
  type EnlittProviderOptions,
  type EnlittTarget,
  type PremiumPriceContext
} from "./language-model.js";

export { perToken } from "./premium-language-model.js";
