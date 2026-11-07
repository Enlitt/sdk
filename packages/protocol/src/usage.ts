import { isCanonicalIntegerString } from "./canonical-integer.js";
import type { ParseOptions } from "./compatibility.js";
import { ENLITT_ERROR_CODE } from "./errors.js";
import type { ResponseValidationResult } from "./responses.js";

export interface UsageAvailability {
  readonly remaining_percent: number;
  readonly limit_cap_nano_usd: string;
}

export interface UsageResponse {
  readonly standard: UsageAvailability;
  readonly premium: UsageAvailability;
}

function invalid<T = never>(param: string, message: string): ResponseValidationResult<T> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.invalid_value, param, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  param: string,
  options?: ParseOptions
): ResponseValidationResult<void> {
  if (options?.mode !== "tolerant") {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) return invalid(param ? `${param}.${key}` : key, `unknown response field "${key}"`);
    }
  }
  return { ok: true, value: undefined };
}

function validateAvailability(value: unknown, param: string, options?: ParseOptions): ResponseValidationResult<UsageAvailability> {
  if (!isObject(value)) return invalid(param, "must be an object");
  const keys = rejectUnknown(value, ["remaining_percent", "limit_cap_nano_usd"], param, options);
  if (!keys.ok) return keys;
  if (typeof value.remaining_percent !== "number" || !Number.isInteger(value.remaining_percent) || value.remaining_percent < 0 || value.remaining_percent > 100) {
    return invalid(`${param}.remaining_percent`, "must be an integer from 0 through 100");
  }
  if (!isCanonicalIntegerString(value.limit_cap_nano_usd)) {
    return invalid(`${param}.limit_cap_nano_usd`, "must be a canonical nonnegative NANOUSD integer string");
  }
  return { ok: true, value: { remaining_percent: value.remaining_percent, limit_cap_nano_usd: value.limit_cap_nano_usd } };
}

export function validateUsageResponse(value: unknown, options?: ParseOptions): ResponseValidationResult<UsageResponse> {
  if (!isObject(value)) return invalid("body", "response body must be a JSON object");
  const keys = rejectUnknown(value, ["standard", "premium"], "", options);
  if (!keys.ok) return keys;
  const standard = validateAvailability(value.standard, "standard", options);
  if (!standard.ok) return standard;
  const premium = validateAvailability(value.premium, "premium", options);
  if (!premium.ok) return premium;
  return { ok: true, value: { standard: standard.value, premium: premium.value } };
}
