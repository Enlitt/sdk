/**
 * The dashboard/reporting wire contract: every shape `specs/PROTOCOLS.md`
 * "Dashboard schema ownership" assigns to this package, and its hand-written
 * runtime validators.
 *
 * Read scope for this module: `specs/PROTOCOLS.md` "Frontend" —
 * "Personal dashboard" through "Dashboard schema ownership" (the personal
 * read model and its closed-period usage read, verified contacts,
 * authorization consent, the plan catalog, the business read model shared by
 * `GET /v1/dashboard/business` and `GET /v1/business/info`, and every
 * business mutation) — plus the opening paragraph's "unknown fields are
 * rejected unless explicitly allowed" rule and the canonical-integer rules it
 * states for every credit/NANOUSD field.
 *
 * Every validator here checks **field names**, not structure: a response
 * whose fields were renamed to same-typed values fails even though a
 * presence/type-only check would have passed it. This is what
 * "Dashboard schema ownership" names as the whole point of moving these
 * declarations into this package — a hand-written parser in a client is a
 * second declaration of a shape this package owns, and two declarations
 * drift silently on a rename.
 *
 * Request validators always reject unknown fields. Response validators are
 * strict by default, while `{ mode: "tolerant" }` drops unknown fields and
 * maps future closed-enum members to the reserved `"other"` value.
 *
 * `redirect_uris`/`allowed_origins` are "bounded in count and length" per
 * `specs/PROTOCOLS.md`, but — like `JsonSchema`'s depth/size bounds in
 * `responses.ts` — no numeric bound is stated in this module's read scope.
 * This module enforces every categorical rule the text does state (absolute
 * URL, no fragment/userinfo/wildcard, `https` except on a loopback host, an
 * origin with no path or query, no duplicates) and leaves the numeric bounds
 * as an open item for whichever deployed policy defines them.
 */

import { isCanonicalIntegerString } from "./canonical-integer.js";
import { UNKNOWN_ENUM_VALUE, type ParseOptions, type Readable } from "./compatibility.js";
import { ENLITT_ERROR_CODE } from "./errors.js";
import type { ResponseRequestErrorCode, ResponseValidationResult } from "./responses.js";

type Result<T> = ResponseValidationResult<T>;

let responseParseMode: "strict" | "tolerant" = "strict";

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail(code: ResponseRequestErrorCode, param: string, message: string): Result<never> {
  return { ok: false, error: { code, param, message } };
}

function invalidValue(param: string, message: string): Result<never> {
  return fail(ENLITT_ERROR_CODE.invalid_value, param, message);
}

function unsupportedParameter(param: string, message: string): Result<never> {
  return fail(ENLITT_ERROR_CODE.unsupported_parameter, param, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Response parsing is deliberately separate from request validation. Request
 * validators never set this mode, so an unknown request field or enum member
 * remains a refusal even when a client is reading a future response nearby.
 */
function withResponseOptions<T>(
  value: unknown,
  options: ParseOptions | undefined,
  parse: () => Result<T>
): Result<T> {
  const previousMode = responseParseMode;
  // A response validator may call another response validator. An omitted
  // nested option inherits the outer reader's mode; a top-level call starts
  // from the module's strict default.
  responseParseMode = options?.mode ?? previousMode;
  try {
    const result = parse();
    if (!result.ok || responseParseMode === "tolerant") return result;
    const unknown = findUnknownResponseField(value, result.value, "body");
    return unknown === null
      ? result
      : unsupportedParameter(unknown, `"${unknown}" is not accepted by this response`);
  } finally {
    responseParseMode = previousMode;
  }
}

/**
 * Response parsers construct a new value from documented fields. Comparing
 * that value to the received JSON catches unknown keys at every nested shape
 * in strict mode, while the constructed tolerant value naturally drops them.
 */
function findUnknownResponseField(value: unknown, parsed: unknown, param: string): string | null {
  if (Array.isArray(value) && Array.isArray(parsed)) {
    for (const [index, item] of value.entries()) {
      const unknown = findUnknownResponseField(item, parsed[index], `${param}[${index}]`);
      if (unknown !== null) return unknown;
    }
    return null;
  }
  if (!isPlainObject(value) || !isPlainObject(parsed)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (!(key in parsed)) return `${param}.${key}`;
    const unknown = findUnknownResponseField(item, parsed[key], `${param}.${key}`);
    if (unknown !== null) return unknown;
  }
  return null;
}

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;
const CALENDAR_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function expectRfc3339(value: unknown, param: string): Result<string> {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    return invalidValue(param, "must be an RFC 3339 timestamp");
  }
  return ok(value);
}

function expectNullableRfc3339(value: unknown, param: string): Result<string | null> {
  if (value === null) return ok(null);
  return expectRfc3339(value, param);
}

function expectOptionalRfc3339(value: unknown, param: string): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  return expectRfc3339(value, param);
}

function expectCalendarDay(value: unknown, param: string): Result<string> {
  if (typeof value !== "string" || !CALENDAR_DAY_PATTERN.test(value)) {
    return invalidValue(param, "must be a YYYY-MM-DD calendar day");
  }
  return ok(value);
}

function expectString(value: unknown, param: string): Result<string> {
  if (typeof value !== "string") return invalidValue(param, "must be a string");
  return ok(value);
}

function expectOptionalString(value: unknown, param: string): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  return expectString(value, param);
}

function expectNullableString(value: unknown, param: string): Result<string | null> {
  if (value === null) return ok(null);
  return expectString(value, param);
}

function expectBoolean(value: unknown, param: string): Result<boolean> {
  if (typeof value !== "boolean") return invalidValue(param, "must be a boolean");
  return ok(value);
}

function expectInteger(value: unknown, param: string): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return invalidValue(param, "must be an integer");
  }
  return ok(value);
}

function expectNonNegativeInteger(value: unknown, param: string): Result<number> {
  const result = expectInteger(value, param);
  if (!result.ok) return result;
  if (result.value < 0) return invalidValue(param, "must be a nonnegative integer");
  return result;
}

function expectCanonicalAmount(value: unknown, param: string): Result<string> {
  if (!isCanonicalIntegerString(value)) {
    return invalidValue(param, "must be a canonical base-10 integer string");
  }
  return ok(value);
}

function expectNullableCanonicalAmount(value: unknown, param: string): Result<string | null> {
  if (value === null) return ok(null);
  return expectCanonicalAmount(value, param);
}

function expectOptionalCanonicalAmount(value: unknown, param: string): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  return expectCanonicalAmount(value, param);
}

/** Strictly positive: zero and negative amounts are rejected. */
function expectPositiveCanonicalAmount(value: unknown, param: string): Result<string> {
  const result = expectCanonicalAmount(value, param);
  if (!result.ok) return result;
  if (BigInt(result.value) <= 0n) return invalidValue(param, "must be strictly positive");
  return result;
}

/** Zero is allowed: a per-call limit or a settings default may legitimately be `"0"`. */
function expectNonNegativeCanonicalAmount(value: unknown, param: string): Result<string> {
  return expectCanonicalAmount(value, param);
}

function expectLiteral<T extends string>(
  value: unknown,
  options: readonly T[],
  param: string
): Result<T> {
  if (typeof value === "string") {
    for (const option of options) {
      if (option === value) return ok(option);
    }
    if (responseParseMode === "tolerant") return ok(UNKNOWN_ENUM_VALUE as T);
  }
  return invalidValue(param, `must be one of: ${options.join(", ")}`);
}

function expectNullableLiteral<T extends string>(
  value: unknown,
  options: readonly T[],
  param: string
): Result<T | null> {
  if (value === null) return ok(null);
  return expectLiteral(value, options, param);
}

/**
 * Rejects a request body whose keys are not exactly among `allowed`, keyed
 * by wire field name so the caller learns which one is unrecognized.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): Result<void> {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return unsupportedParameter(key, `"${key}" is not accepted by this route`);
    }
  }
  return ok(undefined);
}

/** Response-only exact-shape check; tolerant readers intentionally drop additions. */
function rejectUnknownResponseKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): Result<void> {
  return responseParseMode === "tolerant" ? ok(undefined) : rejectUnknownKeys(value, allowed);
}

// ---------------------------------------------------------------------------
// Shared: SubscriptionPlanSummary
// ---------------------------------------------------------------------------

/**
 * "the identity subset of a catalog entry, carrying no included amounts and
 * no limits". Used identically by `usage.plan`, `subscription.plan`, and
 * `subscription.pending_plan` — one declaration for all three positions.
 */
export interface SubscriptionPlanSummary {
  readonly id: string;
  readonly display_name: string;
  readonly is_free: boolean;
  readonly price_minor_units: string;
  readonly currency: string;
  readonly interval: Readable<"month" | "year">;
  readonly catalog_version: string;
}

export const PLAN_INTERVALS = ["month", "year"] as const;

export function validateSubscriptionPlanSummary(
  value: unknown,
  param = "plan",
  options?: ParseOptions
): Result<SubscriptionPlanSummary> {
  return withResponseOptions(value, options, () => validateSubscriptionPlanSummaryShape(value, param));
}

function validateSubscriptionPlanSummaryShape(
  value: unknown,
  param: string
): Result<SubscriptionPlanSummary> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const displayName = expectString(value.display_name, `${param}.display_name`);
  if (!displayName.ok) return displayName;
  const isFree = expectBoolean(value.is_free, `${param}.is_free`);
  if (!isFree.ok) return isFree;
  const priceMinorUnits = expectCanonicalAmount(
    value.price_minor_units,
    `${param}.price_minor_units`
  );
  if (!priceMinorUnits.ok) return priceMinorUnits;
  const currency = expectString(value.currency, `${param}.currency`);
  if (!currency.ok) return currency;
  const interval = expectLiteral(value.interval, PLAN_INTERVALS, `${param}.interval`);
  if (!interval.ok) return interval;
  const catalogVersion = expectString(value.catalog_version, `${param}.catalog_version`);
  if (!catalogVersion.ok) return catalogVersion;
  return ok({
    id: id.value,
    display_name: displayName.value,
    is_free: isFree.value,
    price_minor_units: priceMinorUnits.value,
    currency: currency.value,
    interval: interval.value,
    catalog_version: catalogVersion.value
  });
}

// ---------------------------------------------------------------------------
// Personal dashboard: usage
// ---------------------------------------------------------------------------

export interface PersonalStandardUsage {
  readonly used: string;
  readonly reserved: string;
  readonly limit: string | null;
  readonly service_tier: Readable<"normal" | "reduced" | "minimum"> | null;
}

export const SERVICE_TIERS = ["normal", "reduced", "minimum"] as const;

function validatePersonalStandardUsage(
  value: unknown,
  param: string
): Result<PersonalStandardUsage> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const used = expectCanonicalAmount(value.used, `${param}.used`);
  if (!used.ok) return used;
  const reserved = expectCanonicalAmount(value.reserved, `${param}.reserved`);
  if (!reserved.ok) return reserved;
  const limit = expectNullableCanonicalAmount(value.limit, `${param}.limit`);
  if (!limit.ok) return limit;
  const serviceTier = expectNullableLiteral(
    value.service_tier,
    SERVICE_TIERS,
    `${param}.service_tier`
  );
  if (!serviceTier.ok) return serviceTier;
  return ok({
    used: used.value,
    reserved: reserved.value,
    limit: limit.value,
    service_tier: serviceTier.value
  });
}

export interface PersonalPremiumUsage {
  readonly used: string;
  readonly reserved: string;
  readonly limit: string;
}

function validatePersonalPremiumUsage(value: unknown, param: string): Result<PersonalPremiumUsage> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const used = expectCanonicalAmount(value.used, `${param}.used`);
  if (!used.ok) return used;
  const reserved = expectCanonicalAmount(value.reserved, `${param}.reserved`);
  if (!reserved.ok) return reserved;
  const limit = expectCanonicalAmount(value.limit, `${param}.limit`);
  if (!limit.ok) return limit;
  // `used` may legitimately exceed `limit` (a settled chargeback); that is
  // not a validation failure, per `specs/PROTOCOLS.md`.
  return ok({ used: used.value, reserved: reserved.value, limit: limit.value });
}

/**
 * Shared by `usage` on `GET /v1/dashboard/personal` (nullable) and the
 * closed-period read `GET /v1/dashboard/personal/usage` (never null): one
 * declaration for both.
 */
export interface PersonalUsagePeriod {
  readonly period_start: string;
  readonly period_end: string;
  readonly plan: SubscriptionPlanSummary;
  readonly standard: PersonalStandardUsage;
  readonly premium: PersonalPremiumUsage;
}

export function validatePersonalUsagePeriod(
  value: unknown,
  param = "usage",
  options?: ParseOptions
): Result<PersonalUsagePeriod> {
  return withResponseOptions(value, options, () => validatePersonalUsagePeriodShape(value, param));
}

function validatePersonalUsagePeriodShape(value: unknown, param: string): Result<PersonalUsagePeriod> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const periodStart = expectRfc3339(value.period_start, `${param}.period_start`);
  if (!periodStart.ok) return periodStart;
  const periodEnd = expectRfc3339(value.period_end, `${param}.period_end`);
  if (!periodEnd.ok) return periodEnd;
  const plan = validateSubscriptionPlanSummaryShape(value.plan, `${param}.plan`);
  if (!plan.ok) return plan;
  const standard = validatePersonalStandardUsage(value.standard, `${param}.standard`);
  if (!standard.ok) return standard;
  const premium = validatePersonalPremiumUsage(value.premium, `${param}.premium`);
  if (!premium.ok) return premium;
  return ok({
    period_start: periodStart.value,
    period_end: periodEnd.value,
    plan: plan.value,
    standard: standard.value,
    premium: premium.value
  });
}

function validatePersonalUsagePeriodOrNull(
  value: unknown,
  param: string
): Result<PersonalUsagePeriod | null> {
  if (value === null) return ok(null);
  return validatePersonalUsagePeriodShape(value, param);
}

// ---------------------------------------------------------------------------
// Personal dashboard: account, settings, subscription, payment method
// ---------------------------------------------------------------------------

export interface PersonalDashboardAccount {
  readonly id: string;
  readonly type: Readable<"user">;
  readonly email: string;
  readonly display_name?: string;
}

function validatePersonalDashboardAccount(value: unknown): Result<PersonalDashboardAccount> {
  if (!isPlainObject(value)) return invalidValue("account", "must be an object");
  const type = expectLiteral(value.type, ["user"] as const, "account.type");
  if (!type.ok) return type;
  const id = expectString(value.id, "account.id");
  if (!id.ok) return id;
  const email = expectString(value.email, "account.email");
  if (!email.ok) return email;
  const displayName = expectOptionalString(value.display_name, "account.display_name");
  if (!displayName.ok) return displayName;
  return ok({
    id: id.value,
    type: type.value,
    email: email.value,
    ...(displayName.value !== undefined ? { display_name: displayName.value } : {})
  });
}

export interface PersonalDashboardSettings {
  readonly new_application_premium_per_call_limit: string;
}

function validatePersonalDashboardSettings(value: unknown): Result<PersonalDashboardSettings> {
  if (!isPlainObject(value)) return invalidValue("settings", "must be an object");
  const limit = expectNonNegativeCanonicalAmount(
    value.new_application_premium_per_call_limit,
    "settings.new_application_premium_per_call_limit"
  );
  if (!limit.ok) return limit;
  return ok({ new_application_premium_per_call_limit: limit.value });
}

export const SUBSCRIPTION_STATUSES = ["active", "past_due", "canceled", "suspended"] as const;
export const CHANGE_MODES = ["checkout", "change", "locked", "unavailable"] as const;
/** Which endpoint accepts a downgrade while plan changes are locked (`PATCH` or a scheduled `POST` checkout). */
export const LOCKED_DOWNGRADE_MODES = ["checkout", "change"] as const;

export interface PersonalDashboardSubscription {
  readonly status: Readable<"active" | "past_due" | "canceled" | "suspended">;
  readonly plan?: SubscriptionPlanSummary;
  readonly pending_plan?: SubscriptionPlanSummary;
  readonly current_period_end?: string;
  readonly change_mode: Readable<"checkout" | "change" | "locked" | "unavailable">;
  /** Present only with `change_mode: "locked"`, when a cheaper paid plan is still accepted. */
  readonly locked_downgrade?: Readable<"checkout" | "change">;
}

export function validatePersonalDashboardSubscription(
  value: unknown,
  options?: ParseOptions
): Result<PersonalDashboardSubscription> {
  return withResponseOptions(value, options, () => validatePersonalDashboardSubscriptionShape(value));
}

function validatePersonalDashboardSubscriptionShape(
  value: unknown
): Result<PersonalDashboardSubscription> {
  if (!isPlainObject(value)) return invalidValue("subscription", "must be an object");
  const status = expectLiteral(value.status, SUBSCRIPTION_STATUSES, "subscription.status");
  if (!status.ok) return status;
  const changeMode = expectLiteral(value.change_mode, CHANGE_MODES, "subscription.change_mode");
  if (!changeMode.ok) return changeMode;

  if (status.value === "suspended") {
    if (value.plan !== undefined)
      return invalidValue("subscription.plan", "must be absent when status is suspended");
    if (value.current_period_end !== undefined) {
      return invalidValue(
        "subscription.current_period_end",
        "must be absent when status is suspended"
      );
    }
    if (changeMode.value !== "unavailable") {
      return invalidValue(
        "subscription.change_mode",
        'must be "unavailable" when status is suspended'
      );
    }
  } else if ((status.value as string) !== UNKNOWN_ENUM_VALUE && value.plan === undefined) {
    return invalidValue("subscription.plan", "must be present for every non-suspended status");
  }

  const plan =
    value.plan === undefined
      ? ok(undefined)
      : validateSubscriptionPlanSummaryShape(value.plan, "subscription.plan");
  if (!plan.ok) return plan;
  const pendingPlan =
    value.pending_plan === undefined
      ? ok(undefined)
      : validateSubscriptionPlanSummaryShape(value.pending_plan, "subscription.pending_plan");
  if (!pendingPlan.ok) return pendingPlan;
  const currentPeriodEnd = expectOptionalRfc3339(
    value.current_period_end,
    "subscription.current_period_end"
  );
  if (!currentPeriodEnd.ok) return currentPeriodEnd;

  // `locked_downgrade` only qualifies a locked subscription. An unknown
  // `change_mode` read as "other" is not contradicted, because a newer server
  // may pair the field with a mode this client does not know yet.
  let lockedDowngrade: Readable<"checkout" | "change"> | undefined;
  if (value.locked_downgrade !== undefined) {
    const mode = expectLiteral(
      value.locked_downgrade,
      LOCKED_DOWNGRADE_MODES,
      "subscription.locked_downgrade"
    );
    if (!mode.ok) return mode;
    const known = changeMode.value as string;
    if (known !== "locked" && known !== UNKNOWN_ENUM_VALUE) {
      return invalidValue(
        "subscription.locked_downgrade",
        'must be absent unless change_mode is "locked"'
      );
    }
    lockedDowngrade = mode.value;
  }

  return ok({
    status: status.value,
    change_mode: changeMode.value,
    ...(lockedDowngrade !== undefined ? { locked_downgrade: lockedDowngrade } : {}),
    ...(plan.value !== undefined ? { plan: plan.value } : {}),
    ...(pendingPlan.value !== undefined ? { pending_plan: pendingPlan.value } : {}),
    ...(currentPeriodEnd.value !== undefined ? { current_period_end: currentPeriodEnd.value } : {})
  });
}

export interface PersonalPaymentMethod {
  readonly provider: string;
  readonly brand?: string;
  readonly last4?: string;
  readonly expires_month?: number;
  readonly expires_year?: number;
}

function validatePersonalPaymentMethod(value: unknown): Result<PersonalPaymentMethod> {
  if (!isPlainObject(value)) return invalidValue("payment_method", "must be an object");
  const provider = expectString(value.provider, "payment_method.provider");
  if (!provider.ok) return provider;
  const brand = expectOptionalString(value.brand, "payment_method.brand");
  if (!brand.ok) return brand;
  const last4 = expectOptionalString(value.last4, "payment_method.last4");
  if (!last4.ok) return last4;
  const expiresMonth =
    value.expires_month === undefined
      ? ok(undefined)
      : expectInteger(value.expires_month, "payment_method.expires_month");
  if (!expiresMonth.ok) return expiresMonth;
  const expiresYear =
    value.expires_year === undefined
      ? ok(undefined)
      : expectInteger(value.expires_year, "payment_method.expires_year");
  if (!expiresYear.ok) return expiresYear;
  return ok({
    provider: provider.value,
    ...(brand.value !== undefined ? { brand: brand.value } : {}),
    ...(last4.value !== undefined ? { last4: last4.value } : {}),
    ...(expiresMonth.value !== undefined ? { expires_month: expiresMonth.value } : {}),
    ...(expiresYear.value !== undefined ? { expires_year: expiresYear.value } : {})
  });
}

/** `POST /v1/dashboard/personal/payment-method/setup`'s response. */
export interface PaymentMethodSetupResponse {
  readonly client_secret: string;
}

export function validatePaymentMethodSetupResponse(
  value: unknown,
  options?: ParseOptions
): Result<PaymentMethodSetupResponse> {
  return withResponseOptions(value, options, () => validatePaymentMethodSetupResponseShape(value));
}

function validatePaymentMethodSetupResponseShape(
  value: unknown
): Result<PaymentMethodSetupResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const clientSecret = expectString(value.client_secret, "client_secret");
  if (!clientSecret.ok) return clientSecret;
  return ok({ client_secret: clientSecret.value });
}

// ---------------------------------------------------------------------------
// Personal dashboard: the full read model
// ---------------------------------------------------------------------------

/**
 * `GET /v1/dashboard/personal`'s body, and the confirmed state returned by
 * `PATCH /v1/dashboard/personal/settings`, `PATCH /v1/dashboard/personal/subscription`,
 * and `DELETE /v1/dashboard/personal/payment-method`.
 */
export interface PersonalDashboard {
  readonly account: PersonalDashboardAccount;
  readonly usage: PersonalUsagePeriod | null;
  readonly extra_credits: PersonalExtraCredits | null;
  readonly settings: PersonalDashboardSettings;
  readonly subscription: PersonalDashboardSubscription;
  readonly payment_method?: PersonalPaymentMethod;
}

export interface PersonalExtraCreditAmount {
  readonly remaining: string;
  readonly reserved: string;
}

export interface PersonalExtraCredits {
  readonly standard: PersonalExtraCreditAmount;
  readonly premium: PersonalExtraCreditAmount;
}

function validatePersonalExtraCredits(value: unknown): Result<PersonalExtraCredits> {
  if (!isPlainObject(value)) return invalidValue("extra_credits", "must be an object");
  const validateAmount = (candidate: unknown, param: string): Result<PersonalExtraCreditAmount> => {
    if (!isPlainObject(candidate)) return invalidValue(param, "must be an object");
    const remaining = expectNonNegativeCanonicalAmount(candidate.remaining, `${param}.remaining`);
    if (!remaining.ok) return remaining;
    const reserved = expectNonNegativeCanonicalAmount(candidate.reserved, `${param}.reserved`);
    if (!reserved.ok) return reserved;
    return ok({ remaining: remaining.value, reserved: reserved.value });
  };
  const standard = validateAmount(value.standard, "extra_credits.standard");
  if (!standard.ok) return standard;
  const premium = validateAmount(value.premium, "extra_credits.premium");
  if (!premium.ok) return premium;
  return ok({ standard: standard.value, premium: premium.value });
}

export function validatePersonalDashboard(value: unknown, options?: ParseOptions): Result<PersonalDashboard> {
  return withResponseOptions(value, options, () => validatePersonalDashboardShape(value));
}

function validatePersonalDashboardShape(value: unknown): Result<PersonalDashboard> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const account = validatePersonalDashboardAccount(value.account);
  if (!account.ok) return account;
  const usage = validatePersonalUsagePeriodOrNull(value.usage, "usage");
  if (!usage.ok) return usage;
  const extraCredits =
    value.extra_credits === null ? ok(null) : validatePersonalExtraCredits(value.extra_credits);
  if (!extraCredits.ok) return extraCredits;
  const settings = validatePersonalDashboardSettings(value.settings);
  if (!settings.ok) return settings;
  const subscription = validatePersonalDashboardSubscriptionShape(value.subscription);
  if (!subscription.ok) return subscription;
  const paymentMethod =
    value.payment_method === undefined
      ? ok(undefined)
      : validatePersonalPaymentMethod(value.payment_method);
  if (!paymentMethod.ok) return paymentMethod;

  // "`usage` is null when, and only when, the principal is suspended or
  // closed" — the suspended case is observable from `subscription.status`.
  if (
    (subscription.value.status as string) !== UNKNOWN_ENUM_VALUE &&
    usage.value === null &&
    subscription.value.status !== "suspended"
  ) {
    return invalidValue("usage", "must be non-null unless subscription.status is suspended");
  }
  if (usage.value !== null && subscription.value.status === "suspended") {
    return invalidValue("usage", "must be null when subscription.status is suspended");
  }
  if ((usage.value === null) !== (extraCredits.value === null)) {
    return invalidValue("extra_credits", "must be null exactly when usage is null");
  }

  return ok({
    account: account.value,
    usage: usage.value,
    extra_credits: extraCredits.value,
    settings: settings.value,
    subscription: subscription.value,
    ...(paymentMethod.value !== undefined ? { payment_method: paymentMethod.value } : {})
  });
}

/** `PATCH /v1/dashboard/personal/settings`'s request body: exactly one optional field. */
export function validatePatchPersonalSettingsRequest(
  value: unknown
): Result<{ readonly new_application_premium_per_call_limit?: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["new_application_premium_per_call_limit"]);
  if (!rejected.ok) return rejected;
  if (value.new_application_premium_per_call_limit === undefined) return ok({});
  const limit = expectNonNegativeCanonicalAmount(
    value.new_application_premium_per_call_limit,
    "new_application_premium_per_call_limit"
  );
  if (!limit.ok) return limit;
  return ok({ new_application_premium_per_call_limit: limit.value });
}

// ---------------------------------------------------------------------------
// Personal applications
// ---------------------------------------------------------------------------

export const APPLICATION_ENVIRONMENTS = ["test", "live"] as const;

/**
 * One credit type's per-application rate window: captured plus reserved
 * credit units for this user and application per fixed window of
 * `period_minutes` minutes. Read-only to the user in v1.
 */
export interface ApplicationRateTuple {
  readonly credits: string;
  readonly period_minutes: number;
}

/**
 * The authorization's extensible `limits` object (`specs/PROTOCOLS.md`
 * "Personal dashboard"). A new rule adds a key; clients tolerate future keys,
 * so a tolerant read drops them and a strict read rejects them. Each credit
 * type has its own per-call limit and its own rate tuple.
 */
export interface ApplicationLimits {
  readonly standard_per_call: string;
  readonly premium_per_call: string;
  readonly rate: {
    readonly standard: ApplicationRateTuple;
    readonly premium: ApplicationRateTuple;
  };
}

export function validateApplicationLimits(
  value: unknown,
  param = "limits",
  options?: ParseOptions
): Result<ApplicationLimits> {
  return withResponseOptions(value, options, () => validateApplicationLimitsShape(value, param));
}

/** Reads one `{ credits, period_minutes }` tuple; the period must be a positive integer. */
function validateRateTuple(value: unknown, param: string): Result<ApplicationRateTuple> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const rejected = rejectUnknownResponseKeys(value, ["credits", "period_minutes"]);
  if (!rejected.ok) return rejected;
  const credits = expectNonNegativeCanonicalAmount(value.credits, `${param}.credits`);
  if (!credits.ok) return credits;
  const periodMinutes = expectNonNegativeInteger(value.period_minutes, `${param}.period_minutes`);
  if (!periodMinutes.ok) return periodMinutes;
  if (periodMinutes.value < 1) return invalidValue(`${param}.period_minutes`, "must be positive");
  return ok({ credits: credits.value, period_minutes: periodMinutes.value });
}

function validateApplicationLimitsShape(value: unknown, param: string): Result<ApplicationLimits> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const rejected = rejectUnknownResponseKeys(value, ["standard_per_call", "premium_per_call", "rate"]);
  if (!rejected.ok) return rejected;
  const standardPerCall = expectNonNegativeCanonicalAmount(
    value.standard_per_call,
    `${param}.standard_per_call`
  );
  if (!standardPerCall.ok) return standardPerCall;
  const premiumPerCall = expectNonNegativeCanonicalAmount(
    value.premium_per_call,
    `${param}.premium_per_call`
  );
  if (!premiumPerCall.ok) return premiumPerCall;
  const rate = value.rate;
  if (!isPlainObject(rate)) return invalidValue(`${param}.rate`, "must be an object");
  const rateRejected = rejectUnknownResponseKeys(rate, ["standard", "premium"]);
  if (!rateRejected.ok) return rateRejected;
  const standard = validateRateTuple(rate.standard, `${param}.rate.standard`);
  if (!standard.ok) return standard;
  const premium = validateRateTuple(rate.premium, `${param}.rate.premium`);
  if (!premium.ok) return premium;
  return ok({
    standard_per_call: standardPerCall.value,
    premium_per_call: premiumPerCall.value,
    rate: { standard: standard.value, premium: premium.value }
  });
}

/**
 * Reads the request body `{ limits: { premium_per_call, standard_per_call? } }`
 * of the consent POST. Strict: an unknown key at either level (never `rate`) is
 * refused.
 */
function validateConsentLimitsBody(value: unknown): Result<ConsentCompletionRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["limits"]);
  if (!rejected.ok) return rejected;
  const limits = value.limits;
  if (!isPlainObject(limits)) return invalidValue("limits", "must be an object");
  const nested = rejectUnknownKeys(limits, ["standard_per_call", "premium_per_call"]);
  if (!nested.ok) return nested;
  const premiumPerCall = expectNonNegativeCanonicalAmount(
    limits.premium_per_call,
    "limits.premium_per_call"
  );
  if (!premiumPerCall.ok) return premiumPerCall;
  if (limits.standard_per_call === undefined) {
    return ok({ limits: { premium_per_call: premiumPerCall.value } });
  }
  const standardPerCall = expectNonNegativeCanonicalAmount(
    limits.standard_per_call,
    "limits.standard_per_call"
  );
  if (!standardPerCall.ok) return standardPerCall;
  return ok({
    limits: { premium_per_call: premiumPerCall.value, standard_per_call: standardPerCall.value }
  });
}

/** `PATCH .../limits` body: either per-call key alone or both, at least one. */
export interface PersonalApplicationLimitsPatch {
  readonly limits: { readonly standard_per_call?: string; readonly premium_per_call?: string };
}

export interface PersonalApplicationSummary {
  readonly id: string;
  readonly name: string;
  readonly icon_url?: string;
  readonly description?: string;
  readonly business_display_name: string;
  readonly environment: Readable<"test" | "live">;
  readonly limits: ApplicationLimits;
  readonly authorized_at: string;
  readonly last_authorized_at: string;
  /** Null while the authorization is in force; the instant of the user's revoke while revoked. */
  readonly revoked_at: string | null;
}

function validatePersonalApplicationSummary(
  value: unknown,
  param: string
): Result<PersonalApplicationSummary> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const name = expectString(value.name, `${param}.name`);
  if (!name.ok) return name;
  const iconUrl = expectOptionalString(value.icon_url, `${param}.icon_url`);
  if (!iconUrl.ok) return iconUrl;
  const description = expectOptionalString(value.description, `${param}.description`);
  if (!description.ok) return description;
  const businessDisplayName = expectString(
    value.business_display_name,
    `${param}.business_display_name`
  );
  if (!businessDisplayName.ok) return businessDisplayName;
  const environment = expectLiteral(
    value.environment,
    APPLICATION_ENVIRONMENTS,
    `${param}.environment`
  );
  if (!environment.ok) return environment;
  const limits = validateApplicationLimitsShape(value.limits, `${param}.limits`);
  if (!limits.ok) return limits;
  const authorizedAt = expectRfc3339(value.authorized_at, `${param}.authorized_at`);
  if (!authorizedAt.ok) return authorizedAt;
  const lastAuthorizedAt = expectRfc3339(value.last_authorized_at, `${param}.last_authorized_at`);
  if (!lastAuthorizedAt.ok) return lastAuthorizedAt;
  // `revoked_at` is always present: null or an RFC 3339 instant.
  const revokedAt =
    value.revoked_at === null ? ok(null) : expectRfc3339(value.revoked_at, `${param}.revoked_at`);
  if (!revokedAt.ok) return revokedAt;
  return ok({
    id: id.value,
    name: name.value,
    ...(iconUrl.value !== undefined ? { icon_url: iconUrl.value } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    business_display_name: businessDisplayName.value,
    environment: environment.value,
    limits: limits.value,
    authorized_at: authorizedAt.value,
    last_authorized_at: lastAuthorizedAt.value,
    revoked_at: revokedAt.value
  });
}

/** This user's recorded calls to one application over the list wrapper's `range`. */
export interface PersonalApplicationListTotals {
  readonly standard_requests: number;
  readonly premium_requests: number;
  readonly standard_units_used: string;
  readonly premium_units_used: string;
}

/** A list entry: the summary plus `totals`. The detail read does not carry `totals`. */
export type PersonalApplicationListItem = PersonalApplicationSummary & {
  readonly totals: PersonalApplicationListTotals;
};

function validatePersonalApplicationListItem(
  value: unknown,
  param: string
): Result<PersonalApplicationListItem> {
  const summary = validatePersonalApplicationSummary(value, param);
  if (!summary.ok) return summary;
  // `validatePersonalApplicationSummary` proved `value` is a plain object.
  const raw = value as Record<string, unknown>;
  if (!isPlainObject(raw.totals)) return invalidValue(`${param}.totals`, "must be an object");
  const totals = raw.totals;
  const standardRequests = expectNonNegativeInteger(
    totals.standard_requests,
    `${param}.totals.standard_requests`
  );
  if (!standardRequests.ok) return standardRequests;
  const premiumRequests = expectNonNegativeInteger(
    totals.premium_requests,
    `${param}.totals.premium_requests`
  );
  if (!premiumRequests.ok) return premiumRequests;
  const standardUnitsUsed = expectCanonicalAmount(
    totals.standard_units_used,
    `${param}.totals.standard_units_used`
  );
  if (!standardUnitsUsed.ok) return standardUnitsUsed;
  const premiumUnitsUsed = expectCanonicalAmount(
    totals.premium_units_used,
    `${param}.totals.premium_units_used`
  );
  if (!premiumUnitsUsed.ok) return premiumUnitsUsed;
  return ok({
    ...summary.value,
    totals: {
      standard_requests: standardRequests.value,
      premium_requests: premiumRequests.value,
      standard_units_used: standardUnitsUsed.value,
      premium_units_used: premiumUnitsUsed.value
    }
  });
}

export interface PersonalApplicationsPage {
  readonly applications: readonly PersonalApplicationListItem[];
  readonly range: DashboardRange;
  readonly next_cursor: string | null;
}

export function validatePersonalApplicationsPage(
  value: unknown,
  options?: ParseOptions
): Result<PersonalApplicationsPage> {
  return withResponseOptions(value, options, () => validatePersonalApplicationsPageShape(value));
}

function validatePersonalApplicationsPageShape(value: unknown): Result<PersonalApplicationsPage> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!Array.isArray(value.applications)) return invalidValue("applications", "must be an array");
  const applications: PersonalApplicationListItem[] = [];
  for (const [index, item] of value.applications.entries()) {
    const result = validatePersonalApplicationListItem(item, `applications[${index}]`);
    if (!result.ok) return result;
    applications.push(result.value);
  }
  const range = validateDashboardRange(value.range, "range");
  if (!range.ok) return range;
  const nextCursor = expectNullableString(value.next_cursor, "next_cursor");
  if (!nextCursor.ok) return nextCursor;
  return ok({ applications, range: range.value, next_cursor: nextCursor.value });
}

/** Sort orders of the per-application call list (`specs/PROTOCOLS.md`). */
export const PERSONAL_APPLICATION_CALL_SORTS = ["time", "charge"] as const;
export type PersonalApplicationCallSort = (typeof PERSONAL_APPLICATION_CALL_SORTS)[number];

/** Page size bounds of the per-application call list. */
export const PERSONAL_APPLICATION_CALLS_DEFAULT_LIMIT = 10;
export const PERSONAL_APPLICATION_CALLS_MAX_LIMIT = 50;

export const PERSONAL_APPLICATION_CALL_CREDIT_TYPES = ["standard", "premium"] as const;
export const PERSONAL_APPLICATION_CALL_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired"
] as const;

/** One recorded call of the user to an application they authorized. */
export interface PersonalApplicationCall {
  readonly id: string;
  readonly credit_type: Readable<(typeof PERSONAL_APPLICATION_CALL_CREDIT_TYPES)[number]>;
  readonly status: Readable<(typeof PERSONAL_APPLICATION_CALL_STATUSES)[number]>;
  readonly units_used: string;
  readonly units_reserved: string;
  readonly created_at: string;
  readonly terminal_at: string | null;
  readonly streamed: boolean;
  readonly model_id: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly finish_reason: string | null;
  readonly error_category: string | null;
}

function expectNullableNonNegativeInteger(value: unknown, param: string): Result<number | null> {
  if (value === null) return ok(null);
  return expectNonNegativeInteger(value, param);
}

function validatePersonalApplicationCall(
  value: unknown,
  param: string
): Result<PersonalApplicationCall> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const creditType = expectLiteral(
    value.credit_type,
    PERSONAL_APPLICATION_CALL_CREDIT_TYPES,
    `${param}.credit_type`
  );
  if (!creditType.ok) return creditType;
  const status = expectLiteral(
    value.status,
    PERSONAL_APPLICATION_CALL_STATUSES,
    `${param}.status`
  );
  if (!status.ok) return status;
  const unitsUsed = expectCanonicalAmount(value.units_used, `${param}.units_used`);
  if (!unitsUsed.ok) return unitsUsed;
  const unitsReserved = expectCanonicalAmount(value.units_reserved, `${param}.units_reserved`);
  if (!unitsReserved.ok) return unitsReserved;
  const createdAt = expectRfc3339(value.created_at, `${param}.created_at`);
  if (!createdAt.ok) return createdAt;
  const terminalAt = expectNullableRfc3339(value.terminal_at, `${param}.terminal_at`);
  if (!terminalAt.ok) return terminalAt;
  const streamed = expectBoolean(value.streamed, `${param}.streamed`);
  if (!streamed.ok) return streamed;
  const modelId = expectNullableString(value.model_id, `${param}.model_id`);
  if (!modelId.ok) return modelId;
  const inputTokens = expectNullableNonNegativeInteger(
    value.input_tokens,
    `${param}.input_tokens`
  );
  if (!inputTokens.ok) return inputTokens;
  const outputTokens = expectNullableNonNegativeInteger(
    value.output_tokens,
    `${param}.output_tokens`
  );
  if (!outputTokens.ok) return outputTokens;
  const finishReason = expectNullableString(value.finish_reason, `${param}.finish_reason`);
  if (!finishReason.ok) return finishReason;
  const errorCategory = expectNullableString(value.error_category, `${param}.error_category`);
  if (!errorCategory.ok) return errorCategory;
  return ok({
    id: id.value,
    credit_type: creditType.value,
    status: status.value,
    units_used: unitsUsed.value,
    units_reserved: unitsReserved.value,
    created_at: createdAt.value,
    terminal_at: terminalAt.value,
    streamed: streamed.value,
    model_id: modelId.value,
    input_tokens: inputTokens.value,
    output_tokens: outputTokens.value,
    finish_reason: finishReason.value,
    error_category: errorCategory.value
  });
}

/** The `{ calls, page, page_count, total }` wrapper of the per-application call list. */
export interface PersonalApplicationCallPage {
  readonly calls: readonly PersonalApplicationCall[];
  readonly page: number;
  readonly page_count: number;
  readonly total: number;
}

export function validatePersonalApplicationCallPage(
  value: unknown,
  options?: ParseOptions
): Result<PersonalApplicationCallPage> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    if (!Array.isArray(value.calls)) return invalidValue("calls", "must be an array");
    const calls: PersonalApplicationCall[] = [];
    for (const [index, item] of value.calls.entries()) {
      const result = validatePersonalApplicationCall(item, `calls[${index}]`);
      if (!result.ok) return result;
      calls.push(result.value);
    }
    const page = expectInteger(value.page, "page");
    if (!page.ok) return page;
    if (page.value < 1) return invalidValue("page", "must be a positive integer");
    const pageCount = expectInteger(value.page_count, "page_count");
    if (!pageCount.ok) return pageCount;
    if (pageCount.value < 1) return invalidValue("page_count", "must be a positive integer");
    const total = expectNonNegativeInteger(value.total, "total");
    if (!total.ok) return total;
    return ok({ calls, page: page.value, page_count: pageCount.value, total: total.value });
  });
}

/**
 * Parses the query of `GET …/applications/{id}/calls`. `sort` defaults to
 * `time`, `page` to 1 (a positive integer), `limit` to 10 (1–50).
 */
export function validatePersonalApplicationCallsQuery(query: {
  readonly sort?: string | null;
  readonly page?: string | null;
  readonly limit?: string | null;
}): Result<{ sort: PersonalApplicationCallSort; page: number; limit: number }> {
  const sort =
    query.sort === undefined || query.sort === null
      ? ok<PersonalApplicationCallSort>("time")
      : expectLiteral(query.sort, PERSONAL_APPLICATION_CALL_SORTS, "sort");
  if (!sort.ok) return sort;
  let page = 1;
  if (query.page !== undefined && query.page !== null) {
    if (!/^\d+$/.test(query.page)) return invalidValue("page", "must be a positive integer");
    page = Number(query.page);
    if (!Number.isSafeInteger(page) || page < 1) return invalidValue("page", "must be a positive integer");
  }
  let limit = PERSONAL_APPLICATION_CALLS_DEFAULT_LIMIT;
  if (query.limit !== undefined && query.limit !== null) {
    if (!/^\d+$/.test(query.limit)) return invalidValue("limit", "must be a positive integer");
    limit = Number(query.limit);
    if (limit < 1 || limit > PERSONAL_APPLICATION_CALLS_MAX_LIMIT) {
      return invalidValue("limit", `must be between 1 and ${PERSONAL_APPLICATION_CALLS_MAX_LIMIT}`);
    }
  }
  return ok({ sort: sort.value, page, limit });
}

export interface PersonalApplicationUsageDay {
  readonly day: string;
  readonly standard_requests: number;
  readonly premium_requests: number;
  readonly standard_units_used: string;
  readonly premium_units_used: string;
}

function validatePersonalApplicationUsageDay(
  value: unknown,
  param: string
): Result<PersonalApplicationUsageDay> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const day = expectCalendarDay(value.day, `${param}.day`);
  if (!day.ok) return day;
  const standardRequests = expectNonNegativeInteger(
    value.standard_requests,
    `${param}.standard_requests`
  );
  if (!standardRequests.ok) return standardRequests;
  const premiumRequests = expectNonNegativeInteger(
    value.premium_requests,
    `${param}.premium_requests`
  );
  if (!premiumRequests.ok) return premiumRequests;
  const standardUnitsUsed = expectCanonicalAmount(
    value.standard_units_used,
    `${param}.standard_units_used`
  );
  if (!standardUnitsUsed.ok) return standardUnitsUsed;
  const premiumUnitsUsed = expectCanonicalAmount(
    value.premium_units_used,
    `${param}.premium_units_used`
  );
  if (!premiumUnitsUsed.ok) return premiumUnitsUsed;
  return ok({
    day: day.value,
    standard_requests: standardRequests.value,
    premium_requests: premiumRequests.value,
    standard_units_used: standardUnitsUsed.value,
    premium_units_used: premiumUnitsUsed.value
  });
}

export interface DashboardRange {
  readonly from: string;
  readonly to: string;
  readonly timezone: Readable<"UTC">;
}

function validateDashboardRange(value: unknown, param: string): Result<DashboardRange> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const from = expectRfc3339(value.from, `${param}.from`);
  if (!from.ok) return from;
  const to = expectRfc3339(value.to, `${param}.to`);
  if (!to.ok) return to;
  const timezone = expectLiteral(value.timezone, ["UTC"] as const, `${param}.timezone`);
  if (!timezone.ok) return timezone;
  return ok({ from: from.value, to: to.value, timezone: timezone.value });
}

export interface PersonalApplicationUsage {
  readonly range: DashboardRange;
  readonly data_fresh_at: string;
  readonly daily: readonly PersonalApplicationUsageDay[];
}

function validatePersonalApplicationUsage(value: unknown): Result<PersonalApplicationUsage> {
  if (!isPlainObject(value)) return invalidValue("usage", "must be an object");
  const range = validateDashboardRange(value.range, "usage.range");
  if (!range.ok) return range;
  const dataFreshAt = expectRfc3339(value.data_fresh_at, "usage.data_fresh_at");
  if (!dataFreshAt.ok) return dataFreshAt;
  if (!Array.isArray(value.daily)) return invalidValue("usage.daily", "must be an array");
  const daily: PersonalApplicationUsageDay[] = [];
  for (const [index, item] of value.daily.entries()) {
    const result = validatePersonalApplicationUsageDay(item, `usage.daily[${index}]`);
    if (!result.ok) return result;
    daily.push(result.value);
  }
  return ok({ range: range.value, data_fresh_at: dataFreshAt.value, daily });
}

/**
 * The number of equal-width bins in a `PremiumUnitsHistogram` whose span is
 * `upperUnits` (owner decision 2026-10-25: at least one bin per whole credit,
 * so the shape is detailed enough to draw): the span in credits clamped to
 * 50–1,000. That is 50 sub-credit bins for 10 and 20 credits, one bin per
 * credit from 50 to 1,000 credits, and 1,000 bins from 2,000 credits up. For
 * every 1-2-5 span the bin width `upperUnits / count` is a whole number of units.
 */
export function premiumUnitsHistogramBinCount(upperUnits: bigint): number {
  const credits = upperUnits / 1000n;
  if (credits < 50n) return 50;
  if (credits > 1000n) return 1000;
  return Number(credits);
}

/**
 * The measured charges as per-mille shares: `B` equal bins over
 * `0..upper_units` (`B = premiumUnitsHistogramBinCount(upper_units)`; bin `i`
 * holds charges `c` with `i·w < c <= (i+1)·w`, `w = upper_units / B`) and the
 * share above `upper_units`. `upper_units` is the 1-2-5 credit span (10, 20,
 * 50, 100, ... credits) at or above the p99; the `B + 1` shares sum to exactly
 * 1,000 and carry no count.
 */
export interface PremiumUnitsHistogram {
  readonly upper_units: string;
  readonly bin_shares_permille: readonly number[];
  readonly above_share_permille: number;
}

export interface ApplicationCostProfile {
  readonly disclosed: boolean;
  /**
   * The application's premium switch (`applications.premium_enabled`), always
   * present and independent of disclosure (owner decision 2026-10-25). A client
   * shows an application with it false as one that does not use premium credit
   * and offers no premium limit control.
   */
  readonly premium_enabled: boolean;
  readonly uses_premium: boolean;
  /** The three charged-call figures and the histogram are present exactly when `disclosed` is true. */
  readonly median_premium_units_per_charged_call?: string;
  readonly p90_premium_units_per_charged_call?: string;
  readonly max_premium_units_per_charged_call?: string;
  readonly premium_units_histogram?: PremiumUnitsHistogram;
  /**
   * The developer's own estimate converted to premium units (rounded up).
   * Present exactly when `disclosed` is false and the application declared
   * an estimate; a client must label it as the developer's estimate.
   */
  readonly estimated_premium_units_per_charged_call?: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly computed_at: string;
}

export function validateApplicationCostProfile(
  value: unknown,
  param = "cost_profile",
  options?: ParseOptions
): Result<ApplicationCostProfile> {
  return withResponseOptions(value, options, () => validateApplicationCostProfileShape(value, param));
}

/** True for a 1-2-5 credit span in units: 10,000, 20,000, 50,000, 100,000, ... */
function isHistogramSpanUnits(units: bigint): boolean {
  for (let decade = 10_000n; decade <= units; decade *= 10n) {
    if (units === decade || units === decade * 2n || units === decade * 5n) return true;
  }
  return false;
}

function validatePremiumUnitsHistogram(
  value: unknown,
  param: string
): Result<PremiumUnitsHistogram> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const upper = expectCanonicalAmount(value.upper_units, `${param}.upper_units`);
  if (!upper.ok) return upper;
  if (!isHistogramSpanUnits(BigInt(upper.value))) {
    return invalidValue(`${param}.upper_units`, "must be a 1-2-5 credit span of at least 10 credits");
  }
  // The bin count is implied by the span, so a body whose array length
  // disagrees with its own upper bound is malformed.
  const binCount = premiumUnitsHistogramBinCount(BigInt(upper.value));
  if (!Array.isArray(value.bin_shares_permille) || value.bin_shares_permille.length !== binCount) {
    return invalidValue(
      `${param}.bin_shares_permille`,
      `must be an array of ${binCount} integers for this upper_units`
    );
  }
  const shares: number[] = [];
  for (const [index, item] of value.bin_shares_permille.entries()) {
    const share = expectNonNegativeInteger(item, `${param}.bin_shares_permille[${index}]`);
    if (!share.ok) return share;
    shares.push(share.value);
  }
  const above = expectNonNegativeInteger(value.above_share_permille, `${param}.above_share_permille`);
  if (!above.ok) return above;
  // Each share is at most 1,000, so the sum check also bounds every entry.
  if (shares.reduce((sum, share) => sum + share, 0) + above.value !== 1000) {
    return invalidValue(param, "the bin and above shares must sum to exactly 1000");
  }
  return ok({ upper_units: upper.value, bin_shares_permille: shares, above_share_permille: above.value });
}

function validateApplicationCostProfileShape(
  value: unknown,
  param: string
): Result<ApplicationCostProfile> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const disclosed = expectBoolean(value.disclosed, `${param}.disclosed`);
  if (!disclosed.ok) return disclosed;
  const premiumEnabled = expectBoolean(value.premium_enabled, `${param}.premium_enabled`);
  if (!premiumEnabled.ok) return premiumEnabled;
  const usesPremium = expectBoolean(value.uses_premium, `${param}.uses_premium`);
  if (!usesPremium.ok) return usesPremium;
  const median = expectOptionalCanonicalAmount(
    value.median_premium_units_per_charged_call,
    `${param}.median_premium_units_per_charged_call`
  );
  if (!median.ok) return median;
  const p90 = expectOptionalCanonicalAmount(
    value.p90_premium_units_per_charged_call,
    `${param}.p90_premium_units_per_charged_call`
  );
  if (!p90.ok) return p90;
  const max = expectOptionalCanonicalAmount(
    value.max_premium_units_per_charged_call,
    `${param}.max_premium_units_per_charged_call`
  );
  if (!max.ok) return max;
  const histogram =
    value.premium_units_histogram === undefined
      ? ok(undefined)
      : validatePremiumUnitsHistogram(value.premium_units_histogram, `${param}.premium_units_histogram`);
  if (!histogram.ok) return histogram;
  const estimated = expectOptionalCanonicalAmount(
    value.estimated_premium_units_per_charged_call,
    `${param}.estimated_premium_units_per_charged_call`
  );
  if (!estimated.ok) return estimated;
  const windowStart = expectRfc3339(value.window_start, `${param}.window_start`);
  if (!windowStart.ok) return windowStart;
  const windowEnd = expectRfc3339(value.window_end, `${param}.window_end`);
  if (!windowEnd.ok) return windowEnd;
  const computedAt = expectRfc3339(value.computed_at, `${param}.computed_at`);
  if (!computedAt.ok) return computedAt;

  // "All three figures and the histogram are present exactly when `disclosed` is true."
  const present = [median.value, p90.value, max.value, histogram.value].filter(
    (figure) => figure !== undefined
  ).length;
  if (disclosed.value === false && present > 0) {
    return invalidValue(param, "the three figures and the histogram must be absent when disclosed is false");
  }
  if (disclosed.value === true && present !== 4) {
    return invalidValue(param, "the three figures and the histogram must all be present when disclosed is true");
  }
  // The estimate is a stand-in for observed figures, so it never accompanies them.
  if (disclosed.value === true && estimated.value !== undefined) {
    return invalidValue(param, "the estimate must be absent when disclosed is true");
  }

  return ok({
    disclosed: disclosed.value,
    premium_enabled: premiumEnabled.value,
    uses_premium: usesPremium.value,
    ...(median.value !== undefined ? { median_premium_units_per_charged_call: median.value } : {}),
    ...(p90.value !== undefined ? { p90_premium_units_per_charged_call: p90.value } : {}),
    ...(max.value !== undefined ? { max_premium_units_per_charged_call: max.value } : {}),
    ...(histogram.value !== undefined ? { premium_units_histogram: histogram.value } : {}),
    ...(estimated.value !== undefined
      ? { estimated_premium_units_per_charged_call: estimated.value }
      : {}),
    window_start: windowStart.value,
    window_end: windowEnd.value,
    computed_at: computedAt.value
  });
}

/** `GET /v1/dashboard/personal/applications/{application_id}}`'s body. */
export type PersonalApplicationDetail = PersonalApplicationSummary & {
  readonly usage: PersonalApplicationUsage;
  readonly cost_profile: ApplicationCostProfile;
};

export function validatePersonalApplicationDetail(
  value: unknown,
  options?: ParseOptions
): Result<PersonalApplicationDetail> {
  return withResponseOptions(value, options, () => validatePersonalApplicationDetailShape(value));
}

function validatePersonalApplicationDetailShape(
  value: unknown
): Result<PersonalApplicationDetail> {
  const summary = validatePersonalApplicationSummary(value, "application");
  if (!summary.ok) return summary;
  if (!isPlainObject(value)) return invalidValue("application", "must be an object");
  const usage = validatePersonalApplicationUsage(value.usage);
  if (!usage.ok) return usage;
  const costProfile = validateApplicationCostProfileShape(value.cost_profile, "cost_profile");
  if (!costProfile.ok) return costProfile;
  return ok({ ...summary.value, usage: usage.value, cost_profile: costProfile.value });
}

/**
 * `PATCH /v1/dashboard/personal/applications/{application_id}/limits`'s
 * request body: `{ limits: { standard_per_call?, premium_per_call? } }` with at
 * least one key. An empty `limits` object, a `rate` key, or any other key is
 * refused.
 */
export function validatePatchPersonalApplicationLimitRequest(
  value: unknown
): Result<PersonalApplicationLimitsPatch> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["limits"]);
  if (!rejected.ok) return rejected;
  const limits = value.limits;
  if (!isPlainObject(limits)) return invalidValue("limits", "must be an object");
  const nested = rejectUnknownKeys(limits, ["standard_per_call", "premium_per_call"]);
  if (!nested.ok) return nested;
  const standard =
    limits.standard_per_call === undefined
      ? ok(undefined)
      : expectNonNegativeCanonicalAmount(limits.standard_per_call, "limits.standard_per_call");
  if (!standard.ok) return standard;
  const premium =
    limits.premium_per_call === undefined
      ? ok(undefined)
      : expectNonNegativeCanonicalAmount(limits.premium_per_call, "limits.premium_per_call");
  if (!premium.ok) return premium;
  if (standard.value === undefined && premium.value === undefined) {
    return invalidValue("limits", "must carry standard_per_call, premium_per_call, or both");
  }
  return ok({
    limits: {
      ...(standard.value !== undefined ? { standard_per_call: standard.value } : {}),
      ...(premium.value !== undefined ? { premium_per_call: premium.value } : {})
    }
  });
}

// ---------------------------------------------------------------------------
// Verified contacts
// ---------------------------------------------------------------------------

export const CONTACT_TYPES = ["email", "phone"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export interface PersonalContact {
  readonly id: string;
  readonly contact_type: Readable<ContactType>;
  readonly display_value: string;
  readonly verified_at: string;
}

export function validatePersonalContact(value: unknown, options?: ParseOptions): Result<PersonalContact> {
  return withResponseOptions(value, options, () => validatePersonalContactShape(value));
}

function validatePersonalContactShape(value: unknown): Result<PersonalContact> {
  if (!isPlainObject(value)) return invalidValue("contact", "must be an object");
  const id = expectString(value.id, "contact.id");
  if (!id.ok) return id;
  const contactType = expectLiteral(value.contact_type, CONTACT_TYPES, "contact.contact_type");
  if (!contactType.ok) return contactType;
  const displayValue = expectString(value.display_value, "contact.display_value");
  if (!displayValue.ok) return displayValue;
  const verifiedAt = expectRfc3339(value.verified_at, "contact.verified_at");
  if (!verifiedAt.ok) return verifiedAt;
  return ok({
    id: id.value,
    contact_type: contactType.value,
    display_value: displayValue.value,
    verified_at: verifiedAt.value
  });
}

export interface PersonalContactsList {
  readonly contacts: readonly PersonalContact[];
}

export function validatePersonalContactsList(
  value: unknown,
  options?: ParseOptions
): Result<PersonalContactsList> {
  return withResponseOptions(value, options, () => validatePersonalContactsListShape(value));
}

function validatePersonalContactsListShape(value: unknown): Result<PersonalContactsList> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!Array.isArray(value.contacts)) return invalidValue("contacts", "must be an array");
  const contacts: PersonalContact[] = [];
  for (const item of value.contacts) {
    const result = validatePersonalContact(item);
    if (!result.ok) return result;
    contacts.push(result.value);
  }
  return ok({ contacts });
}

/** `POST /v1/dashboard/personal/contacts`'s request body. */
/**
 * Reads the `turnstile_token` field of a bot-protected request body without
 * judging it.
 *
 * "Bot protection" in `specs/PROTOCOLS.md` makes a missing, malformed,
 * oversized, expired, replayed, or failed token `403 bot_verification_failed`,
 * so the field's shape is the server-side Turnstile boundary's decision and
 * not a `400 invalid_value` one. Every guarded request validator therefore
 * carries the raw value through, and the route hands it to `assertHuman()`,
 * which refuses an absent or malformed token with the code the spec names.
 */
function readTurnstileToken(value: Record<string, unknown>): unknown {
  return value.turnstile_token;
}

export function validateStartContactVerificationRequest(
  value: unknown
): Result<{
  readonly contact_type: ContactType;
  readonly value: string;
  readonly turnstile_token: unknown;
}> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["contact_type", "value", "turnstile_token"]);
  if (!rejected.ok) return rejected;
  const contactType = expectLiteral(value.contact_type, CONTACT_TYPES, "contact_type");
  if (!contactType.ok) return contactType;
  const rawValue = expectString(value.value, "value");
  if (!rawValue.ok) return rawValue;
  return ok({
    contact_type: contactType.value,
    value: rawValue.value,
    turnstile_token: readTurnstileToken(value)
  });
}

export interface ContactChallenge {
  readonly challenge_id: string;
  readonly contact_type: Readable<ContactType>;
  readonly expires_at: string;
}

export function validateContactChallenge(value: unknown, options?: ParseOptions): Result<ContactChallenge> {
  return withResponseOptions(value, options, () => validateContactChallengeShape(value));
}

function validateContactChallengeShape(value: unknown): Result<ContactChallenge> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const challengeId = expectString(value.challenge_id, "challenge_id");
  if (!challengeId.ok) return challengeId;
  const contactType = expectLiteral(value.contact_type, CONTACT_TYPES, "contact_type");
  if (!contactType.ok) return contactType;
  const expiresAt = expectRfc3339(value.expires_at, "expires_at");
  if (!expiresAt.ok) return expiresAt;
  return ok({
    challenge_id: challengeId.value,
    contact_type: contactType.value,
    expires_at: expiresAt.value
  });
}

/** `POST /v1/dashboard/personal/contacts/verify`'s request body. */
export function validateVerifyContactRequest(
  value: unknown
): Result<{ readonly challenge_id: string; readonly code: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["challenge_id", "code"]);
  if (!rejected.ok) return rejected;
  const challengeId = expectString(value.challenge_id, "challenge_id");
  if (!challengeId.ok) return challengeId;
  const code = expectString(value.code, "code");
  if (!code.ok) return code;
  return ok({ challenge_id: challengeId.value, code: code.value });
}

// ---------------------------------------------------------------------------
// Authorization consent
// ---------------------------------------------------------------------------

export interface ConsentApplication {
  readonly id: string;
  readonly name: string;
  readonly icon_url?: string;
  readonly description?: string;
  readonly business_display_name: string;
  readonly environment: Readable<"test" | "live">;
}

function validateConsentApplication(value: unknown): Result<ConsentApplication> {
  if (!isPlainObject(value)) return invalidValue("application", "must be an object");
  const id = expectString(value.id, "application.id");
  if (!id.ok) return id;
  const name = expectString(value.name, "application.name");
  if (!name.ok) return name;
  const iconUrl = expectOptionalString(value.icon_url, "application.icon_url");
  if (!iconUrl.ok) return iconUrl;
  const description = expectOptionalString(value.description, "application.description");
  if (!description.ok) return description;
  const businessDisplayName = expectString(
    value.business_display_name,
    "application.business_display_name"
  );
  if (!businessDisplayName.ok) return businessDisplayName;
  const environment = expectLiteral(
    value.environment,
    APPLICATION_ENVIRONMENTS,
    "application.environment"
  );
  if (!environment.ok) return environment;
  return ok({
    id: id.value,
    name: name.value,
    ...(iconUrl.value !== undefined ? { icon_url: iconUrl.value } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    business_display_name: businessDisplayName.value,
    environment: environment.value
  });
}

export interface ConsentInfo {
  readonly application: ConsentApplication;
  readonly cost_profile: ApplicationCostProfile;
  readonly prefill_limits: ApplicationLimits;
  readonly existing_limits?: ApplicationLimits;
  readonly is_reauthorization: boolean;
  /**
   * True exactly when the user's covering period does not meter standard
   * credit (an unmetered plan such as Unlimited). The consent screen then shows
   * no standard per-call control and submits a fixed default instead (owner
   * decision 2026-10-25). A display hint for the user's own dashboard only.
   */
  readonly standard_unmetered: boolean;
}

export function validateConsentInfo(value: unknown, options?: ParseOptions): Result<ConsentInfo> {
  return withResponseOptions(value, options, () => validateConsentInfoShape(value));
}

function validateConsentInfoShape(value: unknown): Result<ConsentInfo> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const application = validateConsentApplication(value.application);
  if (!application.ok) return application;
  const costProfile = validateApplicationCostProfile(value.cost_profile);
  if (!costProfile.ok) return costProfile;
  const prefill = validateApplicationLimitsShape(value.prefill_limits, "prefill_limits");
  if (!prefill.ok) return prefill;
  const existing =
    value.existing_limits === undefined
      ? ok(undefined)
      : validateApplicationLimitsShape(value.existing_limits, "existing_limits");
  if (!existing.ok) return existing;
  const isReauthorization = expectBoolean(value.is_reauthorization, "is_reauthorization");
  if (!isReauthorization.ok) return isReauthorization;
  const standardUnmetered = expectBoolean(value.standard_unmetered, "standard_unmetered");
  if (!standardUnmetered.ok) return standardUnmetered;
  return ok({
    application: application.value,
    cost_profile: costProfile.value,
    prefill_limits: prefill.value,
    ...(existing.value !== undefined ? { existing_limits: existing.value } : {}),
    is_reauthorization: isReauthorization.value,
    standard_unmetered: standardUnmetered.value
  });
}

export interface ConsentCompletionRequest {
  readonly limits: { readonly premium_per_call: string; readonly standard_per_call?: string };
}

/** `POST /v1/dashboard/personal/authorizations/consent`'s request body: `{ limits: { premium_per_call, standard_per_call? } }`. */
export function validateConsentCompletionRequest(value: unknown): Result<ConsentCompletionRequest> {
  return validateConsentLimitsBody(value);
}

export interface ConsentCompletion {
  readonly resume_url: string;
}

export function validateConsentCompletion(value: unknown, options?: ParseOptions): Result<ConsentCompletion> {
  return withResponseOptions(value, options, () => validateConsentCompletionShape(value));
}

function validateConsentCompletionShape(value: unknown): Result<ConsentCompletion> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const resumeUrl = expectString(value.resume_url, "resume_url");
  if (!resumeUrl.ok) return resumeUrl;
  return ok({ resume_url: resumeUrl.value });
}

export interface ConsentDenial {
  readonly redirect_url: string | null;
}

export function validateConsentDenial(value: unknown, options?: ParseOptions): Result<ConsentDenial> {
  return withResponseOptions(value, options, () => validateConsentDenialShape(value));
}

function validateConsentDenialShape(value: unknown): Result<ConsentDenial> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const redirectUrl = expectNullableString(value.redirect_url, "redirect_url");
  if (!redirectUrl.ok) return redirectUrl;
  return ok({ redirect_url: redirectUrl.value });
}

// ---------------------------------------------------------------------------
// Subscription and credit purchase
// ---------------------------------------------------------------------------

export interface PlanCatalogLimits {
  readonly requests_per_minute: number;
  readonly default_max_output_tokens: number;
}

function validatePlanCatalogLimits(value: unknown, param: string): Result<PlanCatalogLimits> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const rejected = rejectUnknownResponseKeys(value, ["requests_per_minute", "default_max_output_tokens"]);
  if (!rejected.ok) return rejected;
  const requestsPerMinute = expectInteger(
    value.requests_per_minute,
    `${param}.requests_per_minute`
  );
  if (!requestsPerMinute.ok) return requestsPerMinute;
  if (requestsPerMinute.value <= 0) {
    return invalidValue(`${param}.requests_per_minute`, "must be a positive integer");
  }
  const defaultMaxOutputTokens = expectInteger(
    value.default_max_output_tokens,
    `${param}.default_max_output_tokens`
  );
  if (!defaultMaxOutputTokens.ok) return defaultMaxOutputTokens;
  if (defaultMaxOutputTokens.value <= 0) {
    return invalidValue(`${param}.default_max_output_tokens`, "must be a positive integer");
  }
  return ok({
    requests_per_minute: requestsPerMinute.value,
    default_max_output_tokens: defaultMaxOutputTokens.value
  });
}

export interface SubscriptionPlanEntry {
  readonly id: string;
  readonly display_name: string;
  readonly included_premium_credit_units: string;
  readonly included_standard_credit_units: string | null;
  readonly price_minor_units: string;
  readonly currency: string;
  readonly interval: Readable<"month" | "year">;
  readonly is_free: boolean;
  readonly limits: PlanCatalogLimits;
  readonly catalog_version: string;
}

function validateSubscriptionPlanEntry(
  value: unknown,
  param: string
): Result<SubscriptionPlanEntry> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const displayName = expectString(value.display_name, `${param}.display_name`);
  if (!displayName.ok) return displayName;
  const includedPremium = expectCanonicalAmount(
    value.included_premium_credit_units,
    `${param}.included_premium_credit_units`
  );
  if (!includedPremium.ok) return includedPremium;
  if (!("included_standard_credit_units" in value)) {
    return invalidValue(
      `${param}.included_standard_credit_units`,
      "must be present, as a string or null"
    );
  }
  const includedStandard = expectNullableCanonicalAmount(
    value.included_standard_credit_units,
    `${param}.included_standard_credit_units`
  );
  if (!includedStandard.ok) return includedStandard;
  const priceMinorUnits = expectCanonicalAmount(
    value.price_minor_units,
    `${param}.price_minor_units`
  );
  if (!priceMinorUnits.ok) return priceMinorUnits;
  const currency = expectString(value.currency, `${param}.currency`);
  if (!currency.ok) return currency;
  const interval = expectLiteral(value.interval, PLAN_INTERVALS, `${param}.interval`);
  if (!interval.ok) return interval;
  const isFree = expectBoolean(value.is_free, `${param}.is_free`);
  if (!isFree.ok) return isFree;
  const limits = validatePlanCatalogLimits(value.limits, `${param}.limits`);
  if (!limits.ok) return limits;
  const catalogVersion = expectString(value.catalog_version, `${param}.catalog_version`);
  if (!catalogVersion.ok) return catalogVersion;
  return ok({
    id: id.value,
    display_name: displayName.value,
    included_premium_credit_units: includedPremium.value,
    included_standard_credit_units: includedStandard.value,
    price_minor_units: priceMinorUnits.value,
    currency: currency.value,
    interval: interval.value,
    is_free: isFree.value,
    limits: limits.value,
    catalog_version: catalogVersion.value
  });
}

export interface SubscriptionPlanCatalog {
  readonly catalog_version: string;
  readonly plans: readonly SubscriptionPlanEntry[];
  readonly bundles: readonly CreditBundleEntry[];
}

export interface CreditBundleEntry {
  readonly id: string;
  readonly display_name: string;
  readonly premium_credit_units: string;
  readonly standard_credit_units: string;
  readonly price_minor_units: string;
  readonly currency: string;
  readonly catalog_version: string;
}

function validateCreditBundleEntry(value: unknown, param: string): Result<CreditBundleEntry> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const displayName = expectString(value.display_name, `${param}.display_name`);
  if (!displayName.ok) return displayName;
  const premium = expectCanonicalAmount(
    value.premium_credit_units,
    `${param}.premium_credit_units`
  );
  if (!premium.ok) return premium;
  const standard = expectCanonicalAmount(
    value.standard_credit_units,
    `${param}.standard_credit_units`
  );
  if (!standard.ok) return standard;
  const price = expectCanonicalAmount(value.price_minor_units, `${param}.price_minor_units`);
  if (!price.ok) return price;
  const currency = expectString(value.currency, `${param}.currency`);
  if (!currency.ok) return currency;
  const version = expectString(value.catalog_version, `${param}.catalog_version`);
  if (!version.ok) return version;
  return {
    ok: true,
    value: {
      id: id.value,
      display_name: displayName.value,
      premium_credit_units: premium.value,
      standard_credit_units: standard.value,
      price_minor_units: price.value,
      currency: currency.value,
      catalog_version: version.value
    }
  };
}

export function validateSubscriptionPlanCatalog(
  value: unknown,
  options?: ParseOptions
): Result<SubscriptionPlanCatalog> {
  return withResponseOptions(value, options, () => validateSubscriptionPlanCatalogShape(value));
}

function validateSubscriptionPlanCatalogShape(value: unknown): Result<SubscriptionPlanCatalog> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const catalogVersion = expectString(value.catalog_version, "catalog_version");
  if (!catalogVersion.ok) return catalogVersion;
  if (!Array.isArray(value.plans)) return invalidValue("plans", "must be an array");
  if (!Array.isArray(value.bundles)) return invalidValue("bundles", "must be an array");
  const plans: SubscriptionPlanEntry[] = [];
  let freeCount = 0;
  for (const [index, item] of value.plans.entries()) {
    const result = validateSubscriptionPlanEntry(item, `plans[${index}]`);
    if (!result.ok) return result;
    if (result.value.is_free) freeCount += 1;
    plans.push(result.value);
  }
  if (freeCount !== 1) return invalidValue("plans", "exactly one entry must have is_free: true");
  const bundles: CreditBundleEntry[] = [];
  for (const [index, item] of value.bundles.entries()) {
    const result = validateCreditBundleEntry(item, `bundles[${index}]`);
    if (!result.ok) return result;
    bundles.push(result.value);
  }
  return ok({ catalog_version: catalogVersion.value, plans, bundles });
}

/** Shared by `POST /v1/dashboard/personal/subscription` and its `PATCH`. */
export function validateSubscriptionSelectionRequest(
  value: unknown
): Result<{ readonly plan_id: string; readonly catalog_version: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["plan_id", "catalog_version"]);
  if (!rejected.ok) return rejected;
  const planId = expectString(value.plan_id, "plan_id");
  if (!planId.ok) return planId;
  const catalogVersion = expectString(value.catalog_version, "catalog_version");
  if (!catalogVersion.ok) return catalogVersion;
  return ok({ plan_id: planId.value, catalog_version: catalogVersion.value });
}

/** `POST /v1/dashboard/personal/gift-codes/redeem`'s request body: exactly `{ code }`, 1 to 64 characters. */
export const GIFT_CODE_MAX_LENGTH = 64;
export function validateRedeemGiftCodeRequest(value: unknown): Result<{ readonly code: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["code"]);
  if (!rejected.ok) return rejected;
  const code = expectString(value.code, "code");
  if (!code.ok) return code;
  if (code.value.length < 1 || code.value.length > GIFT_CODE_MAX_LENGTH) {
    return invalidValue("code", `must be 1 to ${GIFT_CODE_MAX_LENGTH} characters`);
  }
  return ok({ code: code.value });
}

/** `POST /v1/dashboard/personal/credits`'s request body. */
export function validateCreditsCheckoutRequest(
  value: unknown
): Result<{ readonly bundle_id: string; readonly catalog_version: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["bundle_id", "catalog_version"]);
  if (!rejected.ok) return rejected;
  const bundleId = expectString(value.bundle_id, "bundle_id");
  if (!bundleId.ok) return bundleId;
  const catalogVersion = expectString(value.catalog_version, "catalog_version");
  if (!catalogVersion.ok) return catalogVersion;
  return ok({ bundle_id: bundleId.value, catalog_version: catalogVersion.value });
}

/**
 * Returned by `POST /v1/dashboard/personal/subscription`, and extended with
 * `order_id` by `POST /v1/dashboard/personal/credits`
 * (`CreditsCheckoutResponse`).
 */
export interface DashboardCheckoutResponse {
  readonly transaction_id: string;
  readonly redirect_url: string;
}

export function validateDashboardCheckoutResponse(
  value: unknown,
  options?: ParseOptions
): Result<DashboardCheckoutResponse> {
  return withResponseOptions(value, options, () => validateDashboardCheckoutResponseShape(value));
}

function validateDashboardCheckoutResponseShape(
  value: unknown
): Result<DashboardCheckoutResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const transactionId = expectString(value.transaction_id, "transaction_id");
  if (!transactionId.ok) return transactionId;
  const redirectUrl = expectString(value.redirect_url, "redirect_url");
  if (!redirectUrl.ok) return redirectUrl;
  return ok({ transaction_id: transactionId.value, redirect_url: redirectUrl.value });
}

/**
 * `POST /v1/dashboard/personal/credits` returns
 * `{ transaction_id: string; order_id: string; redirect_url: string }`: the
 * bundle checkout also names the purchase order it created, so a client can
 * find that order in the order list once settlement activates it.
 */
export interface CreditsCheckoutResponse extends DashboardCheckoutResponse {
  readonly order_id: string;
}

export function validateCreditsCheckoutResponse(
  value: unknown,
  options?: ParseOptions
): Result<CreditsCheckoutResponse> {
  return withResponseOptions(value, options, () => validateCreditsCheckoutResponseShape(value));
}

function validateCreditsCheckoutResponseShape(value: unknown): Result<CreditsCheckoutResponse> {
  const shared = validateDashboardCheckoutResponseShape(value);
  if (!shared.ok) return shared;
  const orderId = expectString((value as Record<string, unknown>).order_id, "order_id");
  if (!orderId.ok) return orderId;
  return ok({ ...shared.value, order_id: orderId.value });
}

export const ORDER_KINDS = ["subscription", "bundle"] as const;
export const ORDER_STATUSES = [
  "pending",
  "active",
  "refund_pending",
  "refunded",
  "failed",
  "expired"
] as const;
export const REFUND_ELIGIBILITY = ["full", "half", "none"] as const;
export const REFUND_REASONS = [
  "unused",
  "within_usage_threshold",
  "usage_threshold_exceeded",
  "window_expired",
  "not_active",
  "gift"
] as const;

export interface DashboardRefundQuote {
  readonly eligibility: Readable<(typeof REFUND_ELIGIBILITY)[number]>;
  readonly refund_minor_units: string;
  readonly currency: string;
  readonly reason: Readable<(typeof REFUND_REASONS)[number]>;
}

export interface DashboardPurchaseOrderSummary {
  readonly id: string;
  readonly kind: Readable<(typeof ORDER_KINDS)[number]>;
  readonly product_id: string;
  readonly product_catalog_version: string;
  readonly product_display_name: string;
  readonly status: Readable<(typeof ORDER_STATUSES)[number]>;
  readonly paid_minor_units: string;
  readonly currency: string;
  /**
   * When the order's payment settled (its `refundable_from`; a gift order's
   * redemption), moved forward by a settled upgrade like the refund window.
   * Null only for an order that was never paid.
   */
  readonly purchased_at: string | null;
  readonly refundable_until: string;
  readonly refund: DashboardRefundQuote;
}

export interface DashboardPurchaseOrderPage {
  readonly orders: readonly DashboardPurchaseOrderSummary[];
  readonly next_cursor: string | null;
}

function validateDashboardRefundQuote(value: unknown, param: string): Result<DashboardRefundQuote> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const eligibility = expectLiteral(value.eligibility, REFUND_ELIGIBILITY, `${param}.eligibility`);
  if (!eligibility.ok) return eligibility;
  const amount = expectCanonicalAmount(value.refund_minor_units, `${param}.refund_minor_units`);
  if (!amount.ok) return amount;
  const currency = expectString(value.currency, `${param}.currency`);
  if (!currency.ok) return currency;
  const reason = expectLiteral(value.reason, REFUND_REASONS, `${param}.reason`);
  if (!reason.ok) return reason;
  return ok({
    eligibility: eligibility.value,
    refund_minor_units: amount.value,
    currency: currency.value,
    reason: reason.value
  });
}

export function validateDashboardPurchaseOrderSummary(
  value: unknown,
  param = "body",
  options?: ParseOptions
): Result<DashboardPurchaseOrderSummary> {
  return withResponseOptions(value, options, () => validateDashboardPurchaseOrderSummaryShape(value, param));
}

function validateDashboardPurchaseOrderSummaryShape(
  value: unknown,
  param: string
): Result<DashboardPurchaseOrderSummary> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const kind = expectLiteral(value.kind, ORDER_KINDS, `${param}.kind`);
  if (!kind.ok) return kind;
  const productId = expectString(value.product_id, `${param}.product_id`);
  if (!productId.ok) return productId;
  const productVersion = expectString(
    value.product_catalog_version,
    `${param}.product_catalog_version`
  );
  if (!productVersion.ok) return productVersion;
  const displayName = expectString(value.product_display_name, `${param}.product_display_name`);
  if (!displayName.ok) return displayName;
  const status = expectLiteral(value.status, ORDER_STATUSES, `${param}.status`);
  if (!status.ok) return status;
  const paid = expectCanonicalAmount(value.paid_minor_units, `${param}.paid_minor_units`);
  if (!paid.ok) return paid;
  const currency = expectString(value.currency, `${param}.currency`);
  if (!currency.ok) return currency;
  const purchasedAt = expectNullableRfc3339(value.purchased_at, `${param}.purchased_at`);
  if (!purchasedAt.ok) return purchasedAt;
  const until = expectRfc3339(value.refundable_until, `${param}.refundable_until`);
  if (!until.ok) return until;
  const refund = validateDashboardRefundQuote(value.refund, `${param}.refund`);
  if (!refund.ok) return refund;
  return ok({
    id: id.value,
    kind: kind.value,
    product_id: productId.value,
    product_catalog_version: productVersion.value,
    product_display_name: displayName.value,
    status: status.value,
    paid_minor_units: paid.value,
    currency: currency.value,
    purchased_at: purchasedAt.value,
    refundable_until: until.value,
    refund: refund.value
  });
}

export function validateDashboardPurchaseOrderPage(
  value: unknown,
  options?: ParseOptions
): Result<DashboardPurchaseOrderPage> {
  return withResponseOptions(value, options, () => validateDashboardPurchaseOrderPageShape(value));
}

function validateDashboardPurchaseOrderPageShape(value: unknown): Result<DashboardPurchaseOrderPage> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!Array.isArray(value.orders)) return invalidValue("orders", "must be an array");
  const orders: DashboardPurchaseOrderSummary[] = [];
  for (const [index, candidate] of value.orders.entries()) {
    const order = validateDashboardPurchaseOrderSummaryShape(candidate, `orders[${index}]`);
    if (!order.ok) return order;
    orders.push(order.value);
  }
  const cursor = expectNullableString(value.next_cursor, "next_cursor");
  if (!cursor.ok) return cursor;
  return ok({ orders, next_cursor: cursor.value });
}

/**
 * One closed period on `GET /v1/dashboard/personal/periods`: the boundaries
 * and the plan recorded on it, so the usage selector offers exactly the
 * `period_start` values `GET /v1/dashboard/personal/usage` accepts.
 */
export interface PersonalPeriodSummary {
  readonly period_start: string;
  readonly period_end: string;
  readonly plan: SubscriptionPlanSummary;
}

export interface PersonalPeriodPage {
  readonly periods: readonly PersonalPeriodSummary[];
  readonly next_cursor: string | null;
}

export function validatePersonalPeriodPage(value: unknown, options?: ParseOptions): Result<PersonalPeriodPage> {
  return withResponseOptions(value, options, () => validatePersonalPeriodPageShape(value));
}

function validatePersonalPeriodPageShape(value: unknown): Result<PersonalPeriodPage> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!Array.isArray(value.periods)) return invalidValue("periods", "must be an array");
  const periods: PersonalPeriodSummary[] = [];
  for (const [index, candidate] of value.periods.entries()) {
    const param = `periods[${index}]`;
    if (!isPlainObject(candidate)) return invalidValue(param, "must be an object");
    const start = expectRfc3339(candidate.period_start, `${param}.period_start`);
    if (!start.ok) return start;
    const end = expectRfc3339(candidate.period_end, `${param}.period_end`);
    if (!end.ok) return end;
    const plan = validateSubscriptionPlanSummaryShape(candidate.plan, `${param}.plan`);
    if (!plan.ok) return plan;
    periods.push({ period_start: start.value, period_end: end.value, plan: plan.value });
  }
  const cursor = expectNullableString(value.next_cursor, "next_cursor");
  if (!cursor.ok) return cursor;
  return ok({ periods, next_cursor: cursor.value });
}

// ---------------------------------------------------------------------------
// Business dashboard and SDK reporting: shared read model
// ---------------------------------------------------------------------------

export const API_KEY_SCOPES = ["model", "reporting"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * What a person reads for each key scope (`specs/PROTOCOLS.md`, "Key scope
 * display names"). The wire values stay `model` and `reporting`; only the
 * dashboard, CLI human output, and docs use these names, because "model" read
 * as a choice of AI model rather than as what the key is for. Both the
 * dashboard and the CLI read them from here so the wording cannot drift.
 */
export const API_KEY_SCOPE_LABELS: Readonly<
  Record<ApiKeyScope, { readonly label: string; readonly description: string }>
> = {
  model: {
    label: "App key",
    description:
      "Lets one app's server sign users in and make AI calls for them. Tied to one app and one environment."
  },
  reporting: {
    label: "Read-only key",
    description:
      "Reads your business stats and earnings for scripts and automation. Can't make AI calls or change anything."
  }
};

/** Label for a scope that was read as the unknown-enum `"other"`. */
export const UNKNOWN_API_KEY_SCOPE_LABEL = "Key";
export const API_KEY_STATUSES = ["active", "revoked", "expired"] as const;

/**
 * Shared by every `api_keys` list on the wire: `BusinessDashboardInfo`'s
 * per-application list, `BusinessApplicationDetail`'s own list, and the bare
 * list/creation/rotation responses under `POST|GET|DELETE /v1/dashboard/business/keys*`.
 */
export interface ApiKeyMetadata {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scope: Readable<"model" | "reporting">;
  readonly application_id: string | null;
  readonly environment: Readable<"test" | "live"> | null;
  readonly status: Readable<"active" | "revoked" | "expired">;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
}

export function validateApiKeyMetadata(
  value: unknown,
  param = "key",
  options?: ParseOptions
): Result<ApiKeyMetadata> {
  return withResponseOptions(value, options, () => validateApiKeyMetadataShape(value, param));
}

function validateApiKeyMetadataShape(value: unknown, param: string): Result<ApiKeyMetadata> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  // A raw key must never appear on a metadata read.
  if ("secret" in value || "key" in value || "raw_key" in value) {
    return invalidValue(param, "must not carry a raw key");
  }
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const name = expectString(value.name, `${param}.name`);
  if (!name.ok) return name;
  const prefix = expectString(value.prefix, `${param}.prefix`);
  if (!prefix.ok) return prefix;
  const scope = expectLiteral(value.scope, API_KEY_SCOPES, `${param}.scope`);
  if (!scope.ok) return scope;
  const applicationId = expectNullableString(value.application_id, `${param}.application_id`);
  if (!applicationId.ok) return applicationId;
  const environment = expectNullableLiteral(
    value.environment,
    APPLICATION_ENVIRONMENTS,
    `${param}.environment`
  );
  if (!environment.ok) return environment;
  const status = expectLiteral(value.status, API_KEY_STATUSES, `${param}.status`);
  if (!status.ok) return status;
  const createdAt = expectRfc3339(value.created_at, `${param}.created_at`);
  if (!createdAt.ok) return createdAt;
  const expiresAt = expectNullableRfc3339(value.expires_at, `${param}.expires_at`);
  if (!expiresAt.ok) return expiresAt;
  const lastUsedAt = expectNullableRfc3339(value.last_used_at, `${param}.last_used_at`);
  if (!lastUsedAt.ok) return lastUsedAt;

  // "null exactly on a `reporting`-scope key, which is bound to no application".
  const shouldBeNull = scope.value === "reporting";
  if (shouldBeNull && (applicationId.value !== null || environment.value !== null)) {
    return invalidValue(
      param,
      "application_id and environment must be null on a reporting-scope key"
    );
  }
  if (
    (scope.value as string) !== UNKNOWN_ENUM_VALUE &&
    !shouldBeNull &&
    (applicationId.value === null || environment.value === null)
  ) {
    return invalidValue(
      param,
      "application_id and environment must be non-null on a model-scope key"
    );
  }

  return ok({
    id: id.value,
    name: name.value,
    prefix: prefix.value,
    scope: scope.value,
    application_id: applicationId.value,
    environment: environment.value,
    status: status.value,
    created_at: createdAt.value,
    expires_at: expiresAt.value,
    last_used_at: lastUsedAt.value
  });
}

function validateApiKeyMetadataArray(
  value: unknown,
  param: string
): Result<readonly ApiKeyMetadata[]> {
  if (!Array.isArray(value)) return invalidValue(param, "must be an array");
  const keys: ApiKeyMetadata[] = [];
  for (const [index, item] of value.entries()) {
    const result = validateApiKeyMetadata(item, `${param}[${index}]`);
    if (!result.ok) return result;
    keys.push(result.value);
  }
  return ok(keys);
}

/** The bare `ApiKeyMetadata[]` returned by `GET|DELETE /v1/dashboard/business/keys*`. */
export function validateApiKeyMetadataList(
  value: unknown,
  options?: ParseOptions
): Result<readonly ApiKeyMetadata[]> {
  return withResponseOptions(value, options, () => validateApiKeyMetadataArray(value, "body"));
}

export interface BusinessDailyVisitor {
  readonly date: string;
  readonly count: number;
}

function validateBusinessDailyVisitor(value: unknown, param: string): Result<BusinessDailyVisitor> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const date = expectCalendarDay(value.date, `${param}.date`);
  if (!date.ok) return date;
  const count = expectNonNegativeInteger(value.count, `${param}.count`);
  if (!count.ok) return count;
  return ok({ date: date.value, count: count.value });
}

/** One UTC day of the business-wide request and premium-earnings series. */
export interface BusinessDailyUsage {
  readonly date: string;
  readonly standard_requests: number;
  readonly premium_requests: number;
  readonly premium_earnings_nano_usd: string;
}

function validateBusinessDailyUsage(value: unknown, param: string): Result<BusinessDailyUsage> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const date = expectCalendarDay(value.date, `${param}.date`);
  if (!date.ok) return date;
  const standard = expectNonNegativeInteger(value.standard_requests, `${param}.standard_requests`);
  if (!standard.ok) return standard;
  const premium = expectNonNegativeInteger(value.premium_requests, `${param}.premium_requests`);
  if (!premium.ok) return premium;
  const earnings = expectCanonicalAmount(
    value.premium_earnings_nano_usd,
    `${param}.premium_earnings_nano_usd`
  );
  if (!earnings.ok) return earnings;
  return ok({
    date: date.value,
    standard_requests: standard.value,
    premium_requests: premium.value,
    premium_earnings_nano_usd: earnings.value
  });
}

export interface BusinessApplicationUsageBucket {
  readonly requests: number;
  readonly used_nano_usd: string;
}

function validateBusinessApplicationUsageBucket(
  value: unknown,
  param: string
): Result<BusinessApplicationUsageBucket> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const requests = expectNonNegativeInteger(value.requests, `${param}.requests`);
  if (!requests.ok) return requests;
  const usedNanoUsd = expectCanonicalAmount(
    value.used_nano_usd,
    `${param}.used_nano_usd`
  );
  if (!usedNanoUsd.ok) return usedNanoUsd;
  return ok({ requests: requests.value, used_nano_usd: usedNanoUsd.value });
}

export interface BusinessApplicationPremiumUsageBucket extends BusinessApplicationUsageBucket {
  readonly earnings_nano_usd: string;
}

function validateBusinessApplicationPremiumUsageBucket(
  value: unknown,
  param: string
): Result<BusinessApplicationPremiumUsageBucket> {
  const base = validateBusinessApplicationUsageBucket(value, param);
  if (!base.ok) return base;
  const record = value as Record<string, unknown>;
  const earningsNanoUsd = expectCanonicalAmount(
    record.earnings_nano_usd,
    `${param}.earnings_nano_usd`
  );
  if (!earningsNanoUsd.ok) return earningsNanoUsd;
  return ok({ ...base.value, earnings_nano_usd: earningsNanoUsd.value });
}

export interface BusinessApplicationUsage {
  readonly standard: BusinessApplicationUsageBucket;
  readonly premium: BusinessApplicationPremiumUsageBucket;
}

function validateBusinessApplicationUsage(
  value: unknown,
  param: string
): Result<BusinessApplicationUsage> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const standard = validateBusinessApplicationUsageBucket(value.standard, `${param}.standard`);
  if (!standard.ok) return standard;
  const premium = validateBusinessApplicationPremiumUsageBucket(value.premium, `${param}.premium`);
  if (!premium.ok) return premium;
  return ok({ standard: standard.value, premium: premium.value });
}

export const APPLICATION_STATUSES = ["active", "suspended", "closed"] as const;

/**
 * One entry of `BusinessDashboardInfo.applications`, shared by
 * `GET /v1/dashboard/business` and `GET /v1/business/info` because both
 * routes return the one `BusinessDashboardInfo` this module declares once.
 */
export interface BusinessApplicationSummary {
  readonly id: string;
  readonly name: string;
  readonly environment: Readable<"test" | "live">;
  readonly status: Readable<"active" | "suspended" | "closed">;
  readonly client_id: string;
  /** The stored presentation icon; omitted when none is set. */
  readonly icon_url?: string;
  readonly created_at: string;
  readonly api_keys: readonly ApiKeyMetadata[];
  readonly daily_visitors: readonly BusinessDailyVisitor[];
  /**
   * Distinct personal principals with at least one call anywhere in the
   * range: one person counts once however many days they called, so this is
   * never the sum of `daily_visitors`.
   */
  readonly visitors: number;
  readonly usage: BusinessApplicationUsage;
}

function validateBusinessApplicationSummary(
  value: unknown,
  param: string
): Result<BusinessApplicationSummary> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const name = expectString(value.name, `${param}.name`);
  if (!name.ok) return name;
  const environment = expectLiteral(
    value.environment,
    APPLICATION_ENVIRONMENTS,
    `${param}.environment`
  );
  if (!environment.ok) return environment;
  const status = expectLiteral(value.status, APPLICATION_STATUSES, `${param}.status`);
  if (!status.ok) return status;
  const clientId = expectString(value.client_id, `${param}.client_id`);
  if (!clientId.ok) return clientId;
  const iconUrl = expectOptionalString(value.icon_url, `${param}.icon_url`);
  if (!iconUrl.ok) return iconUrl;
  const createdAt = expectRfc3339(value.created_at, `${param}.created_at`);
  if (!createdAt.ok) return createdAt;
  const apiKeys = validateApiKeyMetadataArray(value.api_keys, `${param}.api_keys`);
  if (!apiKeys.ok) return apiKeys;
  if (!Array.isArray(value.daily_visitors))
    return invalidValue(`${param}.daily_visitors`, "must be an array");
  const dailyVisitors: BusinessDailyVisitor[] = [];
  for (const [index, item] of value.daily_visitors.entries()) {
    const result = validateBusinessDailyVisitor(item, `${param}.daily_visitors[${index}]`);
    if (!result.ok) return result;
    dailyVisitors.push(result.value);
  }
  const visitors = expectNonNegativeInteger(value.visitors, `${param}.visitors`);
  if (!visitors.ok) return visitors;
  const usage = validateBusinessApplicationUsage(value.usage, `${param}.usage`);
  if (!usage.ok) return usage;
  return ok({
    id: id.value,
    name: name.value,
    environment: environment.value,
    status: status.value,
    client_id: clientId.value,
    ...(iconUrl.value !== undefined ? { icon_url: iconUrl.value } : {}),
    created_at: createdAt.value,
    api_keys: apiKeys.value,
    daily_visitors: dailyVisitors,
    visitors: visitors.value,
    usage: usage.value
  });
}

export interface BusinessDashboardBusiness {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

function validateBusinessDashboardBusiness(value: unknown): Result<BusinessDashboardBusiness> {
  if (!isPlainObject(value)) return invalidValue("business", "must be an object");
  const id = expectString(value.id, "business.id");
  if (!id.ok) return id;
  const name = expectString(value.name, "business.name");
  if (!name.ok) return name;
  const email = expectOptionalString(value.email, "business.email");
  if (!email.ok) return email;
  return ok({
    id: id.value,
    name: name.value,
    ...(email.value !== undefined ? { email: email.value } : {})
  });
}

export interface BusinessEarnings {
  readonly earnings_nano_usd: string;
  readonly payout_pending_nano_usd: string;
  readonly display_currency: Readable<"USD">;
}

function validateBusinessEarnings(value: unknown): Result<BusinessEarnings> {
  if (!isPlainObject(value)) return invalidValue("earnings", "must be an object");
  const rejected = rejectUnknownResponseKeys(value, [
    "earnings_nano_usd",
    "payout_pending_nano_usd",
    "display_currency"
  ]);
  if (!rejected.ok) return rejected;
  const earningsNanoUsd = expectCanonicalAmount(
    value.earnings_nano_usd,
    "earnings.earnings_nano_usd"
  );
  if (!earningsNanoUsd.ok) return earningsNanoUsd;
  const payoutPendingNanoUsd = expectCanonicalAmount(
    value.payout_pending_nano_usd,
    "earnings.payout_pending_nano_usd"
  );
  if (!payoutPendingNanoUsd.ok) return payoutPendingNanoUsd;
  const displayCurrency = expectLiteral(value.display_currency, ["USD"] as const, "earnings.display_currency");
  if (!displayCurrency.ok) return displayCurrency;
  return ok({
    earnings_nano_usd: earningsNanoUsd.value,
    payout_pending_nano_usd: payoutPendingNanoUsd.value,
    display_currency: displayCurrency.value
  });
}

export const CONNECTED_ACCOUNT_STATUSES = [
  "none",
  "onboarding",
  "restricted",
  "enabled",
  "rejected"
] as const;
export const PAYOUT_BLOCKED_REASONS = [
  "payout_blocked",
  "below_minimum",
  "outstanding_deficit",
  "tax_details_required",
  "payout_account_incomplete",
  "monthly_payout_taken",
  "payout_pending"
] as const;

/** The complete business permission vocabulary carried on dashboard reads. */
export const BUSINESS_PERMISSIONS = [
  "stats.view",
  "apps.manage",
  "keys.manage",
  "payouts.manage",
  "payout_billing.manage",
  "members.manage",
  "premium.manage",
  "ownership.transfer"
] as const;
export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

/** Role names are wire vocabulary; Account alone maps them to permissions. */
export const BUSINESS_ROLE_NAMES = ["owner", "admin", "developer", "viewer"] as const;
export type BusinessRole = (typeof BUSINESS_ROLE_NAMES)[number];
export type AssignableBusinessRole = Exclude<BusinessRole, "owner">;

export function validateBusinessPermission(
  value: unknown,
  param = "permission",
  options?: ParseOptions
): Result<Readable<BusinessPermission>> {
  return withResponseOptions(value, options, () => expectLiteral(value, BUSINESS_PERMISSIONS, param));
}

export function validateBusinessRole(
  value: unknown,
  param = "role",
  options?: ParseOptions
): Result<Readable<BusinessRole>> {
  return withResponseOptions(value, options, () => expectLiteral(value, BUSINESS_ROLE_NAMES, param));
}

export type PayoutBlockedReason = (typeof PAYOUT_BLOCKED_REASONS)[number];

export interface BusinessPayoutInfo {
  readonly eligible: boolean;
  readonly connected_account_status: Readable<"none" | "onboarding" | "restricted" | "enabled" | "rejected">;
  readonly policy_code_version: string;
  readonly minimum_available_nano_usd: string;
  readonly next_eligible_at: string | null;
  readonly blocked_reason?: Readable<PayoutBlockedReason>;
}

function validateBusinessPayoutInfo(value: unknown): Result<BusinessPayoutInfo> {
  if (!isPlainObject(value)) return invalidValue("payout", "must be an object");
  const eligible = expectBoolean(value.eligible, "payout.eligible");
  if (!eligible.ok) return eligible;
  const connectedAccountStatus = expectLiteral(
    value.connected_account_status,
    CONNECTED_ACCOUNT_STATUSES,
    "payout.connected_account_status"
  );
  if (!connectedAccountStatus.ok) return connectedAccountStatus;
  const policyCodeVersion = expectString(value.policy_code_version, "payout.policy_code_version");
  if (!policyCodeVersion.ok) return policyCodeVersion;
  const minimumAvailable = expectCanonicalAmount(
    value.minimum_available_nano_usd,
    "payout.minimum_available_nano_usd"
  );
  if (!minimumAvailable.ok) return minimumAvailable;
  const nextEligibleAt = expectNullableRfc3339(value.next_eligible_at, "payout.next_eligible_at");
  if (!nextEligibleAt.ok) return nextEligibleAt;
  const blockedReason =
    value.blocked_reason === undefined
      ? ok(undefined)
      : expectLiteral(value.blocked_reason, PAYOUT_BLOCKED_REASONS, "payout.blocked_reason");
  if (!blockedReason.ok) return blockedReason;

  if (eligible.value && blockedReason.value !== undefined) {
    return invalidValue("payout.blocked_reason", "must be absent when eligible is true");
  }
  if (!eligible.value && blockedReason.value === undefined) {
    return invalidValue("payout.blocked_reason", "must be present when eligible is false");
  }

  return ok({
    eligible: eligible.value,
    connected_account_status: connectedAccountStatus.value,
    policy_code_version: policyCodeVersion.value,
    minimum_available_nano_usd: minimumAvailable.value,
    next_eligible_at: nextEligibleAt.value,
    ...(blockedReason.value !== undefined ? { blocked_reason: blockedReason.value } : {})
  });
}

/**
 * `GET /v1/dashboard/business` and `GET /v1/business/info` return this same
 * body, "composed once by a single backend read-model builder so the two
 * entry points cannot drift" — this is the one declaration that validates
 * both.
 */
/**
 * The business-wide aggregate over the requested range, across every owned
 * application whatever page `applications` is on. `daily_visitors` counts a
 * person once per day across the business, so it is not the sum of the
 * per-application series; `usage` is the exact sum of every application's.
 */
export interface BusinessTraffic {
  readonly daily_visitors: readonly BusinessDailyVisitor[];
  /** Per-UTC-day requests and premium earnings; days with no calls are omitted. */
  readonly daily_usage: readonly BusinessDailyUsage[];
  readonly usage: BusinessApplicationUsage;
}

function validateBusinessTraffic(value: unknown, param: string): Result<BusinessTraffic> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  if (!Array.isArray(value.daily_visitors))
    return invalidValue(`${param}.daily_visitors`, "must be an array");
  const dailyVisitors: BusinessDailyVisitor[] = [];
  for (const [index, item] of value.daily_visitors.entries()) {
    const result = validateBusinessDailyVisitor(item, `${param}.daily_visitors[${index}]`);
    if (!result.ok) return result;
    dailyVisitors.push(result.value);
  }
  if (!Array.isArray(value.daily_usage))
    return invalidValue(`${param}.daily_usage`, "must be an array");
  const dailyUsage: BusinessDailyUsage[] = [];
  for (const [index, item] of value.daily_usage.entries()) {
    const result = validateBusinessDailyUsage(item, `${param}.daily_usage[${index}]`);
    if (!result.ok) return result;
    dailyUsage.push(result.value);
  }
  const usage = validateBusinessApplicationUsage(value.usage, `${param}.usage`);
  if (!usage.ok) return usage;
  return ok({ daily_visitors: dailyVisitors, daily_usage: dailyUsage, usage: usage.value });
}

/** One past payout of the active business (`GET /v1/dashboard/business/payouts`). */
export interface BusinessPayoutRecord {
  readonly id: string;
  readonly amount_nano_usd: string;
  readonly status: Readable<"pending" | "completed" | "failed" | "canceled">;
  readonly requested_at: string;
  /** Null exactly while the payout is pending. */
  readonly settled_at: string | null;
}

export const BUSINESS_PAYOUT_STATUSES = ["pending", "completed", "failed", "canceled"] as const;

function validateBusinessPayoutRecord(value: unknown, param: string): Result<BusinessPayoutRecord> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const rejected = rejectUnknownResponseKeys(value, [
    "id",
    "amount_nano_usd",
    "status",
    "requested_at",
    "settled_at"
  ]);
  if (!rejected.ok) return rejected;
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const amount = expectPositiveCanonicalAmount(value.amount_nano_usd, `${param}.amount_nano_usd`);
  if (!amount.ok) return amount;
  const status = expectLiteral(value.status, BUSINESS_PAYOUT_STATUSES, `${param}.status`);
  if (!status.ok) return status;
  const requestedAt = expectRfc3339(value.requested_at, `${param}.requested_at`);
  if (!requestedAt.ok) return requestedAt;
  const settledAt = expectNullableRfc3339(value.settled_at, `${param}.settled_at`);
  if (!settledAt.ok) return settledAt;
  if ((status.value === "pending") !== (settledAt.value === null)) {
    return invalidValue(`${param}.settled_at`, "must be null exactly while the payout is pending");
  }
  return ok({
    id: id.value,
    amount_nano_usd: amount.value,
    status: status.value,
    requested_at: requestedAt.value,
    settled_at: settledAt.value
  });
}

/** `GET /v1/dashboard/business/payouts` response. */
export interface BusinessPayoutList {
  readonly payouts: readonly BusinessPayoutRecord[];
  readonly next_cursor: string | null;
}

export function validateBusinessPayoutList(
  value: unknown,
  options?: ParseOptions
): Result<BusinessPayoutList> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("payouts", "must be an object");
    if (!Array.isArray(value.payouts)) return invalidValue("payouts", "must be an array");
    const payouts: BusinessPayoutRecord[] = [];
    for (const [index, item] of value.payouts.entries()) {
      const result = validateBusinessPayoutRecord(item, `payouts[${index}]`);
      if (!result.ok) return result;
      payouts.push(result.value);
    }
    const nextCursor = expectNullableString(value.next_cursor, "next_cursor");
    if (!nextCursor.ok) return nextCursor;
    return ok({ payouts, next_cursor: nextCursor.value });
  });
}

export interface BusinessDashboardInfo {
  readonly business: BusinessDashboardBusiness;
  readonly earnings: BusinessEarnings;
  readonly payout: BusinessPayoutInfo;
  readonly traffic: BusinessTraffic;
  readonly applications: readonly BusinessApplicationSummary[];
  readonly next_cursor: string | null;
  readonly range: DashboardRange;
  readonly data_fresh_at: string;
}

export function validateBusinessDashboardInfo(
  value: unknown,
  options?: ParseOptions
): Result<BusinessDashboardInfo> {
  return withResponseOptions(value, options, () => validateBusinessDashboardInfoShape(value));
}

function validateBusinessDashboardInfoShape(value: unknown): Result<BusinessDashboardInfo> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const business = validateBusinessDashboardBusiness(value.business);
  if (!business.ok) return business;
  const earnings = validateBusinessEarnings(value.earnings);
  if (!earnings.ok) return earnings;
  const payout = validateBusinessPayoutInfo(value.payout);
  if (!payout.ok) return payout;
  const traffic = validateBusinessTraffic(value.traffic, "traffic");
  if (!traffic.ok) return traffic;
  if (!Array.isArray(value.applications)) return invalidValue("applications", "must be an array");
  const applications: BusinessApplicationSummary[] = [];
  for (const [index, item] of value.applications.entries()) {
    const result = validateBusinessApplicationSummary(item, `applications[${index}]`);
    if (!result.ok) return result;
    applications.push(result.value);
  }
  const nextCursor = expectNullableString(value.next_cursor, "next_cursor");
  if (!nextCursor.ok) return nextCursor;
  const range = validateDashboardRange(value.range, "range");
  if (!range.ok) return range;
  const dataFreshAt = expectRfc3339(value.data_fresh_at, "data_fresh_at");
  if (!dataFreshAt.ok) return dataFreshAt;
  return ok({
    business: business.value,
    earnings: earnings.value,
    payout: payout.value,
    traffic: traffic.value,
    applications,
    next_cursor: nextCursor.value,
    range: range.value,
    data_fresh_at: dataFreshAt.value
  });
}

// ---------------------------------------------------------------------------
// Business mutations
// ---------------------------------------------------------------------------

/**
 * An absolute URL check shared by `redirect_uris` and `allowed_origins`.
 * Enforces every categorical rule `specs/PROTOCOLS.md` states (absolute,
 * `https` except on a loopback host, no userinfo, no wildcard host); count
 * and length bounds are deployed policy this module's read scope does not
 * state a number for, matching the `JsonSchema` precedent in `responses.ts`.
 */
function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function validateRedirectUri(value: unknown, param: string): Result<string> {
  if (typeof value !== "string") return invalidValue(param, "must be a string");
  const url = parseAbsoluteUrl(value);
  if (url === null) return invalidValue(param, "must be an absolute URI");
  if (url.hash !== "") return invalidValue(param, "must not carry a fragment");
  if (url.username !== "" || url.password !== "")
    return invalidValue(param, "must not carry userinfo");
  if (url.hostname.includes("*")) return invalidValue(param, "must not carry a wildcard host");
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    return invalidValue(param, "must use https except on a loopback host");
  }
  return ok(value);
}

function validateAllowedOrigin(value: unknown, param: string): Result<string> {
  if (typeof value !== "string") return invalidValue(param, "must be a string");
  const url = parseAbsoluteUrl(value);
  if (url === null) return invalidValue(param, "must be an absolute origin");
  if (url.hash !== "") return invalidValue(param, "must not carry a fragment");
  if (url.search !== "") return invalidValue(param, "must not carry a query");
  if (url.pathname !== "" && url.pathname !== "/")
    return invalidValue(param, "must not carry a path");
  if (url.username !== "" || url.password !== "")
    return invalidValue(param, "must not carry userinfo");
  if (url.hostname.includes("*")) return invalidValue(param, "must not carry a wildcard host");
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    return invalidValue(param, "must use https except on a loopback host");
  }
  return ok(value);
}

function validateUniqueStringList(
  value: unknown,
  param: string,
  each: (item: unknown, itemParam: string) => Result<string>
): Result<readonly string[]> {
  if (!Array.isArray(value)) return invalidValue(param, "must be an array");
  const seen = new Set<string>();
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    const result = each(item, `${param}[${index}]`);
    if (!result.ok) return result;
    if (seen.has(result.value))
      return invalidValue(`${param}[${index}]`, "must not duplicate another entry");
    seen.add(result.value);
    items.push(result.value);
  }
  return ok(items);
}

export interface CreateBusinessApplicationRequest {
  readonly name: string;
  readonly environment: "test" | "live";
  readonly redirect_uris: readonly string[];
  readonly allowed_origins: readonly string[];
  readonly icon_url?: string;
  readonly description?: string;
  readonly estimated_avg_charge_nano_usd?: string;
}

export function validateCreateBusinessApplicationRequest(
  value: unknown
): Result<CreateBusinessApplicationRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, [
    "name",
    "environment",
    "redirect_uris",
    "allowed_origins",
    "icon_url",
    "description",
    "estimated_avg_charge_nano_usd"
  ]);
  if (!rejected.ok) return rejected;
  const name = expectString(value.name, "name");
  if (!name.ok) return name;
  const environment = expectLiteral(value.environment, APPLICATION_ENVIRONMENTS, "environment");
  if (!environment.ok) return environment;
  const redirectUris = validateUniqueStringList(
    value.redirect_uris,
    "redirect_uris",
    validateRedirectUri
  );
  if (!redirectUris.ok) return redirectUris;
  const allowedOrigins = validateUniqueStringList(
    value.allowed_origins,
    "allowed_origins",
    validateAllowedOrigin
  );
  if (!allowedOrigins.ok) return allowedOrigins;
  const iconUrl = expectOptionalString(value.icon_url, "icon_url");
  if (!iconUrl.ok) return iconUrl;
  const description = expectOptionalString(value.description, "description");
  if (!description.ok) return description;
  // Upper bound (FINANCE_POLICY.maxChargeNanoUsd) is enforced by Account.
  const estimate =
    value.estimated_avg_charge_nano_usd === undefined
      ? ok(undefined)
      : expectPositiveCanonicalAmount(
          value.estimated_avg_charge_nano_usd,
          "estimated_avg_charge_nano_usd"
        );
  if (!estimate.ok) return estimate;
  return ok({
    name: name.value,
    environment: environment.value,
    redirect_uris: redirectUris.value,
    allowed_origins: allowedOrigins.value,
    ...(iconUrl.value !== undefined ? { icon_url: iconUrl.value } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(estimate.value !== undefined ? { estimated_avg_charge_nano_usd: estimate.value } : {})
  });
}

export interface UpdateBusinessApplicationRequest {
  readonly name?: string;
  readonly redirect_uris?: readonly string[];
  readonly allowed_origins?: readonly string[];
  readonly icon_url?: string | null;
  readonly description?: string | null;
  readonly estimated_avg_charge_nano_usd?: string | null;
}

export function validateUpdateBusinessApplicationRequest(
  value: unknown
): Result<UpdateBusinessApplicationRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if ("environment" in value) {
    return unsupportedParameter(
      "environment",
      "environment is fixed at creation and cannot be changed"
    );
  }
  const rejected = rejectUnknownKeys(value, [
    "name",
    "redirect_uris",
    "allowed_origins",
    "icon_url",
    "description",
    "estimated_avg_charge_nano_usd"
  ]);
  if (!rejected.ok) return rejected;

  const result: {
    name?: string;
    redirect_uris?: readonly string[];
    allowed_origins?: readonly string[];
    icon_url?: string | null;
    description?: string | null;
    estimated_avg_charge_nano_usd?: string | null;
  } = {};

  if (value.name !== undefined) {
    const name = expectString(value.name, "name");
    if (!name.ok) return name;
    result.name = name.value;
  }
  if (value.redirect_uris !== undefined) {
    const redirectUris = validateUniqueStringList(
      value.redirect_uris,
      "redirect_uris",
      validateRedirectUri
    );
    if (!redirectUris.ok) return redirectUris;
    result.redirect_uris = redirectUris.value;
  }
  if (value.allowed_origins !== undefined) {
    const allowedOrigins = validateUniqueStringList(
      value.allowed_origins,
      "allowed_origins",
      validateAllowedOrigin
    );
    if (!allowedOrigins.ok) return allowedOrigins;
    result.allowed_origins = allowedOrigins.value;
  }
  if (value.icon_url !== undefined) {
    const iconUrl = expectNullableString(value.icon_url, "icon_url");
    if (!iconUrl.ok) return iconUrl;
    result.icon_url = iconUrl.value;
  }
  if (value.description !== undefined) {
    const description = expectNullableString(value.description, "description");
    if (!description.ok) return description;
    result.description = description.value;
  }
  if (value.estimated_avg_charge_nano_usd !== undefined) {
    // null clears the estimate; anything else must be a positive canonical amount.
    const estimate =
      value.estimated_avg_charge_nano_usd === null
        ? ok(null)
        : expectPositiveCanonicalAmount(
            value.estimated_avg_charge_nano_usd,
            "estimated_avg_charge_nano_usd"
          );
    if (!estimate.ok) return estimate;
    result.estimated_avg_charge_nano_usd = estimate.value;
  }
  return ok(result);
}

export interface BusinessApplicationAnalyticsDay {
  readonly day: string;
  readonly daily_visitors: number;
  readonly standard_requests: number;
  readonly premium_requests: number;
  readonly standard_used_nano_usd: string;
  readonly premium_used_nano_usd: string;
  readonly business_earnings_nano_usd: string;
}

function validateBusinessApplicationAnalyticsDay(
  value: unknown,
  param: string
): Result<BusinessApplicationAnalyticsDay> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const day = expectCalendarDay(value.day, `${param}.day`);
  if (!day.ok) return day;
  const dailyVisitors = expectNonNegativeInteger(value.daily_visitors, `${param}.daily_visitors`);
  if (!dailyVisitors.ok) return dailyVisitors;
  const standardRequests = expectNonNegativeInteger(
    value.standard_requests,
    `${param}.standard_requests`
  );
  if (!standardRequests.ok) return standardRequests;
  const premiumRequests = expectNonNegativeInteger(
    value.premium_requests,
    `${param}.premium_requests`
  );
  if (!premiumRequests.ok) return premiumRequests;
  const standardUsedNanoUsd = expectCanonicalAmount(
    value.standard_used_nano_usd,
    `${param}.standard_used_nano_usd`
  );
  if (!standardUsedNanoUsd.ok) return standardUsedNanoUsd;
  const premiumUsedNanoUsd = expectCanonicalAmount(
    value.premium_used_nano_usd,
    `${param}.premium_used_nano_usd`
  );
  if (!premiumUsedNanoUsd.ok) return premiumUsedNanoUsd;
  const businessEarningsNanoUsd = expectCanonicalAmount(
    value.business_earnings_nano_usd,
    `${param}.business_earnings_nano_usd`
  );
  if (!businessEarningsNanoUsd.ok) return businessEarningsNanoUsd;
  return ok({
    day: day.value,
    daily_visitors: dailyVisitors.value,
    standard_requests: standardRequests.value,
    premium_requests: premiumRequests.value,
    standard_used_nano_usd: standardUsedNanoUsd.value,
    premium_used_nano_usd: premiumUsedNanoUsd.value,
    business_earnings_nano_usd: businessEarningsNanoUsd.value
  });
}

export interface BusinessApplicationAnalytics {
  readonly range: DashboardRange;
  readonly days: readonly BusinessApplicationAnalyticsDay[];
  readonly next_cursor: string | null;
}

function validateBusinessApplicationAnalytics(
  value: unknown
): Result<BusinessApplicationAnalytics> {
  if (!isPlainObject(value)) return invalidValue("analytics", "must be an object");
  const range = validateDashboardRange(value.range, "analytics.range");
  if (!range.ok) return range;
  if (!Array.isArray(value.days)) return invalidValue("analytics.days", "must be an array");
  const days: BusinessApplicationAnalyticsDay[] = [];
  for (const [index, item] of value.days.entries()) {
    const result = validateBusinessApplicationAnalyticsDay(item, `analytics.days[${index}]`);
    if (!result.ok) return result;
    days.push(result.value);
  }
  const nextCursor = expectNullableString(value.next_cursor, "analytics.next_cursor");
  if (!nextCursor.ok) return nextCursor;
  return ok({ range: range.value, days, next_cursor: nextCursor.value });
}

/**
 * `info` holds exactly the allowlisted presentation metadata — `icon_url`,
 * `description`, and `estimated_avg_charge_nano_usd` — per `specs/PROTOCOLS.md`'s `BusinessApplicationDetail`
 * bullet: its two keys are named there rather than left to prose, since a
 * shape whose keys are only described in prose is a shape each side spells
 * its own way.
 */
export interface BusinessApplicationInfo {
  readonly icon_url?: string;
  readonly description?: string;
  readonly estimated_avg_charge_nano_usd?: string;
}

/** Validates the allowlisted presentation object in a business application read. */
export function validateBusinessApplicationInfo(
  value: unknown,
  param = "info",
  options?: ParseOptions
): Result<BusinessApplicationInfo | null> {
  return withResponseOptions(value, options, () => validateBusinessApplicationInfoShape(value, param));
}

function validateBusinessApplicationInfoShape(
  value: unknown,
  param: string
): Result<BusinessApplicationInfo | null> {
  if (value === null) return ok(null);
  if (!isPlainObject(value)) return invalidValue(param, "must be an object or null");
  const rejected = rejectUnknownResponseKeys(value, [
    "icon_url",
    "description",
    "estimated_avg_charge_nano_usd"
  ]);
  if (!rejected.ok) return rejected;
  const iconUrl = expectOptionalString(value.icon_url, `${param}.icon_url`);
  if (!iconUrl.ok) return iconUrl;
  const description = expectOptionalString(value.description, `${param}.description`);
  if (!description.ok) return description;
  const estimate = expectOptionalCanonicalAmount(
    value.estimated_avg_charge_nano_usd,
    `${param}.estimated_avg_charge_nano_usd`
  );
  if (!estimate.ok) return estimate;
  return ok({
    ...(iconUrl.value !== undefined ? { icon_url: iconUrl.value } : {}),
    ...(description.value !== undefined ? { description: description.value } : {}),
    ...(estimate.value !== undefined ? { estimated_avg_charge_nano_usd: estimate.value } : {})
  });
}

/**
 * `POST /v1/dashboard/business/applications`, its `PATCH`, and
 * `GET /v1/dashboard/business/applications/{application_id}` all return
 * this one shape.
 *
 * `redirect_uris` and `allowed_origins` are read back from the Better Auth
 * OAuth client row the business's application actually authorizes against
 * (see `apps/backend/src/frontend/dashboard.ts`'s `buildBusinessApplicationDetail()`),
 * not a second copy that could drift from it.
 */
export interface BusinessApplicationDetail {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly environment: Readable<"test" | "live">;
  readonly status: Readable<"active" | "suspended" | "closed">;
  /** The application's premium switch (owner decision 2026-10-25). */
  readonly premium_enabled: boolean;
  readonly info: BusinessApplicationInfo | null;
  readonly redirect_uris: readonly string[];
  readonly allowed_origins: readonly string[];
  readonly created_at: string;
  readonly analytics: BusinessApplicationAnalytics;
  readonly api_keys: readonly ApiKeyMetadata[];
}

export function validateBusinessApplicationDetail(
  value: unknown,
  options?: ParseOptions
): Result<BusinessApplicationDetail> {
  return withResponseOptions(value, options, () => validateBusinessApplicationDetailShape(value));
}

function validateBusinessApplicationDetailShape(value: unknown): Result<BusinessApplicationDetail> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const id = expectString(value.id, "id");
  if (!id.ok) return id;
  const clientId = expectString(value.client_id, "client_id");
  if (!clientId.ok) return clientId;
  const name = expectString(value.name, "name");
  if (!name.ok) return name;
  const environment = expectLiteral(value.environment, APPLICATION_ENVIRONMENTS, "environment");
  if (!environment.ok) return environment;
  const status = expectLiteral(value.status, APPLICATION_STATUSES, "status");
  if (!status.ok) return status;
  const premiumEnabled = expectBoolean(value.premium_enabled, "premium_enabled");
  if (!premiumEnabled.ok) return premiumEnabled;
  const info = validateBusinessApplicationInfoShape(value.info, "info");
  if (!info.ok) return info;
  const redirectUris = validateUniqueStringList(
    value.redirect_uris,
    "redirect_uris",
    validateRedirectUri
  );
  if (!redirectUris.ok) return redirectUris;
  const allowedOrigins = validateUniqueStringList(
    value.allowed_origins,
    "allowed_origins",
    validateAllowedOrigin
  );
  if (!allowedOrigins.ok) return allowedOrigins;
  const createdAt = expectRfc3339(value.created_at, "created_at");
  if (!createdAt.ok) return createdAt;
  const analytics = validateBusinessApplicationAnalytics(value.analytics);
  if (!analytics.ok) return analytics;
  const apiKeys = validateApiKeyMetadataArray(value.api_keys, "api_keys");
  if (!apiKeys.ok) return apiKeys;
  return ok({
    id: id.value,
    client_id: clientId.value,
    name: name.value,
    environment: environment.value,
    status: status.value,
    premium_enabled: premiumEnabled.value,
    info: info.value,
    redirect_uris: redirectUris.value,
    allowed_origins: allowedOrigins.value,
    created_at: createdAt.value,
    analytics: analytics.value,
    api_keys: apiKeys.value
  });
}

/**
 * `PUT /v1/dashboard/business/applications/{application_id}/premium`'s request
 * body (owner decision 2026-10-25): exactly `{ enabled: boolean }`. Any other
 * field, or a non-boolean `enabled`, is `invalid_value`.
 */
export interface BusinessApplicationPremiumRequest {
  readonly enabled: boolean;
}

export function validateBusinessApplicationPremiumRequest(
  value: unknown
): Result<BusinessApplicationPremiumRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "enabled") return invalidValue(key, "is not accepted");
  }
  const enabled = expectBoolean(value.enabled, "enabled");
  if (!enabled.ok) return enabled;
  return ok({ enabled: enabled.value });
}

/** `POST /v1/dashboard/business/keys`'s request body. */
export interface CreateBusinessKeyRequest {
  readonly scope: "model" | "reporting";
  readonly name: string;
  readonly application_id?: string;
  readonly expires_at?: string;
}

export function validateCreateBusinessKeyRequest(value: unknown): Result<CreateBusinessKeyRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["scope", "name", "application_id", "expires_at"]);
  if (!rejected.ok) return rejected;
  const scope = expectLiteral(value.scope, API_KEY_SCOPES, "scope");
  if (!scope.ok) return scope;
  const name = expectString(value.name, "name");
  if (!name.ok) return name;
  const applicationId = expectOptionalString(value.application_id, "application_id");
  if (!applicationId.ok) return applicationId;
  const expiresAt = expectOptionalRfc3339(value.expires_at, "expires_at");
  if (!expiresAt.ok) return expiresAt;

  if (scope.value === "model" && applicationId.value === undefined) {
    return invalidValue("application_id", 'is required when scope is "model"');
  }
  if (scope.value === "reporting" && applicationId.value !== undefined) {
    return unsupportedParameter("application_id", 'must not be present when scope is "reporting"');
  }

  return ok({
    scope: scope.value,
    name: name.value,
    ...(applicationId.value !== undefined ? { application_id: applicationId.value } : {}),
    ...(expiresAt.value !== undefined ? { expires_at: expiresAt.value } : {})
  });
}

/** The shared shape of `POST /v1/dashboard/business/keys` and its `.../rotate` response. */
export interface CreateBusinessKeyResponse {
  readonly metadata: ApiKeyMetadata;
  readonly secret: string;
}

export function validateCreateBusinessKeyResponse(
  value: unknown,
  options?: ParseOptions
): Result<CreateBusinessKeyResponse> {
  return withResponseOptions(value, options, () => validateCreateBusinessKeyResponseShape(value));
}

function validateCreateBusinessKeyResponseShape(
  value: unknown
): Result<CreateBusinessKeyResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const metadata = validateApiKeyMetadata(value.metadata, "metadata");
  if (!metadata.ok) return metadata;
  const secret = expectString(value.secret, "secret");
  if (!secret.ok) return secret;
  return ok({ metadata: metadata.value, secret: secret.value });
}

/** `POST /v1/dashboard/business/payouts`'s request body. */
export function validateCreateBusinessPayoutRequest(
  value: unknown
): Result<{ readonly amount_nano_usd: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["amount_nano_usd"]);
  if (!rejected.ok) return rejected;
  const amount = expectPositiveCanonicalAmount(value.amount_nano_usd, "amount_nano_usd");
  if (!amount.ok) return amount;
  return ok({ amount_nano_usd: amount.value });
}

/** `POST /v1/dashboard/business/payout-account/onboarding`'s response. */
export interface BusinessPayoutAccountOnboardingResponse {
  readonly url: string;
  readonly expires_at: string;
}

export function validateBusinessPayoutAccountOnboardingResponse(
  value: unknown,
  options?: ParseOptions
): Result<BusinessPayoutAccountOnboardingResponse> {
  return withResponseOptions(value, options, () => validateBusinessPayoutAccountOnboardingResponseShape(value));
}

function validateBusinessPayoutAccountOnboardingResponseShape(
  value: unknown
): Result<BusinessPayoutAccountOnboardingResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const url = expectString(value.url, "url");
  if (!url.ok) return url;
  const expiresAt = expectRfc3339(value.expires_at, "expires_at");
  if (!expiresAt.ok) return expiresAt;
  return ok({ url: url.value, expires_at: expiresAt.value });
}

/**
 * `POST /v1/dashboard/personal/payment-method/setup` and
 * `POST /v1/dashboard/business/payout-account/onboarding` both "take no
 * body"; a request carrying one is rejected rather than silently ignored.
 */
export function validateEmptyRequestBody(value: unknown): Result<Record<string, never>> {
  if (value === undefined) return ok({});
  if (!isPlainObject(value)) return invalidValue("body", "must be empty");
  const keys = Object.keys(value);
  if (keys.length > 0) {
    return unsupportedParameter(
      keys[0]!,
      `"${keys[0]}" is not accepted by this route, which takes no body`
    );
  }
  return ok({});
}

// ---------------------------------------------------------------------------
// Business access, members, invitations, contacts, and presentation
// ---------------------------------------------------------------------------

function expectAssignableBusinessRole(value: unknown, param: string): Result<AssignableBusinessRole> {
  const role = expectLiteral(value, BUSINESS_ROLE_NAMES, param);
  if (!role.ok) return role;
  if (role.value === "owner") return invalidValue(param, 'must not be "owner"');
  return ok(role.value);
}

function validateBusinessPermissions(value: unknown, param: string): Result<readonly Readable<BusinessPermission>[]> {
  if (!Array.isArray(value)) return invalidValue(param, "must be an array");
  const permissions: Readable<BusinessPermission>[] = [];
  let previousKnownPermissionIndex = -1;
  for (const [index, item] of value.entries()) {
    const permission = expectLiteral(item, BUSINESS_PERMISSIONS, `${param}[${index}]`);
    if (!permission.ok) return permission;
    const permissionIndex = BUSINESS_PERMISSIONS.indexOf(permission.value);
    if (permissionIndex !== -1) {
      if (permissionIndex <= previousKnownPermissionIndex) {
        return invalidValue(param, "must contain declared permissions at most once and in declared order");
      }
      previousKnownPermissionIndex = permissionIndex;
    }
    permissions.push(permission.value);
  }
  return ok(permissions);
}

export interface BusinessAccessActiveBusiness {
  readonly id: string;
  readonly name: string;
  /** RFC3339 creation time; the Overview "All" range starts at its UTC midnight. */
  readonly created_at: string;
  readonly role: Readable<BusinessRole>;
  readonly permissions: readonly Readable<BusinessPermission>[];
}

export interface BusinessAccessBusiness {
  readonly id: string;
  readonly name: string;
  readonly role: Readable<BusinessRole>;
  readonly status: Readable<"active" | "suspended" | "closed">;
}

export interface PendingBusinessInvitation {
  readonly id: string;
  readonly business_id: string;
  readonly business_name: string;
  readonly role: Readable<AssignableBusinessRole>;
  readonly invited_by_email: string | null;
  readonly expires_at: string;
}

export interface BusinessAccess {
  readonly login: { readonly email: string };
  readonly owns_business: boolean;
  readonly active_business: BusinessAccessActiveBusiness | null;
  readonly businesses: readonly BusinessAccessBusiness[];
  readonly pending_invitations: readonly PendingBusinessInvitation[];
}

function validateBusinessAccessActiveBusiness(value: unknown): Result<BusinessAccessActiveBusiness> {
  if (!isPlainObject(value)) return invalidValue("active_business", "must be an object");
  const id = expectString(value.id, "active_business.id");
  if (!id.ok) return id;
  const name = expectString(value.name, "active_business.name");
  if (!name.ok) return name;
  const createdAt = expectRfc3339(value.created_at, "active_business.created_at");
  if (!createdAt.ok) return createdAt;
  const role = expectLiteral(value.role, BUSINESS_ROLE_NAMES, "active_business.role");
  if (!role.ok) return role;
  const permissions = validateBusinessPermissions(value.permissions, "active_business.permissions");
  if (!permissions.ok) return permissions;
  return ok({ id: id.value, name: name.value, created_at: createdAt.value, role: role.value, permissions: permissions.value });
}

function validateBusinessAccessBusiness(value: unknown, param: string): Result<BusinessAccessBusiness> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const name = expectString(value.name, `${param}.name`);
  if (!name.ok) return name;
  const role = expectLiteral(value.role, BUSINESS_ROLE_NAMES, `${param}.role`);
  if (!role.ok) return role;
  const status = expectLiteral(value.status, APPLICATION_STATUSES, `${param}.status`);
  if (!status.ok) return status;
  return ok({ id: id.value, name: name.value, role: role.value, status: status.value });
}

function validatePendingBusinessInvitation(value: unknown, param: string): Result<PendingBusinessInvitation> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const businessId = expectString(value.business_id, `${param}.business_id`);
  if (!businessId.ok) return businessId;
  const businessName = expectString(value.business_name, `${param}.business_name`);
  if (!businessName.ok) return businessName;
  const role = expectLiteral(value.role, BUSINESS_ROLE_NAMES, `${param}.role`);
  if (!role.ok) return role;
  if (role.value === "owner") return invalidValue(`${param}.role`, 'must not be "owner"');
  const invitedBy = expectNullableString(value.invited_by_email, `${param}.invited_by_email`);
  if (!invitedBy.ok) return invitedBy;
  const expiresAt = expectRfc3339(value.expires_at, `${param}.expires_at`);
  if (!expiresAt.ok) return expiresAt;
  return ok({
    id: id.value,
    business_id: businessId.value,
    business_name: businessName.value,
    role: role.value,
    invited_by_email: invitedBy.value,
    expires_at: expiresAt.value
  });
}

export function validateBusinessAccess(value: unknown, options?: ParseOptions): Result<BusinessAccess> {
  return withResponseOptions(value, options, () => validateBusinessAccessShape(value));
}

function validateBusinessAccessShape(value: unknown): Result<BusinessAccess> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!isPlainObject(value.login)) return invalidValue("login", "must be an object");
  const loginEmail = expectString(value.login.email, "login.email");
  if (!loginEmail.ok) return loginEmail;
  const ownsBusiness = expectBoolean(value.owns_business, "owns_business");
  if (!ownsBusiness.ok) return ownsBusiness;
  const active =
    value.active_business === null ? ok(null) : validateBusinessAccessActiveBusiness(value.active_business);
  if (!active.ok) return active;
  if (!Array.isArray(value.businesses)) return invalidValue("businesses", "must be an array");
  const businesses: BusinessAccessBusiness[] = [];
  for (const [index, item] of value.businesses.entries()) {
    const business = validateBusinessAccessBusiness(item, `businesses[${index}]`);
    if (!business.ok) return business;
    businesses.push(business.value);
  }
  if (!Array.isArray(value.pending_invitations)) {
    return invalidValue("pending_invitations", "must be an array");
  }
  const invitations: PendingBusinessInvitation[] = [];
  for (const [index, item] of value.pending_invitations.entries()) {
    const invitation = validatePendingBusinessInvitation(item, `pending_invitations[${index}]`);
    if (!invitation.ok) return invitation;
    invitations.push(invitation.value);
  }
  return ok({
    login: { email: loginEmail.value },
    owns_business: ownsBusiness.value,
    active_business: active.value,
    businesses,
    pending_invitations: invitations
  });
}

export interface BusinessMember {
  readonly id: string;
  readonly email: string;
  readonly role: Readable<AssignableBusinessRole>;
  readonly joined_at: string;
  readonly is_you: boolean;
}

export interface BusinessMemberInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Readable<AssignableBusinessRole>;
  readonly invited_by_email: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface BusinessMemberList {
  readonly owner: { readonly email: string; readonly is_you: boolean };
  readonly members: readonly BusinessMember[];
  readonly invitations: readonly BusinessMemberInvitation[];
}

function validateBusinessMember(value: unknown, param: string): Result<BusinessMember> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const email = expectString(value.email, `${param}.email`);
  if (!email.ok) return email;
  const role = expectAssignableBusinessRole(value.role, `${param}.role`);
  if (!role.ok) return role;
  const joinedAt = expectRfc3339(value.joined_at, `${param}.joined_at`);
  if (!joinedAt.ok) return joinedAt;
  const isYou = expectBoolean(value.is_you, `${param}.is_you`);
  if (!isYou.ok) return isYou;
  return ok({ id: id.value, email: email.value, role: role.value, joined_at: joinedAt.value, is_you: isYou.value });
}

function validateBusinessMemberInvitation(
  value: unknown,
  param: string
): Result<BusinessMemberInvitation> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const email = expectString(value.email, `${param}.email`);
  if (!email.ok) return email;
  const role = expectAssignableBusinessRole(value.role, `${param}.role`);
  if (!role.ok) return role;
  const invitedBy = expectNullableString(value.invited_by_email, `${param}.invited_by_email`);
  if (!invitedBy.ok) return invitedBy;
  const createdAt = expectRfc3339(value.created_at, `${param}.created_at`);
  if (!createdAt.ok) return createdAt;
  const expiresAt = expectRfc3339(value.expires_at, `${param}.expires_at`);
  if (!expiresAt.ok) return expiresAt;
  return ok({
    id: id.value,
    email: email.value,
    role: role.value,
    invited_by_email: invitedBy.value,
    created_at: createdAt.value,
    expires_at: expiresAt.value
  });
}

export function validateBusinessMemberList(
  value: unknown,
  options?: ParseOptions
): Result<BusinessMemberList> {
  return withResponseOptions(value, options, () => validateBusinessMemberListShape(value));
}

function validateBusinessMemberListShape(value: unknown): Result<BusinessMemberList> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  if (!isPlainObject(value.owner)) return invalidValue("owner", "must be an object");
  const ownerEmail = expectString(value.owner.email, "owner.email");
  if (!ownerEmail.ok) return ownerEmail;
  const ownerIsYou = expectBoolean(value.owner.is_you, "owner.is_you");
  if (!ownerIsYou.ok) return ownerIsYou;
  if (!Array.isArray(value.members)) return invalidValue("members", "must be an array");
  const members: BusinessMember[] = [];
  for (const [index, item] of value.members.entries()) {
    const member = validateBusinessMember(item, `members[${index}]`);
    if (!member.ok) return member;
    members.push(member.value);
  }
  if (!Array.isArray(value.invitations)) return invalidValue("invitations", "must be an array");
  const invitations: BusinessMemberInvitation[] = [];
  for (const [index, item] of value.invitations.entries()) {
    const invitation = validateBusinessMemberInvitation(item, `invitations[${index}]`);
    if (!invitation.ok) return invitation;
    invitations.push(invitation.value);
  }
  return ok({ owner: { email: ownerEmail.value, is_you: ownerIsYou.value }, members, invitations });
}

export interface BusinessInvitationResult {
  readonly invitation: BusinessMemberInvitation;
  readonly email_delivery: Readable<"sent" | "failed">;
}

export function validateBusinessInvitationResult(
  value: unknown,
  options?: ParseOptions
): Result<BusinessInvitationResult> {
  return withResponseOptions(value, options, () => validateBusinessInvitationResultShape(value));
}

function validateBusinessInvitationResultShape(value: unknown): Result<BusinessInvitationResult> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const invitation = validateBusinessMemberInvitation(value.invitation, "invitation");
  if (!invitation.ok) return invitation;
  const delivery = expectLiteral(value.email_delivery, ["sent", "failed"] as const, "email_delivery");
  if (!delivery.ok) return delivery;
  return ok({ invitation: invitation.value, email_delivery: delivery.value });
}

/** `POST /v1/dashboard/business/access/businesses` request. */
export function validateCreateBusinessRequest(value: unknown): Result<{ readonly name: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["name"]);
  if (!unknown.ok) return unknown;
  const name = expectString(value.name, "name");
  if (!name.ok) return name;
  const trimmed = name.value.trim();
  const characters = Array.from(trimmed);
  if (
    characters.length === 0 ||
    characters.length > 100 ||
    characters.some((character) => character <= "\u001f" || character === "\u007f")
  ) {
    return invalidValue("name", "must be 1–100 trimmed characters with no control character");
  }
  return ok({ name: trimmed });
}

/** `PUT /v1/dashboard/business/access/active` request. */
export function validateSelectActiveBusinessRequest(
  value: unknown
): Result<{ readonly business_id: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["business_id"]);
  if (!unknown.ok) return unknown;
  const businessId = expectString(value.business_id, "business_id");
  if (!businessId.ok) return businessId;
  return ok({ business_id: businessId.value });
}

export function validateBusinessInvitationRequest(
  value: unknown
): Result<{ readonly email: string; readonly role: AssignableBusinessRole }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["email", "role"]);
  if (!unknown.ok) return unknown;
  const email = expectEmailAddress(value.email, "email");
  if (!email.ok) return email;
  const role = expectAssignableBusinessRole(value.role, "role");
  if (!role.ok) return role;
  return ok({ email: email.value, role: role.value });
}

export function validateChangeBusinessMemberRoleRequest(
  value: unknown
): Result<{ readonly role: AssignableBusinessRole }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["role"]);
  if (!unknown.ok) return unknown;
  const role = expectAssignableBusinessRole(value.role, "role");
  if (!role.ok) return role;
  return ok({ role: role.value });
}

export function validateTransferBusinessOwnershipRequest(
  value: unknown
): Result<{ readonly member_id: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["member_id"]);
  if (!unknown.ok) return unknown;
  const memberId = expectString(value.member_id, "member_id");
  if (!memberId.ok) return memberId;
  return ok({ member_id: memberId.value });
}

/** `POST /v1/dashboard/business/access/email`'s request body (sign-in email change start). */
export function validateStartBusinessLoginEmailChangeRequest(
  value: unknown
): Result<{ readonly email: string; readonly turnstile_token: unknown }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["email", "turnstile_token"]);
  if (!unknown.ok) return unknown;
  const email = expectEmailAddress(value.email, "email");
  if (!email.ok) return email;
  return ok({ email: email.value, turnstile_token: readTurnstileToken(value) });
}

/** The `202` body of the sign-in email change start. */
export interface BusinessLoginEmailChallenge {
  readonly challenge_id: string;
  readonly resend_after_seconds: number;
}

export function validateBusinessLoginEmailChallenge(
  value: unknown,
  options?: ParseOptions
): Result<BusinessLoginEmailChallenge> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    const challengeId = expectString(value.challenge_id, "challenge_id");
    if (!challengeId.ok) return challengeId;
    const resendAfter = expectNonNegativeInteger(value.resend_after_seconds, "resend_after_seconds");
    if (!resendAfter.ok) return resendAfter;
    return ok({ challenge_id: challengeId.value, resend_after_seconds: resendAfter.value });
  });
}

/** `POST /v1/dashboard/business/access/email/verify` takes the personal contact verify body. */
export function validateVerifyBusinessLoginEmailChangeRequest(
  value: unknown
): Result<{ readonly challenge_id: string; readonly code: string }> {
  return validateVerifyContactRequest(value);
}

// ---------------------------------------------------------------------------
// Email sign-in (`specs/PROTOCOLS.md` "Email sign-in")
// ---------------------------------------------------------------------------

/** The two account types a visitor may sign in to, chosen on the login page. */
export const EMAIL_SIGN_IN_ACCOUNT_TYPES = ["user", "business"] as const;
export type EmailSignInAccountType = (typeof EMAIL_SIGN_IN_ACCOUNT_TYPES)[number];

/** The longest address either route accepts (the SMTP path limit). */
export const EMAIL_SIGN_IN_MAX_EMAIL_LENGTH = 254;

/**
 * A syntactic address check, not a deliverability one: exactly one `@`, a
 * non-empty local part, and a dotted domain, with no whitespace or characters
 * that would need quoting. The backend normalizes the accepted value further;
 * this only refuses what can never be an address.
 */
const EMAIL_SYNTAX = /^[^\s@,;<>"\\]+@[^\s@,;<>"\\.]+(\.[^\s@,;<>"\\.]+)+$/;

/** Exactly six ASCII digits; a leading zero is part of the code. */
const SIGN_IN_CODE_SYNTAX = /^[0-9]{6}$/;

function expectEmailAddress(value: unknown, param: string): Result<string> {
  const text = expectString(value, param);
  if (!text.ok) return text;
  if (text.value.length > EMAIL_SIGN_IN_MAX_EMAIL_LENGTH) {
    return invalidValue(param, `must be at most ${EMAIL_SIGN_IN_MAX_EMAIL_LENGTH} characters`);
  }
  if (!EMAIL_SYNTAX.test(text.value)) {
    return invalidValue(param, "must be an email address");
  }
  return text;
}

export interface EmailSignInSendRequest {
  readonly email: string;
  readonly account_type: EmailSignInAccountType;
  readonly turnstile_token: unknown;
}

/** `POST /auth/email-code/send`'s request body. */
export function validateEmailSignInSendRequest(value: unknown): Result<EmailSignInSendRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["email", "account_type", "turnstile_token"]);
  if (!rejected.ok) return rejected;
  const email = expectEmailAddress(value.email, "email");
  if (!email.ok) return email;
  const accountType = expectLiteral(
    value.account_type,
    EMAIL_SIGN_IN_ACCOUNT_TYPES,
    "account_type"
  );
  if (!accountType.ok) return accountType;
  return ok({
    email: email.value,
    account_type: accountType.value,
    turnstile_token: readTurnstileToken(value)
  });
}

/**
 * `POST /auth/email-code/verify`'s request body.
 *
 * It deliberately does **not** extend `EmailSignInSendRequest`, even though it
 * carries the same address and account type: the send request also carries a
 * `turnstile_token`, and a verify route takes none. Turnstile guards the routes
 * that send a code; a verify route sends nothing, and guessing against it is
 * bounded by the per-code attempt limit instead. Inheriting the token field
 * would make a client send one here and a server accept one it never checks.
 */
export interface EmailSignInVerifyRequest {
  readonly email: string;
  readonly account_type: EmailSignInAccountType;
  readonly code: string;
}

/** `POST /auth/email-code/verify`'s request body. */
export function validateEmailSignInVerifyRequest(value: unknown): Result<EmailSignInVerifyRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["email", "account_type", "code"]);
  if (!rejected.ok) return rejected;
  const email = expectEmailAddress(value.email, "email");
  if (!email.ok) return email;
  const accountType = expectLiteral(
    value.account_type,
    EMAIL_SIGN_IN_ACCOUNT_TYPES,
    "account_type"
  );
  if (!accountType.ok) return accountType;
  const code = expectString(value.code, "code");
  if (!code.ok) return code;
  if (!SIGN_IN_CODE_SYNTAX.test(code.value)) {
    return invalidValue("code", "must be exactly six digits");
  }
  return ok({ email: email.value, account_type: accountType.value, code: code.value });
}

/**
 * `POST /auth/email-code/send`'s `202` body. It is identical for every address,
 * so it carries nothing about the address or its account.
 */
export interface EmailSignInSent {
  readonly status: Readable<"sent">;
  readonly resend_after_seconds: number;
}

export function validateEmailSignInSent(value: unknown, options?: ParseOptions): Result<EmailSignInSent> {
  return withResponseOptions(value, options, () => validateEmailSignInSentShape(value));
}

function validateEmailSignInSentShape(value: unknown): Result<EmailSignInSent> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const status = expectLiteral(value.status, ["sent"] as const, "status");
  if (!status.ok) return status;
  const resendAfter = expectNonNegativeInteger(value.resend_after_seconds, "resend_after_seconds");
  if (!resendAfter.ok) return resendAfter;
  return ok({ status: status.value, resend_after_seconds: resendAfter.value });
}

/**
 * `POST /auth/email-code/verify`'s `200` body. It carries no principal ID,
 * session token, or email: the session travels only in the cookie.
 */
export interface EmailSignInCompleted {
  readonly status: Readable<"signed_in">;
  readonly account_type: Readable<EmailSignInAccountType>;
  readonly registered: boolean;
  readonly phone_verification_required: boolean;
}

export function validateEmailSignInCompleted(
  value: unknown,
  options?: ParseOptions
): Result<EmailSignInCompleted> {
  return withResponseOptions(value, options, () => validateEmailSignInCompletedShape(value));
}

function validateEmailSignInCompletedShape(value: unknown): Result<EmailSignInCompleted> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const status = expectLiteral(value.status, ["signed_in"] as const, "status");
  if (!status.ok) return status;
  const accountType = expectLiteral(
    value.account_type,
    EMAIL_SIGN_IN_ACCOUNT_TYPES,
    "account_type"
  );
  if (!accountType.ok) return accountType;
  const registered = expectBoolean(value.registered, "registered");
  if (!registered.ok) return registered;
  const phoneRequired = expectBoolean(
    value.phone_verification_required,
    "phone_verification_required"
  );
  if (!phoneRequired.ok) return phoneRequired;
  return ok({
    status: status.value,
    account_type: accountType.value,
    registered: registered.value,
    phone_verification_required: phoneRequired.value
  });
}

// ---------------------------------------------------------------------------
// Phone verification (`specs/PROTOCOLS.md` "Phone verification")
// ---------------------------------------------------------------------------

/**
 * The longest `phone_number` either phone route accepts. The bound is a
 * request-size guard, not a formatting rule: whether a number is valid, in an
 * allowed region, and of a type that can receive an SMS is decided server-side
 * against the deployed region list, which the wire contract does not know.
 */
export const PHONE_NUMBER_MAX_LENGTH = 32;

/** Exactly six ASCII digits; a leading zero is part of the code. */
const PHONE_CODE_SYNTAX = /^[0-9]{6}$/;

function expectPhoneNumber(value: unknown, param: string): Result<string> {
  const text = expectString(value, param);
  if (!text.ok) return text;
  if (text.value.length > PHONE_NUMBER_MAX_LENGTH) {
    return invalidValue(param, `must be at most ${PHONE_NUMBER_MAX_LENGTH} characters`);
  }
  return text;
}

export interface PhoneVerificationSendRequest {
  readonly phone_number: string;
  readonly turnstile_token: unknown;
}

/** `POST /auth/phone/send`'s request body. */
export function validatePhoneVerificationSendRequest(
  value: unknown
): Result<PhoneVerificationSendRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["phone_number", "turnstile_token"]);
  if (!rejected.ok) return rejected;
  const phoneNumber = expectPhoneNumber(value.phone_number, "phone_number");
  if (!phoneNumber.ok) return phoneNumber;
  return ok({
    phone_number: phoneNumber.value,
    turnstile_token: readTurnstileToken(value)
  });
}

export interface PhoneVerificationVerifyRequest {
  readonly phone_number: string;
  readonly code: string;
}

/**
 * `POST /auth/phone/verify`'s request body. It takes no Turnstile token: the
 * route sends nothing, and guessing is bounded by the per-code attempt limit.
 */
export function validatePhoneVerificationVerifyRequest(
  value: unknown
): Result<PhoneVerificationVerifyRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const rejected = rejectUnknownKeys(value, ["phone_number", "code"]);
  if (!rejected.ok) return rejected;
  const phoneNumber = expectPhoneNumber(value.phone_number, "phone_number");
  if (!phoneNumber.ok) return phoneNumber;
  const code = expectString(value.code, "code");
  if (!code.ok) return code;
  if (!PHONE_CODE_SYNTAX.test(code.value)) {
    return invalidValue("code", "must be exactly six digits");
  }
  return ok({ phone_number: phoneNumber.value, code: code.value });
}

/**
 * `POST /auth/phone/send`'s `202` body. It is identical for every number, so
 * it carries nothing about the number, its holder, or whether one exists.
 */
export interface PhoneVerificationSent {
  readonly status: Readable<"sent">;
  readonly resend_after_seconds: number;
}

export function validatePhoneVerificationSent(
  value: unknown,
  options?: ParseOptions
): Result<PhoneVerificationSent> {
  return withResponseOptions(value, options, () => validatePhoneVerificationSentShape(value));
}

function validatePhoneVerificationSentShape(value: unknown): Result<PhoneVerificationSent> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const status = expectLiteral(value.status, ["sent"] as const, "status");
  if (!status.ok) return status;
  const resendAfter = expectNonNegativeInteger(value.resend_after_seconds, "resend_after_seconds");
  if (!resendAfter.ok) return resendAfter;
  return ok({ status: status.value, resend_after_seconds: resendAfter.value });
}

/**
 * `POST /auth/phone/verify`'s `200` body. `registered` tells the login page
 * whether this request created the personal account, which is the only moment
 * a personal principal comes into existence.
 */
export interface PhoneVerificationCompleted {
  readonly status: Readable<"verified">;
  readonly registered: boolean;
}

export function validatePhoneVerificationCompleted(
  value: unknown,
  options?: ParseOptions
): Result<PhoneVerificationCompleted> {
  return withResponseOptions(value, options, () =>
    validatePhoneVerificationCompletedShape(value)
  );
}

function validatePhoneVerificationCompletedShape(
  value: unknown
): Result<PhoneVerificationCompleted> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const status = expectLiteral(value.status, ["verified"] as const, "status");
  if (!status.ok) return status;
  const registered = expectBoolean(value.registered, "registered");
  if (!registered.ok) return registered;
  return ok({ status: status.value, registered: registered.value });
}

/** `POST /v1/dashboard/personal/gift-codes/redeem` returns the confirmed personal dashboard body. */
export function validateRedeemGiftCodeResponse(value: unknown, options?: ParseOptions): Result<PersonalDashboard> {
  return validatePersonalDashboard(value, options);
}

// ---------------------------------------------------------------------------
// CLI authorization (`specs/PROTOCOLS.md` "CLI authorization")
//
// The business CLI `@enlitt/cli` signs in by browser-approved device
// authorization (RFC 8628 shape). These are the request and response shapes
// of the three `/v1/cli/*` routes and of the browser routes that approve,
// deny, list, and revoke CLI credentials. The backend validates what it
// accepts and returns from them; the CLI and the dashboard validate what they
// receive from the same declarations.
// ---------------------------------------------------------------------------

/** The two kinds of CLI authorization: a fresh sign-in, or a recency renewal for an existing credential. */
export const CLI_AUTHORIZATION_KINDS = ["login", "step_up"] as const;
export type CliAuthorizationKind = (typeof CLI_AUTHORIZATION_KINDS)[number];

/** The longest device label, counted in characters after trimming. */
export const CLI_DEVICE_LABEL_MAX_LENGTH = 64;

/**
 * The user-code alphabet: consonants only, so no code spells a word and no two
 * characters are easily confused (no vowels, no `0/O`, no `1/I/L` pairs).
 */
export const CLI_USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** Eight characters of the alphabet, displayed as `XXXX-XXXX`. */
const CLI_USER_CODE_LENGTH = 8;

/**
 * Normalizes a user code as typed or pasted by a person: case-insensitive,
 * with or without the hyphen, ignoring surrounding and inner spaces. Returns
 * the canonical `XXXX-XXXX` form, or null when the value can never be a code.
 * The backend and the `/cli/authorize` page both use this, so a code that one
 * accepts the other accepts too.
 */
export function normalizeCliUserCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== CLI_USER_CODE_LENGTH) return null;
  for (const character of compact) {
    if (!CLI_USER_CODE_ALPHABET.includes(character)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function expectCliUserCode(value: unknown, param: string): Result<string> {
  if (typeof value !== "string" || normalizeCliUserCode(value) !== value) {
    return invalidValue(param, "must be a XXXX-XXXX CLI user code");
  }
  return ok(value);
}

function expectBusinessReference(
  value: unknown,
  param: string
): Result<{ readonly id: string; readonly name: string }> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const name = expectString(value.name, `${param}.name`);
  if (!name.ok) return name;
  return ok({ id: id.value, name: name.value });
}

/** `POST /v1/cli/authorizations` request. */
export interface StartCliAuthorizationRequest {
  readonly kind: CliAuthorizationKind;
  readonly device_label: string;
}

/**
 * Validates the start request. `device_label` is trimmed and must be 1 to
 * `CLI_DEVICE_LABEL_MAX_LENGTH` characters with no control character, the same
 * rule Account applies, so the CLI can refuse a bad label before sending it.
 */
export function validateStartCliAuthorizationRequest(
  value: unknown
): Result<StartCliAuthorizationRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["kind", "device_label"]);
  if (!unknown.ok) return unknown;
  const kind = expectLiteral(value.kind, CLI_AUTHORIZATION_KINDS, "kind");
  if (!kind.ok) return kind;
  const label = expectString(value.device_label, "device_label");
  if (!label.ok) return label;
  const trimmed = label.value.trim();
  const characters = Array.from(trimmed);
  if (
    characters.length === 0 ||
    characters.length > CLI_DEVICE_LABEL_MAX_LENGTH ||
    characters.some((character) => character <= "\u001f" || character === "\u007f")
  ) {
    return invalidValue(
      "device_label",
      `must be 1–${CLI_DEVICE_LABEL_MAX_LENGTH} trimmed characters with no control character`
    );
  }
  return ok({ kind: kind.value, device_label: trimmed });
}

/** `POST /v1/cli/authorizations` `201` body. `device_code` is a secret the CLI never prints. */
export interface StartedCliAuthorization {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

export function validateStartedCliAuthorization(
  value: unknown,
  options?: ParseOptions
): Result<StartedCliAuthorization> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    const deviceCode = expectString(value.device_code, "device_code");
    if (!deviceCode.ok) return deviceCode;
    if (deviceCode.value.length === 0) return invalidValue("device_code", "must not be empty");
    const userCode = expectCliUserCode(value.user_code, "user_code");
    if (!userCode.ok) return userCode;
    const uri = expectString(value.verification_uri, "verification_uri");
    if (!uri.ok) return uri;
    const complete = expectString(value.verification_uri_complete, "verification_uri_complete");
    if (!complete.ok) return complete;
    const expiresIn = expectNonNegativeInteger(value.expires_in, "expires_in");
    if (!expiresIn.ok) return expiresIn;
    const interval = expectNonNegativeInteger(value.interval, "interval");
    if (!interval.ok) return interval;
    return ok({
      device_code: deviceCode.value,
      user_code: userCode.value,
      verification_uri: uri.value,
      verification_uri_complete: complete.value,
      expires_in: expiresIn.value,
      interval: interval.value
    });
  });
}

/** `POST /v1/cli/token` request. */
export function validateCliTokenRequest(value: unknown): Result<{ readonly device_code: string }> {
  if (!isPlainObject(value)) return invalidValue("body", "must be an object");
  const unknown = rejectUnknownKeys(value, ["device_code"]);
  if (!unknown.ok) return unknown;
  const deviceCode = expectString(value.device_code, "device_code");
  if (!deviceCode.ok) return deviceCode;
  if (deviceCode.value.length === 0 || deviceCode.value.length > 256) {
    return invalidValue("device_code", "must be 1–256 characters");
  }
  return ok({ device_code: deviceCode.value });
}

/** A `login` grant: the one response that ever carries a CLI token. */
export interface CliLoginGrant {
  readonly kind: "login";
  readonly token: string;
  readonly token_expires_at: string;
  readonly credential_id: string;
  readonly business: { readonly id: string; readonly name: string };
  readonly login: { readonly email: string };
}

/** A `step_up` grant: the credential's recency was renewed; no new token. */
export interface CliStepUpGrant {
  readonly kind: "step_up";
  readonly reauthenticated_at: string;
}

/** `POST /v1/cli/token` `200` body. */
export type CliTokenGrant = CliLoginGrant | CliStepUpGrant;

/**
 * Validates a token grant. `kind` is the discriminant, so an unknown kind is
 * refused even in tolerant mode: a client cannot act on a grant it cannot
 * classify, and reading it as `"other"` would lose the token silently.
 */
export function validateCliTokenGrant(value: unknown, options?: ParseOptions): Result<CliTokenGrant> {
  return withResponseOptions<CliTokenGrant>(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    if (value.kind === "step_up") {
      const at = expectRfc3339(value.reauthenticated_at, "reauthenticated_at");
      if (!at.ok) return at;
      return ok({ kind: "step_up" as const, reauthenticated_at: at.value });
    }
    if (value.kind !== "login") return invalidValue("kind", "must be one of: login, step_up");
    const token = expectString(value.token, "token");
    if (!token.ok) return token;
    if (token.value.length === 0) return invalidValue("token", "must not be empty");
    const expiresAt = expectRfc3339(value.token_expires_at, "token_expires_at");
    if (!expiresAt.ok) return expiresAt;
    const credentialId = expectString(value.credential_id, "credential_id");
    if (!credentialId.ok) return credentialId;
    const business = expectBusinessReference(value.business, "business");
    if (!business.ok) return business;
    if (!isPlainObject(value.login)) return invalidValue("login", "must be an object");
    const email = expectString(value.login.email, "login.email");
    if (!email.ok) return email;
    return ok({
      kind: "login" as const,
      token: token.value,
      token_expires_at: expiresAt.value,
      credential_id: credentialId.value,
      business: business.value,
      login: { email: email.value }
    });
  });
}

/** `GET /v1/dashboard/business/access/cli-authorizations/{user_code}` body. */
export interface CliAuthorizationView {
  readonly user_code: string;
  readonly kind: Readable<CliAuthorizationKind>;
  readonly device_label: string;
  readonly expires_at: string;
  readonly business: { readonly id: string; readonly name: string } | null;
}

export function validateCliAuthorizationView(
  value: unknown,
  options?: ParseOptions
): Result<CliAuthorizationView> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    const userCode = expectCliUserCode(value.user_code, "user_code");
    if (!userCode.ok) return userCode;
    const kind = expectLiteral(value.kind, CLI_AUTHORIZATION_KINDS, "kind");
    if (!kind.ok) return kind;
    const label = expectString(value.device_label, "device_label");
    if (!label.ok) return label;
    const expiresAt = expectRfc3339(value.expires_at, "expires_at");
    if (!expiresAt.ok) return expiresAt;
    const business =
      value.business === null ? ok(null) : expectBusinessReference(value.business, "business");
    if (!business.ok) return business;
    return ok({
      user_code: userCode.value,
      kind: kind.value,
      device_label: label.value,
      expires_at: expiresAt.value,
      business: business.value
    });
  });
}

/** One entry of `GET /v1/dashboard/business/access/cli-credentials`. Never carries a token. */
export interface CliCredentialSummary {
  readonly id: string;
  readonly device_label: string;
  readonly business: { readonly id: string; readonly name: string };
  readonly approved_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string;
}

/** `GET|DELETE /v1/dashboard/business/access/cli-credentials*` body. */
export interface CliCredentialList {
  readonly credentials: readonly CliCredentialSummary[];
}

function validateCliCredentialSummary(value: unknown, param: string): Result<CliCredentialSummary> {
  if (!isPlainObject(value)) return invalidValue(param, "must be an object");
  // A token must never appear on a credential listing.
  if ("token" in value || "token_hash" in value) {
    return invalidValue(param, "must not carry a token");
  }
  const id = expectString(value.id, `${param}.id`);
  if (!id.ok) return id;
  const label = expectString(value.device_label, `${param}.device_label`);
  if (!label.ok) return label;
  const business = expectBusinessReference(value.business, `${param}.business`);
  if (!business.ok) return business;
  const approvedAt = expectRfc3339(value.approved_at, `${param}.approved_at`);
  if (!approvedAt.ok) return approvedAt;
  const lastUsedAt = expectNullableRfc3339(value.last_used_at, `${param}.last_used_at`);
  if (!lastUsedAt.ok) return lastUsedAt;
  const expiresAt = expectRfc3339(value.expires_at, `${param}.expires_at`);
  if (!expiresAt.ok) return expiresAt;
  return ok({
    id: id.value,
    device_label: label.value,
    business: business.value,
    approved_at: approvedAt.value,
    last_used_at: lastUsedAt.value,
    expires_at: expiresAt.value
  });
}

export function validateCliCredentialList(
  value: unknown,
  options?: ParseOptions
): Result<CliCredentialList> {
  return withResponseOptions(value, options, () => {
    if (!isPlainObject(value)) return invalidValue("body", "must be an object");
    if (!Array.isArray(value.credentials)) return invalidValue("credentials", "must be an array");
    const credentials: CliCredentialSummary[] = [];
    for (const [index, item] of value.credentials.entries()) {
      const credential = validateCliCredentialSummary(item, `credentials[${index}]`);
      if (!credential.ok) return credential;
      credentials.push(credential.value);
    }
    return ok({ credentials });
  });
}

/**
 * `GET /v1/dashboard/business/keys?scope&application_id` query. Both filters
 * are optional. An unknown scope, or `application_id` together with
 * `scope=reporting` (a reporting key belongs to no application), is
 * `invalid_value`. Whether the application belongs to the business is the
 * backend's check, not this one.
 */
export function validateBusinessKeyListQuery(query: {
  readonly scope?: string | null;
  readonly application_id?: string | null;
}): Result<{ readonly scope?: "model" | "reporting"; readonly application_id?: string }> {
  const scopeRaw = query.scope ?? undefined;
  const applicationRaw = query.application_id ?? undefined;
  let scope: "model" | "reporting" | undefined;
  if (scopeRaw !== undefined) {
    if (scopeRaw !== "model" && scopeRaw !== "reporting") {
      return invalidValue("scope", "must be one of: model, reporting");
    }
    scope = scopeRaw;
  }
  if (applicationRaw?.length === 0) {
    return invalidValue("application_id", "must not be empty");
  }
  if (applicationRaw !== undefined && scope === "reporting") {
    return invalidValue("application_id", "must be absent when scope is reporting");
  }
  return ok({
    ...(scope === undefined ? {} : { scope }),
    ...(applicationRaw === undefined ? {} : { application_id: applicationRaw })
  });
}
