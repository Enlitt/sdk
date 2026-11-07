/**
 * The stable error contract, owned here and nowhere else.
 *
 * Every entry carries all seven properties that a client needs to interpret a
 * refusal. The backend renders from this table and clients classify from the
 * same table, so status, retryability, and remediation facts cannot drift.
 */

import { isCanonicalIntegerString } from "./canonical-integer.js";
import { UNRECOGNIZED_ERROR_CODE } from "./compatibility.js";

export const ENLITT_ERROR_TYPES = [
  "authentication_error",
  "permission_error",
  "invalid_request_error",
  "insufficient_credits_error",
  "rate_limit_error",
  "conflict_error",
  "server_error"
] as const;

export type EnlittErrorType = (typeof ENLITT_ERROR_TYPES)[number];

export interface EnlittErrorDefinition {
  readonly type: EnlittErrorType;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: "required" | "forbidden";
  readonly authorizeUrl: "allowed" | "forbidden";
  readonly admissibleMaxCharge: "allowed" | "forbidden";
  readonly limitRule: "required" | "forbidden";
}

function definition(input: EnlittErrorDefinition): Readonly<EnlittErrorDefinition> {
  return Object.freeze(input);
}

const forbidden = {
  retryAfter: "forbidden",
  authorizeUrl: "forbidden",
  admissibleMaxCharge: "forbidden",
  limitRule: "forbidden"
} as const;

/** The complete public code record. No stable code is declared elsewhere. */
export const ENLITT_ERROR_CODES = Object.freeze({
  personal_login_required: definition({
    type: "authentication_error", status: 401, retryable: false, ...forbidden
  }),
  admin_authentication_required: definition({
    type: "authentication_error", status: 401, retryable: false, ...forbidden
  }),
  dashboard_login_required: definition({
    type: "authentication_error", status: 401, retryable: false, ...forbidden
  }),
  spending_limit_exceeded: definition({
    type: "insufficient_credits_error",
    status: 403,
    retryable: false,
    retryAfter: "forbidden",
    authorizeUrl: "allowed",
    admissibleMaxCharge: "forbidden",
    limitRule: "required"
  }),
  premium_balance_exhausted: definition({
    type: "insufficient_credits_error",
    status: 403,
    retryable: false,
    retryAfter: "forbidden",
    authorizeUrl: "allowed",
    admissibleMaxCharge: "allowed",
    limitRule: "forbidden"
  }),
  standard_balance_exhausted: definition({
    type: "insufficient_credits_error",
    status: 403,
    retryable: false,
    retryAfter: "forbidden",
    authorizeUrl: "allowed",
    admissibleMaxCharge: "forbidden",
    limitRule: "forbidden"
  }),
  subscription_inactive: definition({
    type: "insufficient_credits_error",
    status: 403,
    retryable: false,
    retryAfter: "forbidden",
    authorizeUrl: "allowed",
    admissibleMaxCharge: "forbidden",
    limitRule: "forbidden"
  }),
  rate_limit_exceeded: definition({
    type: "rate_limit_error", status: 429, retryable: true,
    ...forbidden, retryAfter: "required"
  }),
  conflict_error: definition({ type: "conflict_error", status: 409, retryable: false, ...forbidden }),
  operation_in_progress: definition({ type: "conflict_error", status: 409, retryable: false, ...forbidden }),
  idempotency_replay_unavailable: definition({
    type: "conflict_error", status: 409, retryable: false, ...forbidden
  }),
  invalid_value: definition({ type: "invalid_request_error", status: 400, retryable: false, ...forbidden }),
  unsupported_parameter: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  unsupported_value: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  invalid_api_key: definition({ type: "authentication_error", status: 401, retryable: false, ...forbidden }),
  reauthentication_required: definition({
    type: "authentication_error", status: 401, retryable: false, ...forbidden
  }),
  payment_declined: definition({
    type: "invalid_request_error", status: 402, retryable: false, ...forbidden
  }),
  invalid_sign_in_code: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  insufficient_permissions: definition({ type: "permission_error", status: 403, retryable: false, ...forbidden }),
  // The application's premium switch (`applications.premium_enabled`) refuses
  // premium: a premium start while it is off, or a terminal report for an
  // operation that started before the switch last changed. It is the
  // business's configuration to fix, never a credit refusal, so it carries no
  // `authorize_url` and no other extension field (owner decision 2026-10-25).
  premium_not_enabled: definition({ type: "permission_error", status: 403, retryable: false, ...forbidden }),
  not_found: definition({ type: "invalid_request_error", status: 404, retryable: false, ...forbidden }),
  request_too_large: definition({ type: "invalid_request_error", status: 413, retryable: false, ...forbidden }),
  server_error: definition({ type: "server_error", status: 500, retryable: true, ...forbidden }),
  provider_error: definition({ type: "server_error", status: 502, retryable: true, ...forbidden }),
  business_selection_required: definition({
    type: "invalid_request_error", status: 409, retryable: false, ...forbidden
  }),
  bot_verification_failed: definition({ type: "permission_error", status: 403, retryable: false, ...forbidden }),
  phone_verification_required: definition({
    type: "permission_error", status: 403, retryable: false, ...forbidden
  }),
  invalid_phone_code: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  phone_number_not_supported: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  phone_number_unavailable: definition({ type: "conflict_error", status: 409, retryable: false, ...forbidden }),
  // A business name is already held by another business (case-insensitive, any status).
  business_name_unavailable: definition({ type: "conflict_error", status: 409, retryable: false, ...forbidden }),
  // The four device-flow answers of `POST /v1/cli/token`. Polling again after
  // `authorization_pending` or `slow_down` is the flow itself, not an HTTP
  // retry, so all four are non-retryable.
  authorization_pending: definition({
    type: "invalid_request_error", status: 400, retryable: false, ...forbidden
  }),
  slow_down: definition({ type: "invalid_request_error", status: 400, retryable: false, ...forbidden }),
  access_denied: definition({ type: "invalid_request_error", status: 400, retryable: false, ...forbidden }),
  expired_token: definition({ type: "invalid_request_error", status: 400, retryable: false, ...forbidden })
} as const satisfies Readonly<Record<string, EnlittErrorDefinition>>);

export type EnlittErrorCode = keyof typeof ENLITT_ERROR_CODES;

export const ENLITT_ERROR_CODE_NAMES = Object.freeze(
  Object.keys(ENLITT_ERROR_CODES) as readonly EnlittErrorCode[]
);

export const ENLITT_ERROR_CODE = Object.freeze(
  Object.fromEntries(ENLITT_ERROR_CODE_NAMES.map((code) => [code, code]))
) as Readonly<{ [Code in EnlittErrorCode]: Code }>;

export function isEnlittErrorCode(value: unknown): value is EnlittErrorCode {
  return typeof value === "string" && Object.hasOwn(ENLITT_ERROR_CODES, value);
}

export function getEnlittErrorDefinition(code: EnlittErrorCode): EnlittErrorDefinition {
  return ENLITT_ERROR_CODES[code];
}

/** The only extension fields a rendered OpenAI-shaped error may use. */
export interface EnlittErrorExtension {
  readonly authorize_url?: string;
  readonly admissible_max_charge_nano_usd?: string;
  readonly limit_rule?: string;
}

export interface EnlittErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: EnlittErrorType;
    readonly param: string | null;
    readonly code: string | null;
    readonly enlitt?: EnlittErrorExtension;
  };
}

export interface EnlittErrorInput {
  readonly code: EnlittErrorCode;
  readonly message: string;
  readonly param?: string | null;
  readonly authorizeUrl?: string;
  readonly admissibleMaxChargeNanoUsd?: string;
  readonly limitRule?: string;
  readonly retryAfterSeconds?: number;
}

export interface RenderedEnlittError {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: EnlittErrorBody;
  readonly retryable: boolean;
}

export class EnlittErrorContractViolation extends Error {
  override readonly name = "EnlittErrorContractViolation";
}

/** Render a record-backed error without allowing an endpoint to add foreign facts. */
export function renderEnlittError(input: EnlittErrorInput): RenderedEnlittError {
  if (!isEnlittErrorCode(input.code)) {
    throw new EnlittErrorContractViolation(`Unknown Enlitt error code: ${String(input.code)}`);
  }
  const record = ENLITT_ERROR_CODES[input.code];
  const headers: Record<string, string> = {};

  if (record.retryAfter === "required") {
    if (!Number.isInteger(input.retryAfterSeconds) || (input.retryAfterSeconds ?? -1) < 0) {
      throw new EnlittErrorContractViolation(`${input.code} requires a nonnegative integer retryAfterSeconds`);
    }
    headers["retry-after"] = String(input.retryAfterSeconds);
  } else if (input.retryAfterSeconds !== undefined) {
    throw new EnlittErrorContractViolation(`${input.code} must not carry Retry-After`);
  }

  if (input.authorizeUrl !== undefined && record.authorizeUrl === "forbidden") {
    throw new EnlittErrorContractViolation(`${input.code} must not carry authorize_url`);
  }
  if (input.admissibleMaxChargeNanoUsd !== undefined && record.admissibleMaxCharge === "forbidden") {
    throw new EnlittErrorContractViolation(`${input.code} must not carry admissible_max_charge_nano_usd`);
  }
  if (record.admissibleMaxCharge === "allowed" && input.admissibleMaxChargeNanoUsd === undefined) {
    throw new EnlittErrorContractViolation(`${input.code} requires admissible_max_charge_nano_usd`);
  }
  if (
    input.admissibleMaxChargeNanoUsd !== undefined &&
    !isCanonicalIntegerString(input.admissibleMaxChargeNanoUsd)
  ) {
    throw new EnlittErrorContractViolation("admissible_max_charge_nano_usd must be canonical");
  }
  if (record.limitRule === "required") {
    if (
      typeof input.limitRule !== "string" ||
      input.limitRule.length === 0 ||
      input.limitRule.length > 64
    ) {
      throw new EnlittErrorContractViolation(`${input.code} requires a bounded limitRule`);
    }
  } else if (input.limitRule !== undefined) {
    throw new EnlittErrorContractViolation(`${input.code} must not carry limit_rule`);
  }

  const extension: {
    authorize_url?: string;
    admissible_max_charge_nano_usd?: string;
    limit_rule?: string;
  } = {};
  if (input.authorizeUrl !== undefined) extension.authorize_url = input.authorizeUrl;
  if (input.admissibleMaxChargeNanoUsd !== undefined) {
    extension.admissible_max_charge_nano_usd = input.admissibleMaxChargeNanoUsd;
  }
  if (input.limitRule !== undefined) extension.limit_rule = input.limitRule;

  const error: EnlittErrorBody["error"] = {
    message: input.message,
    type: record.type,
    param: input.param ?? null,
    code: input.code,
    ...(Object.keys(extension).length > 0 ? { enlitt: Object.freeze(extension) } : {})
  };

  return Object.freeze({
    status: record.status,
    headers: Object.freeze(headers),
    body: Object.freeze({ error: Object.freeze(error) }),
    retryable: record.retryable
  });
}

export interface ClassifiedEnlittError {
  readonly code: string;
  readonly recognized: boolean;
  readonly status: number;
  readonly type: string | null;
  readonly retryable: boolean;
  readonly creditRefusal: boolean;
  readonly message: string | null;
  readonly authorizeUrl?: string;
  readonly admissibleMaxChargeNanoUsd?: string;
  readonly limitRule?: string;
}

interface ErrorEnvelope {
  readonly code: unknown;
  readonly message: string;
  readonly type: string | null;
  readonly extension: Record<string, unknown> | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unknown fields are ignored, but every required known field stays required. */
function parseErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!isPlainObject(body) || !isPlainObject(body.error)) return null;
  const error = body.error;
  if (typeof error.message !== "string") return null;

  if (typeof error.type === "string") {
    if (!(typeof error.param === "string" || error.param === null)) return null;
    return {
      code: error.code,
      message: error.message,
      type: error.type,
      extension: isPlainObject(error.enlitt) ? error.enlitt : undefined
    };
  }

  // Dashboard errors have no `type` and always carry the root request id.
  if (typeof error.code !== "string" || typeof body.request_id !== "string") return null;
  return { code: error.code, message: error.message, type: null, extension: undefined };
}

function hasRecognizableErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

function isAllowedAuthorizeUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * Classify known and future server envelopes without throwing. Transports own
 * Retry-After and request-id reads, so this function intentionally reads no headers.
 */
export function classifyEnlittErrorResponse(
  status: number,
  body: unknown
): ClassifiedEnlittError | null {
  const envelope = parseErrorEnvelope(body);
  if (envelope === null) return null;

  const rawCode = hasRecognizableErrorCode(envelope.code)
    ? envelope.code
    : UNRECOGNIZED_ERROR_CODE;
  const recognized = isEnlittErrorCode(rawCode);
  const definition = recognized ? ENLITT_ERROR_CODES[rawCode] : undefined;
  const creditRefusal =
    definition?.type === "insufficient_credits_error" ||
    (!definition && envelope.type === "insufficient_credits_error");
  const retryable = definition?.retryable ?? (creditRefusal ? false : status >= 500 && status <= 599);
  const result: {
    code: string;
    recognized: boolean;
    status: number;
    type: string | null;
    retryable: boolean;
    creditRefusal: boolean;
    message: string | null;
    authorizeUrl?: string;
    admissibleMaxChargeNanoUsd?: string;
    limitRule?: string;
  } = {
    code: rawCode,
    recognized,
    status,
    type: envelope.type,
    retryable,
    creditRefusal,
    message: envelope.message.slice(0, 512)
  };

  if (
    envelope.extension !== undefined &&
    (definition?.authorizeUrl === "allowed" || (!definition && creditRefusal)) &&
    isAllowedAuthorizeUrl(envelope.extension.authorize_url)
  ) {
    result.authorizeUrl = envelope.extension.authorize_url;
  }
  if (
    definition?.admissibleMaxCharge === "allowed" &&
    isCanonicalIntegerString(envelope.extension?.admissible_max_charge_nano_usd)
  ) {
    result.admissibleMaxChargeNanoUsd = envelope.extension.admissible_max_charge_nano_usd;
  }
  if (definition?.limitRule === "required") {
    const rule = envelope.extension?.limit_rule;
    if (typeof rule !== "string" || rule.length === 0 || rule.length > 64) return null;
    result.limitRule = rule;
  }
  return result;
}
