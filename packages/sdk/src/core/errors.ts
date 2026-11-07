/**
 * The SDK's typed error hierarchy and the single mapping from an Enlitt
 * failure to one of its classes.
 *
 * This file declares no wire code list of its own. The stable codes, their
 * OpenAI-shaped `type`, their HTTP status, their retryability, and whether
 * they may carry `authorize_url` all come from the frozen record
 * `@enlitt/protocol` exports — the same record the backend raises from. That
 * is what keeps a code, and every fact about it, declared exactly once across
 * the wire rather than asserted independently in two workspaces.
 *
 * It declares one small closed set of SDK-local codes, for the four failures
 * that never reach the wire and so can have no entry in the protocol record.
 * That set is provably disjoint from the record's codes (see
 * `_LocalCodesDisjointFromWireCodes` below), so no reader ever has to ask
 * which side of the wire a given code came from.
 *
 * No class here carries a balance, plan, service tier, period, or personal
 * identity, and none wraps a provider's own error — a provider failure that
 * passes through the premium path is rethrown unchanged by
 * `normalizeEnlittModelError` and is never an instance of `EnlittError`.
 */

import {
  classifyEnlittErrorResponse,
  ENLITT_ERROR_CODE,
  ENLITT_ERROR_CODES,
  isEnlittErrorCode,
  // The frozen record's key type. Aliased on import so every reference in
  // this file reads as "Enlitt's stable wire code" rather than as a type this
  // module happens to reuse; the alias carries no members of its own.
  type EnlittErrorCode as EnlittWireCode
} from "@enlitt/protocol";

/**
 * The only codes this module originates. They exist because these four
 * failures never reach the wire: bad or missing configuration, a request
 * that never produced an HTTP response, a response that could not be parsed,
 * and a caller-initiated abort. All four are always non-retryable and always
 * report `providerInvoked: false`, the same as every wire-originated code,
 * because none of them means a provider was ever reached either.
 */
export type EnlittLocalCode =
  | "configuration_invalid"
  | "transport_failed"
  | "malformed_response"
  | "request_canceled";

/**
 * A type-level proof, not a runtime check: if a future edit ever gives a
 * local code the same name as a protocol code, the intersection below stops
 * being `never` and this file fails to compile. `AssertNever` exists only to
 * force that failure at the point of collision instead of letting `EnlittError`
 * silently become ambiguous about which side of the wire a code came from.
 */
type AssertNever<T extends never> = T;
type _LocalCodesDisjointFromWireCodes = AssertNever<EnlittLocalCode & EnlittWireCode>;

/**
 * The bounded facts a caller may attach when constructing an error: the
 * parsed `Retry-After`, the upstream `x-request-id`, and a navigation target.
 * Every field is optional because most codes carry none of them — a local
 * code carries none at all, and `authorizeUrl` is stored only where the
 * record permits the resulting code to carry one (see `EnlittError` below).
 */
export interface EnlittErrorFacts {
  /** Milliseconds, converted once from the wire's `Retry-After` seconds. */
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly authorizeUrl?: string;
  /**
   * Only meaningful for a code the record does not contain: the protocol
   * classifier's status-derived answer for a code from a newer server. A code
   * in the record always takes its `retryable` from the record instead.
   */
  readonly retryable?: boolean;
}

/**
 * Any other string: a code this SDK version does not know. `string & {}`
 * keeps editor completion for the known codes while forcing every business
 * `switch` over `EnlittError["code"]` to carry a `default` branch. Exported as
 * a type only; it adds no runtime value.
 */
export type EnlittUnrecognizedCode = string & {};

/**
 * The base class for every Enlitt-originated failure, and the only carrier
 * of Enlitt's stable wire codes into a caller's code.
 *
 * Enlitt failures with no distinct business action of their own — invalid
 * request, unsupported capability, conflict, routing, and server failures,
 * plus a wire code newer than this SDK knows — surface as this class
 * directly, carrying their stable code. Every other wire code that does
 * imply a distinct action gets its own subclass below.
 */
export class EnlittError extends Error {
  override readonly name: string = "EnlittError";

  readonly code: EnlittWireCode | EnlittLocalCode | EnlittUnrecognizedCode;

  /**
   * Always `false`. Enlitt refuses before a provider is ever reached, so no
   * instance of this hierarchy can report otherwise — that is the one
   * question a business needs answered before it retries or bills anything.
   * A provider's own error is never wrapped in this class in the first
   * place; see `normalizeEnlittModelError`.
   */
  readonly providerInvoked: boolean = false;

  /**
   * Read from the frozen record for a wire code, and always `false` for a
   * local code, which has no record entry. Never decided per instance: a
   * refusal carries the non-retryable marker the pinned Vercel AI SDK reads,
   * so a configured `maxRetries` cannot turn one refusal into several.
   */
  readonly retryable: boolean;

  readonly retryAfterMs?: number;
  readonly requestId?: string;

  /**
   * Present only when the record's `authorizeUrl` field for this instance's
   * code is `"allowed"` and a caller supplied one. It is a navigation
   * target, never a disclosure: the actual figures live only on Enlitt's own
   * dashboard behind it.
   *
   * The record allows this on the four `insufficient_credits_error` codes and
   * no others, which is what this module's spec text says. `authorizeUrl` is
   * still read from the record rather than decided here, per this module's own
   * rule; the record simply now agrees with the spec.
   */
  readonly authorizeUrl?: string;

  constructor(
    code: EnlittWireCode | EnlittLocalCode | EnlittUnrecognizedCode,
    message: string,
    facts: EnlittErrorFacts = {}
  ) {
    super(message);
    this.code = code;

    const definition = isEnlittErrorCode(code) ? ENLITT_ERROR_CODES[code] : undefined;
    // A code in the record always reads its retryability from the record. A
    // code from a newer server (not in the record, not local) takes the
    // classifier's status-derived answer; a local code is never retryable.
    this.retryable = definition?.retryable ?? (isLocalCode(code) ? false : (facts.retryable ?? false));

    if (facts.retryAfterMs !== undefined) {
      this.retryAfterMs = facts.retryAfterMs;
    }
    if (facts.requestId !== undefined) {
      this.requestId = facts.requestId;
    }
    // The record decides which known codes may carry a navigation target. For
    // a code from a newer server the protocol classifier has already kept the
    // URL only for a credit refusal with an acceptable origin, so it is copied
    // as given; a local code never carries one.
    if (
      facts.authorizeUrl !== undefined &&
      (definition?.authorizeUrl === "allowed" || (definition === undefined && !isLocalCode(code)))
    ) {
      this.authorizeUrl = facts.authorizeUrl;
    }
  }
}

const LOCAL_CODES: ReadonlySet<string> = new Set<EnlittLocalCode>([
  "configuration_invalid",
  "transport_failed",
  "malformed_response",
  "request_canceled"
]);

function isLocalCode(code: string): code is EnlittLocalCode {
  return LOCAL_CODES.has(code);
}

/**
 * Code `configuration_invalid`. Missing or invalid SDK configuration: absent
 * business secret, browser use, invalid base URL, invalid call options, an
 * invalid quote, or a missing session context. Thrown locally before any
 * network call, so a misconfigured deployment fails without touching Enlitt
 * or a provider. Audience is the business's own logs; it must never reach an
 * end user's screen.
 */
export class EnlittConfigurationError extends EnlittError {
  override readonly name = "EnlittConfigurationError";
  constructor(message: string) {
    super("configuration_invalid", message);
  }
}

/**
 * Code `personal_login_required`. No usable personal session resolves for
 * this application. It belongs to both the standard and premium paths
 * identically, with the provider left uninvoked either way: the alternative
 * — letting premium proceed at the business's own cost — would mean every
 * user whose session expired silently moved their spending onto the
 * business. Audience is the end user: the business sends them through
 * Enlitt login or reauthorization.
 */
export class EnlittLoginRequiredError extends EnlittError {
  override readonly name = "EnlittLoginRequiredError";
  constructor(message: string, facts: EnlittErrorFacts = {}) {
    super(ENLITT_ERROR_CODE.personal_login_required, message, facts);
  }
}

/**
 * Code `spending_limit_exceeded`. One of the user's application limits
 * refused the call. `limitRule` copies `error.enlitt.limit_rule`
 * (`standard_per_call`, `premium_per_call`, `rate.standard`, `rate.premium`,
 * or a rule a newer server added) so the business can explain which limit refused without
 * learning its value. It carries no amount, because a user's ceiling is their
 * own financial position. An unknown future rule stays a string and is
 * rendered generically; this field is never a closed authorization decision.
 * Audience is the end user, who raises the limit at `authorizeUrl`.
 */
export class EnlittLimitExceededError extends EnlittError {
  override readonly name = "EnlittLimitExceededError";
  readonly limitRule: string;
  constructor(message: string, limitRule: string, facts: EnlittErrorFacts = {}) {
    super(ENLITT_ERROR_CODE.spending_limit_exceeded, message, facts);
    this.limitRule = limitRule;
  }
}

/**
 * Codes `premium_balance_exhausted` and `standard_balance_exhausted` (and any
 * credit-refusal code from a newer server, carried raw). The first means the
 * matching allowance plus eligible bundles cannot cover the call; the second
 * is the standard equivalent. `admissibleMaxChargeNanoUsd` is present only on
 * a premium `premium_balance_exhausted`: the largest `maxCharge` the user's
 * remaining credits would admit now, copied byte for byte. It is the protocol's
 * single disclosed figure; the SDK never retries with it on its own. No other
 * balance, plan, tier, or period fact is ever carried. The audience is the
 * end user, who tops up or upgrades at `authorizeUrl`.
 */
export class EnlittInsufficientCreditsError extends EnlittError {
  override readonly name = "EnlittInsufficientCreditsError";
  readonly admissibleMaxChargeNanoUsd?: string;
  constructor(
    code:
      | typeof ENLITT_ERROR_CODE.premium_balance_exhausted
      | typeof ENLITT_ERROR_CODE.standard_balance_exhausted
      | EnlittUnrecognizedCode,
    message: string,
    facts: EnlittErrorFacts & { readonly admissibleMaxChargeNanoUsd?: string } = {}
  ) {
    super(code, message, facts);
    if (facts.admissibleMaxChargeNanoUsd !== undefined) {
      this.admissibleMaxChargeNanoUsd = facts.admissibleMaxChargeNanoUsd;
    }
  }
}

/**
 * Code `subscription_inactive`. No subscription period covers the current
 * instant. Because every registered user holds at least the free plan, this
 * is exceptional rather than the ordinary state of a user who has not paid:
 * a user who never subscribed, lapsed, or canceled receives
 * `EnlittInsufficientCreditsError` at free-plan ceilings instead. Audience is
 * the end user, but a business seeing this at any volume should treat it as
 * a defect signal rather than a funnel step.
 */
export class EnlittSubscriptionInactiveError extends EnlittError {
  override readonly name = "EnlittSubscriptionInactiveError";
  constructor(message: string, facts: EnlittErrorFacts = {}) {
    super(ENLITT_ERROR_CODE.subscription_inactive, message, facts);
  }
}

/**
 * Code `rate_limit_exceeded`. This user has started as many standard calls as
 * their plan allows for the current minute. Only the standard path raises it:
 * a premium operation consumes no request budget. It is the only refusal-shaped
 * condition that is retryable, and the only class that carries
 * `retryAfterMs` in practice. It is emphatically not an
 * `EnlittInsufficientCreditsError`: conflating a transient wait with an
 * exhausted balance would tell users to buy credits they do not need. It
 * carries no rate, remaining request count, or plan fact, because those are
 * the user's plan details.
 */
export class EnlittRateLimitError extends EnlittError {
  override readonly name = "EnlittRateLimitError";
  constructor(message: string, facts: EnlittErrorFacts = {}) {
    super(ENLITT_ERROR_CODE.rate_limit_exceeded, message, facts);
  }
}

/**
 * Code `invalid_api_key`. The presented business key is missing, invalid, or
 * revoked. Audience is the business's own logs; never rendered to an end
 * user, and never softened into a direct provider call.
 */
export class EnlittAuthenticationError extends EnlittError {
  override readonly name = "EnlittAuthenticationError";
  constructor(message: string, facts: EnlittErrorFacts = {}) {
    super(ENLITT_ERROR_CODE.invalid_api_key, message, facts);
  }
}

/** The two wire codes `EnlittAuthorizationError` carries. */
export type EnlittAuthorizationCode =
  | typeof ENLITT_ERROR_CODE.insufficient_permissions
  | typeof ENLITT_ERROR_CODE.premium_not_enabled;

/**
 * A business credential or configuration problem. Audience is the business's
 * own logs; never rendered to an end user, and never softened into a direct
 * provider call. Two codes:
 *
 * - `insufficient_permissions` (the default): the presented business key is
 *   valid but used outside its authenticated application or scope.
 * - `premium_not_enabled` (owner decision 2026-10-25): the application's
 *   premium switch is off, or changed during the call. On a refused premium
 *   start no provider was invoked; on a refused terminal report the provider
 *   already ran and the call was not charged.
 */
export class EnlittAuthorizationError extends EnlittError {
  override readonly name = "EnlittAuthorizationError";
  constructor(
    message: string,
    facts: EnlittErrorFacts = {},
    code: EnlittAuthorizationCode = ENLITT_ERROR_CODE.insufficient_permissions
  ) {
    super(code, message, facts);
  }
}

/**
 * Per-code facts the protocol classifier extracted that only some classes
 * carry. Passed to every factory so the table stays uniform.
 */
interface ClassifiedExtras {
  readonly limitRule?: string;
  readonly admissibleMaxChargeNanoUsd?: string;
}

/** One wire code's constructor, uniform across every entry in the map below. */
type WireErrorFactory = (message: string, facts: EnlittErrorFacts, extras: ClassifiedExtras) => EnlittError;

/**
 * The wire-code-to-class mapping, exhaustive over the protocol record by
 * construction: `satisfies Record<EnlittWireCode, WireErrorFactory>` rejects
 * this object literal at compile time if it is missing a key the record
 * defines, and rejects it just as loudly if it carries a key the record does
 * not, so a code added to the protocol without a class here fails the build
 * instead of falling through to the base class at runtime.
 *
 * Codes with no distinct business action of their own (dashboard-only codes,
 * validation, conflicts, server failures) use the base class carrying their
 * stable code; every other entry uses the subclass named for it.
 */
const WIRE_CODE_FACTORY = {
  personal_login_required: (message, facts) => new EnlittLoginRequiredError(message, facts),
  spending_limit_exceeded: (message, facts, extras) =>
    new EnlittLimitExceededError(message, extras.limitRule ?? "unrecognized", facts),
  premium_balance_exhausted: (message, facts, extras) =>
    new EnlittInsufficientCreditsError(ENLITT_ERROR_CODE.premium_balance_exhausted, message, {
      ...facts,
      ...(extras.admissibleMaxChargeNanoUsd !== undefined
        ? { admissibleMaxChargeNanoUsd: extras.admissibleMaxChargeNanoUsd }
        : {})
    }),
  standard_balance_exhausted: (message, facts) =>
    new EnlittInsufficientCreditsError(ENLITT_ERROR_CODE.standard_balance_exhausted, message, facts),
  subscription_inactive: (message, facts) => new EnlittSubscriptionInactiveError(message, facts),
  rate_limit_exceeded: (message, facts) => new EnlittRateLimitError(message, facts),
  invalid_api_key: (message, facts) => new EnlittAuthenticationError(message, facts),
  insufficient_permissions: (message, facts) => new EnlittAuthorizationError(message, facts),
  premium_not_enabled: (message, facts) =>
    new EnlittAuthorizationError(message, facts, ENLITT_ERROR_CODE.premium_not_enabled),
  dashboard_login_required: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.dashboard_login_required, message, facts),
  admin_authentication_required: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.admin_authentication_required, message, facts),
  conflict_error: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.conflict_error, message, facts),
  operation_in_progress: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.operation_in_progress, message, facts),
  idempotency_replay_unavailable: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.idempotency_replay_unavailable, message, facts),
  invalid_value: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.invalid_value, message, facts),
  unsupported_parameter: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.unsupported_parameter, message, facts),
  unsupported_value: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.unsupported_value, message, facts),
  reauthentication_required: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.reauthentication_required, message, facts),
  payment_declined: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.payment_declined, message, facts),
  invalid_sign_in_code: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.invalid_sign_in_code, message, facts),
  not_found: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.not_found, message, facts),
  request_too_large: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.request_too_large, message, facts),
  server_error: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.server_error, message, facts),
  provider_error: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.provider_error, message, facts),
  business_selection_required: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.business_selection_required, message, facts),
  bot_verification_failed: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.bot_verification_failed, message, facts),
  phone_verification_required: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.phone_verification_required, message, facts),
  invalid_phone_code: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.invalid_phone_code, message, facts),
  phone_number_not_supported: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.phone_number_not_supported, message, facts),
  phone_number_unavailable: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.phone_number_unavailable, message, facts),
  business_name_unavailable: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.business_name_unavailable, message, facts),
  // The four CLI device-flow codes (RFC 8628). No SDK route can return them, but
  // the mapping is exhaustive over the record, so they surface as the base class.
  authorization_pending: (message, facts) =>
    new EnlittError(ENLITT_ERROR_CODE.authorization_pending, message, facts),
  slow_down: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.slow_down, message, facts),
  access_denied: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.access_denied, message, facts),
  expired_token: (message, facts) => new EnlittError(ENLITT_ERROR_CODE.expired_token, message, facts)
} as const satisfies Record<EnlittWireCode, WireErrorFactory>;

/**
 * An Enlitt HTTP error response, shaped for normalization: the HTTP status,
 * the parsed JSON body (untrusted, hence `unknown`), and the two response
 * headers normalization reads. `core/transport.ts` is the only intended
 * producer of this shape.
 */
export interface EnlittHttpErrorResponse {
  readonly kind: "http_error";
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/** A request that never produced an HTTP response at all. */
export interface EnlittTransportFailure {
  readonly kind: "transport_failed";
  readonly message?: string;
}

/** A response that was received but could not be parsed as Enlitt's contract. */
export interface EnlittMalformedResponse {
  readonly kind: "malformed_response";
  readonly message?: string;
}

/** A caller-initiated abort of a request still in flight. */
export interface EnlittRequestCanceled {
  readonly kind: "request_canceled";
  readonly message?: string;
}

/**
 * Every shape `normalizeEnlittModelError` recognizes. `error` is typed
 * `unknown` at the function boundary because it is handed whatever the
 * transport or the runtime threw; this union is what it is checked against.
 */
export type EnlittNormalizationInput =
  | EnlittHttpErrorResponse
  | EnlittTransportFailure
  | EnlittMalformedResponse
  | EnlittRequestCanceled;

function hasKind(value: unknown): value is { readonly kind: unknown } {
  return typeof value === "object" && value !== null && "kind" in value;
}

/**
 * Converts the wire's `Retry-After` seconds into milliseconds exactly once,
 * at the point the response is parsed. A missing or unparseable header
 * leaves the result `undefined` rather than defaulting to zero, because a
 * zero would invite an immediate retry into a limit that has not moved.
 */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * Maps an HTTP error response through the protocol's shared classifier, so
 * the SDK, the frontend, and the fixture tests classify an error the same
 * way. This function never parses the error body itself.
 */
function normalizeHttpErrorResponse(input: EnlittHttpErrorResponse): EnlittError {
  const requestId = input.headers["x-request-id"];
  const classified = classifyEnlittErrorResponse(input.status, input.body);

  // A body that is neither error envelope (an HTML gateway page, an empty
  // body, a JSON array): no code can be trusted, so it is a malformed response.
  if (classified === null) {
    return new EnlittError(
      "malformed_response",
      `Enlitt returned HTTP ${String(input.status)} with a body that is not an Enlitt error.`,
      requestId !== undefined ? { requestId } : {}
    );
  }

  const message = classified.message ?? "Enlitt refused the request.";

  if (classified.recognized && isEnlittErrorCode(classified.code)) {
    const retryAfterMs = parseRetryAfterMs(input.headers["retry-after"]);
    const facts: EnlittErrorFacts = {
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(classified.authorizeUrl !== undefined ? { authorizeUrl: classified.authorizeUrl } : {})
    };
    return WIRE_CODE_FACTORY[classified.code](message, facts, {
      ...(classified.limitRule !== undefined ? { limitRule: classified.limitRule } : {}),
      ...(classified.admissibleMaxChargeNanoUsd !== undefined
        ? { admissibleMaxChargeNanoUsd: classified.admissibleMaxChargeNanoUsd }
        : {})
    });
  }

  // A code this SDK does not recognize: most likely a newer backend. It never
  // throws and never fails the build. `Retry-After` is deliberately ignored,
  // because only a code the record marks `retryAfter: "required"` is known to
  // mean "wait and repeat", and a 429 with an unknown code is never the
  // rate-limit class so it is surfaced once instead of retried blindly.
  const upgradeMessage =
    `Enlitt returned error code "${classified.code}" (HTTP ${String(classified.status)}, type ` +
    `"${classified.type ?? "none"}"), which this version of @enlitt/sdk does not recognize. ` +
    "Upgrade @enlitt/sdk to handle it." +
    (classified.message !== null ? ` ${classified.message}` : "");
  const facts: EnlittErrorFacts = {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(classified.authorizeUrl !== undefined ? { authorizeUrl: classified.authorizeUrl } : {}),
    retryable: classified.retryable
  };
  if (classified.creditRefusal) {
    return new EnlittInsufficientCreditsError(classified.code, upgradeMessage, facts);
  }
  return new EnlittError(classified.code, upgradeMessage, facts);
}

/**
 * Maps one Enlitt failure to exactly one class.
 *
 * `providerInvoked` is accepted for signature symmetry with callers that
 * track it across the premium path, but every value returned is an
 * `EnlittError`, whose `providerInvoked` is always `false`: Enlitt refuses
 * before a provider is reached. A provider's own error is never routed
 * through this function; the premium path rethrows it unchanged.
 *
 * The mapping is keyed on the stable code alone, never on HTTP status: a
 * `429` carrying any code other than `rate_limit_exceeded` does not become
 * `EnlittRateLimitError`.
 */
export function normalizeEnlittModelError(error: unknown, providerInvoked: boolean): EnlittError {
  void providerInvoked;

  if (hasKind(error)) {
    switch (error.kind) {
      case "http_error":
        return normalizeHttpErrorResponse(error as EnlittHttpErrorResponse);
      case "transport_failed": {
        const input = error as EnlittTransportFailure;
        return new EnlittError(
          "transport_failed",
          input.message ?? "The request to Enlitt failed before a response was received."
        );
      }
      case "request_canceled": {
        const input = error as EnlittRequestCanceled;
        return new EnlittError("request_canceled", input.message ?? "The request was canceled before it completed.");
      }
      case "malformed_response":
      default:
        break;
    }
  }

  const input = hasKind(error) && error.kind === "malformed_response" ? (error as EnlittMalformedResponse) : undefined;
  return new EnlittError("malformed_response", input?.message ?? "Enlitt's response could not be parsed.");
}
