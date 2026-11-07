import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3ProviderOptions
} from "@ai-sdk/provider";
import { ENLITT_STANDARD_MODEL } from "@enlitt/protocol";
import { EnlittConfigurationError } from "../core/errors.js";
import {
  assertCallId,
  assertCallerMetadata,
  assertIdempotencyKeyBase,
  assertNanoUsd,
  assertReportingDeadlineMs,
  generateRandomCallId
} from "../core/premium.js";
import { createInternalClient, type EnlittOptions } from "../core/transport.js";
import { createStandardLanguageModel } from "./standard-language-model.js";
import { createPremiumLanguageModel } from "./premium-language-model.js";

/**
 * The only standard model string. There is no second public factory, client
 * class, or model string in v1: this is a re-export of `@enlitt/protocol`'s
 * own constant rather than a second literal, so the string a business passes
 * to `enlitt()` and the `model` field the wire actually sees can never drift
 * apart.
 */
export { ENLITT_STANDARD_MODEL };

/**
 * What `enlitt()` accepts as its first argument: Enlitt's own standard model
 * string, or a provider model the business selected and pays for. The mode
 * is the argument's type, not a separate field, so there is no "unknown
 * mode" case and no "premium model missing" case; both are unrepresentable.
 */
export type EnlittTarget = typeof ENLITT_STANDARD_MODEL | LanguageModelV3;

/**
 * The only public model factory in this package.
 *
 * `enlitt("enlitt-standard")` returns Enlitt's own standard model;
 * `enlitt(myProviderModel)` returns transparent middleware around it in
 * premium mode. Both modes require the business's application secret, resolved
 * once here by `createInternalClient()`, which also asserts a server runtime
 * (before any secret is touched) and resolves and validates the base URL once.
 * A missing or invalid secret is an `EnlittConfigurationError` thrown before the
 * first request, in premium exactly as in standard. There is no configuration
 * under which this function returns a model that would reach a provider without
 * Enlitt: a business whose configuration silently degraded would pay for its
 * users' premium calls and see nothing wrong until the provider bill arrived.
 *
 * It builds exactly one internal client per call and hands it to whichever
 * model it returns. `EnlittOptions` is declared once, in core, and shared with
 * `withPremiumCharge()` and `usage()`.
 */
export function enlitt(target: EnlittTarget, options: EnlittOptions = {}): LanguageModelV3 {
  const client = createInternalClient(options);

  if (target === ENLITT_STANDARD_MODEL) {
    return createStandardLanguageModel(client);
  }
  return createPremiumLanguageModel(client, target);
}

// --- Per-call provider options ---------------------------------------------

/**
 * What a premium call states it costs: a constant NANOUSD amount, or a
 * function that computes one once the call has ended. A function runs exactly
 * once per operation, only when the call ends `completed` or `canceled`, may be
 * async, and is never called for `failed`, which reports `"0"`.
 */
export type EnlittPrice = string | ((context: PremiumPriceContext) => string | Promise<string>);

/**
 * Everything the SDK knows when a premium call ends, and nothing it does not.
 * It never leaves the business's process.
 */
export interface PremiumPriceContext {
  readonly status: "completed" | "canceled";
  /**
   * For `doGenerate`, the result's content. For `doStream`, every part the
   * provider emitted up to its end or the cancellation, in order. Stream parts
   * are collected only when `price` is a function.
   */
  readonly output:
    | { readonly kind: "generate"; readonly content: readonly LanguageModelV3Content[] }
    | { readonly kind: "stream"; readonly parts: readonly LanguageModelV3StreamPart[] };
  /** Possibly absent on a cancellation. */
  readonly usage?: LanguageModelV3Usage;
  /** Absent on a cancellation before a finish part. */
  readonly finishReason?: LanguageModelV3FinishReason;
  readonly providerMetadata?: SharedV3ProviderMetadata;
  /** Provider invocation start. */
  readonly startedAt: Date;
  /** The end or cancellation instant. */
  readonly endedAt: Date;
  readonly durationMs: number;
  /** Present only for a stream that emitted a content part. */
  readonly timeToFirstTokenMs?: number;
  /** The bound every price for this call is lowered to; it may be below the declared `maxCharge`. */
  readonly effectiveMaxChargeNanoUsd: string;
}

/**
 * The validated result of `readEnlittCallOptions()`: `providerOptions.enlitt`
 * as the SDK works with it. Every field is optional at the type level because
 * validity depends on `mode`; `readEnlittCallOptions()` is the one place that
 * mode-dependent shape is enforced.
 */
export interface EnlittProviderOptions {
  /** A base for the call identity, not the identity itself; see `resolveCallId()`. 16-200 visible ASCII characters. */
  idempotencyKey?: string;
  /** NANOUSD, premium only. Required unless `price` is a constant, in which case it defaults to that constant. */
  maxCharge?: string;
  /** Premium only. Without it a call charges `"0"` for every status. */
  price?: EnlittPrice;
  /** Premium only. How long the business needs before it will report the terminal outcome. */
  reportingDeadlineMs?: number;
  /** At most 16 entries, keys at most 64 characters, values at most 512, no key beginning with `enlitt_`. */
  metadata?: Record<string, string>;
}

/**
 * The closed set of keys `providerOptions.enlitt` accepts. Anything else
 * (including the former `charge` option, and any attempt to name a personal
 * user by token, ID, email, subject, or hint) is rejected as unknown, which is
 * what makes it impossible to pass a user through this surface: there is no
 * field name under which one would be accepted.
 */
const KNOWN_ENLITT_OPTION_KEYS: ReadonlySet<string> = new Set([
  "idempotencyKey",
  "maxCharge",
  "price",
  "reportingDeadlineMs",
  "metadata"
]);

/**
 * Runtime-validates `providerOptions.enlitt` on every invocation. There is no
 * `managed` parameter and no unmanaged case: every call in either mode is
 * managed. Every failure is an `EnlittConfigurationError` raised before any
 * Enlitt or provider request, and other provider namespaces are never touched.
 *
 * Premium combinations: a constant `price` alone sets `maxCharge` to it;
 * `maxCharge` alone charges `"0"`; a function `price` without `maxCharge` is
 * rejected (a function's result is only known after the provider has run and
 * the maximum must be known before); a constant `price` above `maxCharge` is
 * rejected (it could never be charged in full); neither is rejected.
 */
export function readEnlittCallOptions(
  providerOptions: SharedV3ProviderOptions | undefined,
  mode: "standard" | "premium"
): EnlittProviderOptions {
  // Read as `unknown` rather than through `SharedV3ProviderOptions`'s declared
  // `JSONObject` type: that type is this package's promise about what it sends,
  // not a guarantee about what an untyped or misbehaving caller passes at
  // runtime, and a `price` function is deliberately not JSON.
  const raw: unknown = providerOptions?.enlitt;
  if (raw === undefined) {
    if (mode === "premium") {
      throw new EnlittConfigurationError(
        "A premium call requires providerOptions.enlitt.maxCharge, or a constant providerOptions.enlitt.price."
      );
    }
    return {};
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EnlittConfigurationError("providerOptions.enlitt must be an object.");
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!KNOWN_ENLITT_OPTION_KEYS.has(key)) {
      throw new EnlittConfigurationError(`providerOptions.enlitt.${key} is not a recognized Enlitt option.`);
    }
  }

  if (mode === "standard") {
    for (const key of ["maxCharge", "price", "reportingDeadlineMs"]) {
      if (input[key] !== undefined) {
        throw new EnlittConfigurationError(
          `providerOptions.enlitt.${key} is a premium-only option; Enlitt's standard route chooses its own model and charges nothing the business declares.`
        );
      }
    }
  }

  const idempotencyKey =
    input.idempotencyKey !== undefined
      ? assertIdempotencyKeyBase(input.idempotencyKey, "providerOptions.enlitt.idempotencyKey")
      : undefined;
  const metadata =
    input.metadata !== undefined ? assertCallerMetadata(input.metadata, "providerOptions.enlitt.metadata") : undefined;

  let maxCharge: string | undefined;
  let price: EnlittPrice | undefined;
  let reportingDeadlineMs: number | undefined;

  if (mode === "premium") {
    ({ maxCharge, price } = readPremiumPricing(input));
    if (input.reportingDeadlineMs !== undefined) {
      reportingDeadlineMs = assertReportingDeadlineMs(
        input.reportingDeadlineMs,
        "providerOptions.enlitt.reportingDeadlineMs"
      );
    }
  }

  return {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(maxCharge !== undefined ? { maxCharge } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(reportingDeadlineMs !== undefined ? { reportingDeadlineMs } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  };
}

/**
 * Validates `maxCharge` and `price` together for a premium call and resolves
 * the maximum the call declares at begin. Both are NANOUSD amounts, never
 * counts of credit units: canonical nonnegative integer strings parsed as
 * `bigint`, with `"0"` valid for both.
 */
function readPremiumPricing(input: Record<string, unknown>): { maxCharge: string; price: EnlittPrice | undefined } {
  const rawPrice = input.price;
  let price: EnlittPrice | undefined;
  if (rawPrice !== undefined) {
    price =
      typeof rawPrice === "function"
        ? (rawPrice as Extract<EnlittPrice, (...args: never[]) => unknown>)
        : assertNanoUsd(rawPrice, "providerOptions.enlitt.price");
  }

  let maxCharge: string | undefined;
  if (input.maxCharge !== undefined) {
    maxCharge = assertNanoUsd(input.maxCharge, "providerOptions.enlitt.maxCharge");
  }

  if (maxCharge === undefined) {
    // `maxCharge` is required unless `price` is a constant, in which case it
    // defaults to that constant. A function's result is only known after the
    // provider has run; the maximum must be known before.
    if (typeof price === "string") {
      maxCharge = price;
    } else if (typeof price === "function") {
      throw new EnlittConfigurationError(
        "providerOptions.enlitt.maxCharge is required when providerOptions.enlitt.price is a function."
      );
    } else {
      throw new EnlittConfigurationError(
        "A premium call requires providerOptions.enlitt.maxCharge, or a constant providerOptions.enlitt.price."
      );
    }
  } else if (typeof price === "string" && BigInt(price) > BigInt(maxCharge)) {
    throw new EnlittConfigurationError(
      "providerOptions.enlitt.price is above providerOptions.enlitt.maxCharge and could never be charged in full."
    );
  }

  return { maxCharge, price };
}

// --- Call identity -----------------------------------------------------

/**
 * Derives the one identity of a single underlying model invocation. Sent as
 * `Idempotency-Key` on both paths and as `call_id` (via the same
 * `Idempotency-Key`) on the premium preflight; there is no second identifier.
 *
 * `callId` is `` `${base}.${params.prompt.length}` ``, where `base` is
 * `options.idempotencyKey` when supplied and otherwise a freshly generated
 * random value unique per invocation. The suffix — the count of prompt items,
 * never a hash or any other read of content — is what makes the identity
 * behave correctly in a tool loop: within one `generateText` loop the prompt
 * grows by at least one item before each subsequent provider invocation, so
 * distinct steps get distinct IDs, while a retry of the same step
 * re-presents the identical prompt and so reuses the ID.
 *
 * The resulting ID is validated against the protocol's own 16-255
 * visible-ASCII `Idempotency-Key` bound before it is returned, converting a
 * violation into `EnlittConfigurationError` rather than sending an
 * out-of-bounds header. With `idempotencyKey` bounded at the protocol's own
 * floor by `readEnlittCallOptions()`, no reachable input violates that bound;
 * the check stays as the one place the wire rule is enforced, so a future
 * change to either end cannot ship an out-of-bounds header silently.
 */
export function resolveCallId(options: EnlittProviderOptions, params: LanguageModelV3CallOptions): string {
  const base = options.idempotencyKey ?? generateRandomCallId();
  // `assertCallId` enforces the protocol's 16-255 visible-ASCII bound and
  // raises `EnlittConfigurationError`; with the base already at the protocol's
  // own floor no reachable input violates it, so the check only guards a
  // future change to either end.
  return assertCallId(`${base}.${params.prompt.length}`);
}
