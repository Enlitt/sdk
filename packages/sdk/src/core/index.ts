/**
 * `@enlitt/sdk/core` — the framework-neutral public entry.
 *
 * Everything a business needs that does not depend on a particular AI
 * framework lives behind this entry: the session helpers, the typed error
 * hierarchy, `withPremiumCharge()` for premium calls made outside the Vercel AI
 * SDK, and `usage()`. A framework adapter (today `@enlitt/sdk/vercel`) maps its
 * own types onto these functions rather than copying authentication, retries,
 * errors, session resolution, or the premium state machine.
 *
 * It deliberately exports no raw transport, SSE parser, request builder,
 * credential formatter, or Vercel type. The core source graph imports only
 * standard Web and Node APIs, `@enlitt/protocol`, and Account's internal
 * credential formatter, and never `@ai-sdk/provider`.
 *
 * Everything reachable from here may read the business secret key, so the
 * package export map resolves this subpath's `browser` condition to
 * `server-unavailable.ts`.
 */

export {
  withPremiumCharge,
  type PremiumChargeFunction,
  type PremiumChargeHandle,
  type PremiumTerminalFacts,
  type WithPremiumChargeOptions
} from "./premium.js";

export { usage, type UsageAvailability } from "./usage.js";

export type { EnlittOptions, EnlittRateLimitRetryOptions } from "./transport.js";

export {
  ENLITT_SESSION_COOKIE_NAME,
  ENLITT_SESSION_HEADER_NAME,
  enlittSession,
  enlittSessionMiddleware,
  getEnlittSession,
  runWithEnlittSession,
  type EnlittMiddleware,
  type EnlittSession,
  type SessionMiddlewareOptions
} from "./session.js";

export {
  EnlittAuthenticationError,
  EnlittAuthorizationError,
  EnlittConfigurationError,
  EnlittError,
  EnlittInsufficientCreditsError,
  EnlittLimitExceededError,
  EnlittLoginRequiredError,
  EnlittRateLimitError,
  EnlittSubscriptionInactiveError,
  type EnlittLocalCode,
  type EnlittUnrecognizedCode
} from "./errors.js";
