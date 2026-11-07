/**
 * The content-free managed-premium wire contracts.
 *
 * These validators deliberately know nothing about admission, a user's
 * capacity, or settlement arithmetic. They validate the only facts a
 * business may send or receive at the two premium endpoints, leaving the
 * captured maximum and the status-specific lowering rule to Finance.
 */

import { isCanonicalIntegerString } from "./canonical-integer.js";
import { ENLITT_ERROR_CODE } from "./errors.js";
import { UNKNOWN_ENUM_VALUE, type ParseOptions, type Readable } from "./compatibility.js";
import {
  validateCallerMetadata,
  type ResponseMetadata,
  type ResponseRequestErrorCode,
  type ResponseValidationResult
} from "./responses.js";

type Result<T> = ResponseValidationResult<T>;

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

function unsupportedValue(param: string, message: string): Result<never> {
  return fail(ENLITT_ERROR_CODE.unsupported_value, param, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value: Record<string, unknown>, param: string, allowed: readonly string[]): Result<void> {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = param === "body" ? key : `${param}.${key}`;
      return unsupportedParameter(field, `"${field}" is not accepted by this surface`);
    }
  }
  return ok(undefined);
}

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

function expectRfc3339(value: unknown, param: string): Result<string> {
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    return invalidValue(param, "must be an RFC 3339 timestamp");
  }
  return ok(value);
}

function expectNonNegativeSafeInteger(value: unknown, param: string): Result<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidValue(param, "must be a nonnegative safe integer");
  }
  return ok(value);
}

function expectCanonicalNanoUsd(value: unknown, param: string, maxDigits?: number): Result<string> {
  if (!isCanonicalIntegerString(value)) {
    return invalidValue(param, "must be a canonical nonnegative NANOUSD integer string");
  }
  if (maxDigits !== undefined && value.length > maxDigits) {
    return invalidValue(param, `must not exceed ${maxDigits} digits`);
  }
  return ok(value);
}

/** The deployed maximum in `FINANCE_POLICY.maxChargeNanoUsd`: $100 in NANOUSD. */
export const PREMIUM_OPERATION_MAX_CHARGE_NANO_USD = "100000000000";

/** The terminal report amount is bounded independently of the current policy. */
export const PREMIUM_TERMINAL_CHARGE_MAX_DIGITS = 30;
export const PREMIUM_OPERATION_BILLING_VALUES = Object.freeze(["managed"] as const);
export const PREMIUM_TERMINAL_STATUSES = Object.freeze(["completed", "failed", "canceled"] as const);

export interface PremiumProviderLabel {
  readonly id: string;
  readonly model: string;
}

export interface BeginPremiumOperationRequest {
  readonly mode: "premium";
  readonly max_charge_nano_usd: string;
  readonly provider: PremiumProviderLabel;
  readonly reporting_deadline_ms?: number;
  readonly metadata?: ResponseMetadata;
}

export interface BeginPremiumOperationResponse {
  readonly operation_id: string;
  readonly billing: Readable<PremiumOperationBilling>;
  readonly report_terminal: true;
  readonly effective_max_charge_nano_usd: string;
  readonly reserved_nano_usd: string;
  readonly terminal_deadline: string;
}

export type PremiumOperationBilling = (typeof PREMIUM_OPERATION_BILLING_VALUES)[number];
export type PremiumTerminalStatus = (typeof PREMIUM_TERMINAL_STATUSES)[number];
export type PremiumErrorCategory =
  | "provider"
  | "timeout"
  | "network"
  | "invalid_request"
  | "canceled"
  | "unknown";

export interface PremiumTerminalUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly reasoning_tokens?: number;
}

export interface PremiumTerminalDelivery {
  readonly output_started: boolean;
  readonly output_completed: boolean;
}

export interface PremiumTerminalTiming {
  readonly started_at: string;
  readonly ended_at: string;
}

export interface ReportPremiumTerminalRequest {
  readonly report_id: string;
  readonly status: PremiumTerminalStatus;
  readonly charge_nano_usd: string;
  readonly usage?: PremiumTerminalUsage;
  readonly finish_reason?: string;
  readonly provider_response_id?: string;
  readonly delivery?: PremiumTerminalDelivery;
  readonly timing?: PremiumTerminalTiming;
  readonly error_category?: PremiumErrorCategory;
}

export interface PremiumTerminalSettlement {
  readonly captured_nano_usd: string;
  readonly released_nano_usd: string;
  readonly business_earnings_nano_usd: string;
}

export interface ReportPremiumTerminalResponse {
  readonly operation_id: string;
  readonly status: Readable<PremiumTerminalStatus>;
  readonly idempotent_replay: boolean;
  readonly settlement: PremiumTerminalSettlement;
}

function rejectUnknownResponseFields(
  value: Record<string, unknown>,
  param: string,
  allowed: readonly string[],
  options?: ParseOptions
): Result<void> {
  return options?.mode === "tolerant" ? ok(undefined) : rejectUnknownFields(value, param, allowed);
}

function validateProvider(value: unknown, param: string): Result<PremiumProviderLabel> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a provider object");
  const unknown = rejectUnknownFields(value, param, ["id", "model"]);
  if (!unknown.ok) return unknown;
  if (typeof value.id !== "string") return invalidValue(`${param}.id`, "must be a string");
  if (typeof value.model !== "string") return invalidValue(`${param}.model`, "must be a string");
  return ok({ id: value.id, model: value.model });
}

/** Validate `POST /v1/enlitt/operations` before any reservation attempt. */
export function validateBeginPremiumOperationRequest(value: unknown): Result<BeginPremiumOperationRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "request body must be a JSON object");
  const unknown = rejectUnknownFields(value, "body", [
    "mode",
    "max_charge_nano_usd",
    "reporting_deadline_ms",
    "provider",
    "metadata"
  ]);
  if (!unknown.ok) return unknown;

  if (value.mode !== "premium") {
    return typeof value.mode === "string"
      ? unsupportedValue("mode", 'must be "premium"')
      : invalidValue("mode", 'must be "premium"');
  }

  const maxCharge = expectCanonicalNanoUsd(value.max_charge_nano_usd, "max_charge_nano_usd");
  if (!maxCharge.ok) return maxCharge;
  if (BigInt(maxCharge.value) > BigInt(PREMIUM_OPERATION_MAX_CHARGE_NANO_USD)) {
    return invalidValue("max_charge_nano_usd", "exceeds the deployed maximum single-call charge");
  }

  const provider = validateProvider(value.provider, "provider");
  if (!provider.ok) return provider;

  const request: {
    -readonly [K in keyof BeginPremiumOperationRequest]?: BeginPremiumOperationRequest[K];
  } = { mode: "premium", max_charge_nano_usd: maxCharge.value, provider: provider.value };

  if (value.reporting_deadline_ms !== undefined) {
    const deadline = expectNonNegativeSafeInteger(value.reporting_deadline_ms, "reporting_deadline_ms");
    if (!deadline.ok || deadline.value === 0) {
      return !deadline.ok
        ? deadline
        : invalidValue("reporting_deadline_ms", "must be a positive safe integer");
    }
    request.reporting_deadline_ms = deadline.value;
  }

  if (value.metadata !== undefined) {
    const metadata = validateCallerMetadata(value.metadata, "metadata");
    if (!metadata.ok) return metadata;
    request.metadata = metadata.value;
  }

  return ok(request as BeginPremiumOperationRequest);
}

/** Validate the exact admitted-operation response shape. */
export function validateBeginPremiumOperationResponse(value: unknown, options?: ParseOptions): Result<BeginPremiumOperationResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "response body must be a JSON object");
  const unknown = rejectUnknownResponseFields(value, "body", [
    "operation_id",
    "billing",
    "report_terminal",
    "effective_max_charge_nano_usd",
    "reserved_nano_usd",
    "terminal_deadline"
  ], options);
  if (!unknown.ok) return unknown;
  if (typeof value.operation_id !== "string") return invalidValue("operation_id", "must be a string");
  if (typeof value.billing !== "string") return invalidValue("billing", "must be a string");
  const billing = value.billing === "managed" ? value.billing : options?.mode === "tolerant" ? UNKNOWN_ENUM_VALUE : undefined;
  if (billing === undefined) return unsupportedValue("billing", 'must be "managed"');
  if (value.report_terminal !== true) return invalidValue("report_terminal", "must be true");
  const effective = expectCanonicalNanoUsd(value.effective_max_charge_nano_usd, "effective_max_charge_nano_usd");
  if (!effective.ok) return effective;
  const reserved = expectCanonicalNanoUsd(value.reserved_nano_usd, "reserved_nano_usd");
  if (!reserved.ok) return reserved;
  const deadline = expectRfc3339(value.terminal_deadline, "terminal_deadline");
  if (!deadline.ok) return deadline;
  return ok({
    operation_id: value.operation_id,
    billing,
    report_terminal: true,
    effective_max_charge_nano_usd: effective.value,
    reserved_nano_usd: reserved.value,
    terminal_deadline: deadline.value
  });
}

function validateUsage(value: unknown, param: string): Result<PremiumTerminalUsage> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a usage object");
  const unknown = rejectUnknownFields(value, param, [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "reasoning_tokens"
  ]);
  if (!unknown.ok) return unknown;
  const usage: { -readonly [K in keyof PremiumTerminalUsage]?: PremiumTerminalUsage[K] } = {};
  for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens"] as const) {
    if (value[key] === undefined) continue;
    const tokens = expectNonNegativeSafeInteger(value[key], `${param}.${key}`);
    if (!tokens.ok) return tokens;
    usage[key] = tokens.value;
  }
  return ok(usage);
}

function validateDelivery(value: unknown, param: string): Result<PremiumTerminalDelivery> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a delivery object");
  const unknown = rejectUnknownFields(value, param, ["output_started", "output_completed"]);
  if (!unknown.ok) return unknown;
  if (typeof value.output_started !== "boolean") return invalidValue(`${param}.output_started`, "must be a boolean");
  if (typeof value.output_completed !== "boolean") return invalidValue(`${param}.output_completed`, "must be a boolean");
  return ok({ output_started: value.output_started, output_completed: value.output_completed });
}

function validateTiming(value: unknown, param: string): Result<PremiumTerminalTiming> {
  if (!isPlainObject(value)) return invalidValue(param, "must be a timing object");
  const unknown = rejectUnknownFields(value, param, ["started_at", "ended_at"]);
  if (!unknown.ok) return unknown;
  const started = expectRfc3339(value.started_at, `${param}.started_at`);
  if (!started.ok) return started;
  const ended = expectRfc3339(value.ended_at, `${param}.ended_at`);
  if (!ended.ok) return ended;
  return ok({ started_at: started.value, ended_at: ended.value });
}

/** Validate `POST /v1/enlitt/operations/{operation_id}/terminal`. */
export function validateReportPremiumTerminalRequest(value: unknown): Result<ReportPremiumTerminalRequest> {
  if (!isPlainObject(value)) return invalidValue("body", "request body must be a JSON object");
  const unknown = rejectUnknownFields(value, "body", [
    "report_id",
    "status",
    "charge_nano_usd",
    "usage",
    "finish_reason",
    "provider_response_id",
    "delivery",
    "timing",
    "error_category"
  ]);
  if (!unknown.ok) return unknown;

  if (
    typeof value.report_id !== "string" ||
    value.report_id.length < 16 ||
    value.report_id.length > 255 ||
    !VISIBLE_ASCII.test(value.report_id)
  ) {
    return invalidValue("report_id", "must be 16–255 visible ASCII characters");
  }

  if (typeof value.status !== "string") return invalidValue("status", "must be a terminal status string");
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "canceled") {
    return unsupportedValue("status", "must be completed, failed, or canceled");
  }

  const charge = expectCanonicalNanoUsd(
    value.charge_nano_usd,
    "charge_nano_usd",
    PREMIUM_TERMINAL_CHARGE_MAX_DIGITS
  );
  if (!charge.ok) return charge;

  const request: {
    -readonly [K in keyof ReportPremiumTerminalRequest]?: ReportPremiumTerminalRequest[K];
  } = { report_id: value.report_id, status: value.status, charge_nano_usd: charge.value };

  if (value.usage !== undefined) {
    const usage = validateUsage(value.usage, "usage");
    if (!usage.ok) return usage;
    request.usage = usage.value;
  }
  for (const key of ["finish_reason", "provider_response_id"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") return invalidValue(key, "must be a string");
    request[key] = value[key];
  }
  if (value.delivery !== undefined) {
    const delivery = validateDelivery(value.delivery, "delivery");
    if (!delivery.ok) return delivery;
    request.delivery = delivery.value;
  }
  if (value.timing !== undefined) {
    const timing = validateTiming(value.timing, "timing");
    if (!timing.ok) return timing;
    request.timing = timing.value;
  }
  if (value.error_category !== undefined) {
    if (typeof value.error_category !== "string") {
      return invalidValue("error_category", "must be a string");
    }
    const categories = new Set<PremiumErrorCategory>([
      "provider",
      "timeout",
      "network",
      "invalid_request",
      "canceled",
      "unknown"
    ]);
    if (!categories.has(value.error_category as PremiumErrorCategory)) {
      return unsupportedValue("error_category", "must be a supported error category");
    }
    request.error_category = value.error_category as PremiumErrorCategory;
  }

  return ok(request as ReportPremiumTerminalRequest);
}

/** Validate the exact terminal settlement response shape, including replays. */
export function validateReportPremiumTerminalResponse(value: unknown, options?: ParseOptions): Result<ReportPremiumTerminalResponse> {
  if (!isPlainObject(value)) return invalidValue("body", "response body must be a JSON object");
  const unknown = rejectUnknownResponseFields(value, "body", ["operation_id", "status", "idempotent_replay", "settlement"], options);
  if (!unknown.ok) return unknown;
  if (typeof value.operation_id !== "string") return invalidValue("operation_id", "must be a string");
  if (typeof value.status !== "string") return invalidValue("status", "must be a terminal status string");
  const status = value.status === "completed" || value.status === "failed" || value.status === "canceled"
    ? value.status
    : options?.mode === "tolerant" ? UNKNOWN_ENUM_VALUE : undefined;
  if (status === undefined) return unsupportedValue("status", "must be completed, failed, or canceled");
  if (typeof value.idempotent_replay !== "boolean") return invalidValue("idempotent_replay", "must be a boolean");
  if (!isPlainObject(value.settlement)) return invalidValue("settlement", "must be a settlement object");
  const settlementUnknown = rejectUnknownResponseFields(value.settlement, "settlement", [
    "captured_nano_usd",
    "released_nano_usd",
    "business_earnings_nano_usd"
  ], options);
  if (!settlementUnknown.ok) return settlementUnknown;
  const captured = expectCanonicalNanoUsd(value.settlement.captured_nano_usd, "settlement.captured_nano_usd");
  if (!captured.ok) return captured;
  const released = expectCanonicalNanoUsd(value.settlement.released_nano_usd, "settlement.released_nano_usd");
  if (!released.ok) return released;
  const earnings = expectCanonicalNanoUsd(
    value.settlement.business_earnings_nano_usd,
    "settlement.business_earnings_nano_usd"
  );
  if (!earnings.ok) return earnings;
  return ok({
    operation_id: value.operation_id,
    status,
    idempotent_replay: value.idempotent_replay,
    settlement: {
      captured_nano_usd: captured.value,
      released_nano_usd: released.value,
      business_earnings_nano_usd: earnings.value
    }
  });
}
