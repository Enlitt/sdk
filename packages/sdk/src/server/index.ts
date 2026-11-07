/**
 * `@enlitt/sdk/server` — the entry point a business runs on its own server,
 * and its entire public surface.
 *
 * Exactly one file answers "what does a business import": this module
 * re-exports the model factory and the types naming its arguments, the
 * session helpers, the typed error hierarchy, and Account's login-start,
 * callback, and logout handlers, and adds no behavior of its own. The package
 * export map resolves the `./server` subpath's `browser` condition to
 * `src/server-unavailable.ts`, never to this file, so no transport, secret
 * resolution, or premium code can enter a browser bundle by import path.
 * The raw transport, SSE parser, and premium state machine are not exported at
 * all; they are reachable only from within the package.
 *
 * Everything reachable from here may read the business secret key.
 */

export {
  enlitt,
  ENLITT_STANDARD_MODEL,
  perToken,
  type EnlittPrice,
  type EnlittProviderOptions,
  type EnlittTarget,
  type PremiumPriceContext
} from "../vercel/index.js";

export {
  ENLITT_SESSION_COOKIE_NAME,
  ENLITT_SESSION_HEADER_NAME,
  EnlittAuthenticationError,
  EnlittAuthorizationError,
  EnlittConfigurationError,
  EnlittError,
  EnlittInsufficientCreditsError,
  EnlittLimitExceededError,
  EnlittLoginRequiredError,
  EnlittRateLimitError,
  EnlittSubscriptionInactiveError,
  enlittSession,
  enlittSessionMiddleware,
  getEnlittSession,
  runWithEnlittSession,
  usage,
  withPremiumCharge,
  type EnlittOptions,
  type EnlittRateLimitRetryOptions,
  type EnlittSession,
  type PremiumChargeFunction,
  type PremiumChargeHandle,
  type PremiumTerminalFacts,
  type UsageAvailability,
  type WithPremiumChargeOptions
} from "../core/index.js";

export {
  createCallbackHandler,
  createLoginStartHandler,
  createLogoutHandler,
  type CallbackConfig,
  type StateRecord,
  type StateStore
} from "./callback.js";

export {
  createClientSignInHandler,
  createMemoryClientSignInStore,
  type ClientSignInConfig,
  type ClientSignInStore
} from "./client-sign-in.js";
