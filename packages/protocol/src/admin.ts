/**
 * The operator-CLI wire contract: `POST /v1/admin/actions` (`specs/PROTOCOLS.md`
 * "Admin actions"). It is not a public or browser API and is deliberately
 * absent from `contract.json`'s route list; only the operator CLI and the
 * backend admin route use these validators.
 *
 * Requests are strict: an unknown field, a missing required field, a float
 * amount, or a write command without a reason is refused. Responses are read
 * strictly by default, or tolerantly with `{ mode: "tolerant" }` (unknown
 * fields dropped, future closed-enum members mapped to `"other"`).
 *
 * Amounts follow the shared rule: credits are milli-credit integer strings,
 * money is minor-unit or NANOUSD integer strings (canonical base-10, no sign,
 * no fraction). Instants are RFC 3339.
 */

import { isCanonicalIntegerString } from "./canonical-integer.js";
import { UNKNOWN_ENUM_VALUE, type ParseOptions } from "./compatibility.js";
import { ENLITT_ERROR_CODE } from "./errors.js";
import type { ResponseRequestErrorCode, ResponseValidationResult } from "./responses.js";
import { validatePersonalDashboardSubscription } from "./dashboard.js";

type Result<T> = ResponseValidationResult<T>;
/** A validator for one value; `param` is the dotted path used in failures. */
type Check<T> = (value: unknown, param: string) => Result<T>;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Read commands: they change nothing and need no reason. */
export const ADMIN_READ_COMMANDS = [
  "inspect.user",
  "inspect.business",
  "inspect.app",
  "inspect.order",
  "inspect.call",
  "inspect.txn",
  "sql",
  "log",
  "report.platform"
] as const;

/** Write commands: a reason of 1 to 1,000 characters is required. */
export const ADMIN_WRITE_COMMANDS = [
  "refund.cash",
  "refund.manual",
  "refund.mark_paid",
  "refund.cancel_manual",
  "credits.grant",
  "plan.set",
  "plan.reset",
  "status.suspend",
  "status.unsuspend",
  "payout.block",
  "payout.unblock",
  "payout.create",
  "payout.execute",
  "gift.create",
  "gift.revoke",
  "account.set_email",
  "account.release_phone",
  "account.set_app_limits",
  "account.set_default_limit"
] as const;

export const ADMIN_COMMAND_NAMES = [...ADMIN_READ_COMMANDS, ...ADMIN_WRITE_COMMANDS] as const;
export type AdminCommandName = (typeof ADMIN_COMMAND_NAMES)[number];

export const ADMIN_ACTION_KINDS = ["read", "write"] as const;
export const ADMIN_ACTION_STATUSES = ["started", "succeeded", "failed"] as const;
export const ADMIN_SUBJECTS = ["user", "business", "app"] as const;

export const ADMIN_REASON_MAX_LENGTH = 1000;
export const ADMIN_SQL_MAX_LENGTH = 20_000;
export const ADMIN_SQL_MAX_LIMIT = 1000;
export const ADMIN_LOG_MAX_LIMIT = 200;
export const ADMIN_SUSPEND_MAX_DAYS = 3650;
/** `report.platform` reports on at most the last 90 days; the weekly email uses 7. */
export const ADMIN_REPORT_MAX_DAYS = 90;
export const ADMIN_REPORT_DEFAULT_DAYS = 7;
/** How a `PlatformReportRow` value is measured, and so how a client formats it. */
export const PLATFORM_REPORT_UNITS = ["count", "nano_usd", "usd_cents", "milli_credits"] as const;
/** The request body limit the route enforces. */
export const ADMIN_REQUEST_MAX_BYTES = 64 * 1024;

export function isAdminCommandName(value: unknown): value is AdminCommandName {
  return typeof value === "string" && (ADMIN_COMMAND_NAMES as readonly string[]).includes(value);
}

/** `"read"` or `"write"` for a known command. */
export function adminCommandKind(command: AdminCommandName): "read" | "write" {
  return (ADMIN_READ_COMMANDS as readonly string[]).includes(command) ? "read" : "write";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminSubject = (typeof ADMIN_SUBJECTS)[number];

export interface AdminLimits {
  readonly standard_per_call?: string;
  readonly premium_per_call?: string;
}

export interface AdminCommandArgs {
  "inspect.user": { readonly id?: string; readonly email?: string };
  "inspect.business": { readonly id?: string; readonly email?: string };
  "inspect.app": { readonly id: string };
  "inspect.order": { readonly id: string };
  "inspect.call": { readonly id: string };
  "inspect.txn": { readonly id: string };
  sql: { readonly sql: string; readonly limit?: number };
  log: {
    readonly operator?: string;
    readonly target_id?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  "report.platform": { readonly days?: number };
  "refund.cash": { readonly order_id: string; readonly amount_minor_units: string | null };
  "refund.manual": { readonly order_id: string; readonly amount_minor_units: string };
  "refund.mark_paid": { readonly transaction_id: string; readonly bank_reference: string };
  "refund.cancel_manual": { readonly transaction_id: string };
  "credits.grant": {
    readonly user_id: string;
    readonly standard_units: string;
    readonly premium_units: string;
    readonly call_id: string | null;
  };
  "plan.set": {
    readonly user_id: string;
    readonly plan_id: string;
    readonly catalog_version: string;
  };
  "plan.reset": { readonly user_id: string };
  "status.suspend": {
    readonly subject: AdminSubject;
    readonly id: string;
    readonly days: number | null;
  };
  "status.unsuspend": { readonly subject: AdminSubject; readonly id: string };
  "payout.block": { readonly business_id: string };
  "payout.unblock": { readonly business_id: string };
  "payout.create": { readonly business_id: string; readonly nano_usd: string };
  "payout.execute": { readonly transaction_id: string };
  "gift.create": {
    readonly product_kind: "subscription" | "bundle";
    readonly product_id: string;
    readonly catalog_version: string;
    readonly expires_at: string | null;
  };
  "gift.revoke": { readonly gift_code_id: string };
  "account.set_email": { readonly auth_user_id: string; readonly email: string };
  "account.release_phone": { readonly user_id: string };
  "account.set_app_limits": {
    readonly user_id: string;
    readonly application_id: string;
    readonly limits: AdminLimits;
  };
  "account.set_default_limit": { readonly user_id: string; readonly premium_per_call: string };
}

export interface AdminActionSummary {
  readonly action_id: string;
  readonly operator: string;
  readonly command: string;
  readonly kind: "read" | "write";
  readonly reason: string | null;
  readonly status: "started" | "succeeded" | "failed";
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly error_code: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export type PlatformReportUnit = (typeof PLATFORM_REPORT_UNITS)[number];

/**
 * One line of the platform report (`PROTOCOLS.md` "Admin actions"). Both values
 * are decimal integer strings and may be negative; `window` is null on a
 * snapshot row, whose `total` is the state at `window_end`.
 */
export interface PlatformReportRow {
  readonly label: string;
  readonly unit: PlatformReportUnit;
  readonly window: string | null;
  readonly total: string;
}

/** The `report.platform` result; its sections and labels are owned by `specs/Admin.md`. */
export interface PlatformReport {
  readonly environment: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly sections: readonly {
    readonly title: string;
    readonly rows: readonly PlatformReportRow[];
  }[];
}

/** An `inspect.*` summary: backend-owned, content-free, shaped per record kind. */
export type AdminInspectResult = Readonly<Record<string, unknown>>;

export interface AdminCommandResult {
  "inspect.user": AdminInspectResult;
  "inspect.business": AdminInspectResult;
  "inspect.app": AdminInspectResult;
  "inspect.order": AdminInspectResult;
  "inspect.call": AdminInspectResult;
  "inspect.txn": AdminInspectResult;
  sql: {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly unknown[])[];
    readonly truncated: boolean;
  };
  log: { readonly actions: readonly AdminActionSummary[]; readonly next_cursor: string | null };
  // `Pick` makes a mapped type, which (unlike an interface) is assignable to
  // `Record<string, unknown>` like the other results.
  "report.platform": Pick<PlatformReport, keyof PlatformReport>;
  "refund.cash": {
    readonly order_id: string;
    readonly refunds: readonly {
      readonly transaction_id: string;
      readonly amount_minor_units: string;
      readonly status: string;
    }[];
    readonly remaining_minor_units: string;
  };
  "refund.manual": { readonly transaction_id: string; readonly status: "pending" };
  "refund.mark_paid": { readonly transaction_id: string; readonly status: "completed" };
  "refund.cancel_manual": { readonly transaction_id: string; readonly status: "canceled" };
  "credits.grant": {
    readonly transaction_id: string;
    readonly extra_credit: { readonly standard_units: string; readonly premium_units: string };
  };
  "plan.set": { readonly subscription: unknown };
  "plan.reset": {
    readonly subscription: unknown;
    readonly period_start: string;
    readonly period_end: string;
  };
  "status.suspend": {
    readonly subject: AdminSubject;
    readonly id: string;
    readonly status: "suspended";
    readonly suspended_until: string | null;
    /**
     * What the billing step did for a user suspension: each order's refund
     * outcome under the refund policy and whether the subscription was
     * canceled. Null for a business or an app, which hold no purchase orders.
     */
    readonly billing: {
      readonly refunds: readonly {
        readonly order_id: string;
        readonly outcome: "refunded" | "under_review" | "refused" | "ineligible";
        readonly refund_minor_units: string;
        readonly reason: string;
      }[];
      readonly subscription_canceled: boolean;
    } | null;
  };
  "status.unsuspend": {
    readonly subject: AdminSubject;
    readonly id: string;
    readonly status: "active";
  };
  "payout.block": { readonly business_id: string; readonly payout_blocked: boolean };
  "payout.unblock": { readonly business_id: string; readonly payout_blocked: boolean };
  "payout.create": {
    readonly transaction_id: string;
    readonly nano_usd: string;
    readonly status: "pending";
  };
  "payout.execute": { readonly transaction_id: string; readonly status: string };
  "gift.create": { readonly gift_code_id: string; readonly code: string | null };
  "gift.revoke": { readonly gift_code_id: string; readonly status: "revoked" };
  "account.set_email": { readonly auth_user_id: string; readonly email: string };
  "account.release_phone": { readonly user_id: string; readonly phone_released: true };
  "account.set_app_limits": { readonly application_id: string; readonly limits: AdminLimits };
  "account.set_default_limit": {
    readonly user_id: string;
    readonly new_application_premium_per_call_limit: string;
  };
}

export interface AdminActionRequest {
  readonly action_id: string;
  readonly command: AdminCommandName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
}

export interface AdminActionSuccessResponse {
  readonly action_id: string;
  readonly command: string;
  readonly status: "succeeded";
  readonly replayed: boolean;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface AdminActionErrorResponse {
  readonly error: { readonly code: string; readonly message: string; readonly param?: string };
  readonly request_id: string;
  readonly action_id?: string;
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/** Set only while a tolerant response is being read; requests never set it. */
let lenient = false;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function fail(code: ResponseRequestErrorCode, param: string, message: string): Result<never> {
  return { ok: false, error: { code, param, message } };
}
function invalid(param: string, message: string): Result<never> {
  return fail(ENLITT_ERROR_CODE.invalid_value, param, message);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A non-empty string of at most `max` characters. */
const str =
  (max = 512): Check<string> =>
  (value, param) => {
    if (typeof value !== "string") return invalid(param, "must be a string");
    if (value.length < 1 || value.length > max)
      return invalid(param, `must be 1 to ${max} characters`);
    return ok(value);
  };

/** A canonical integer string (digits only), so a float or signed amount fails. */
const amount: Check<string> = (value, param) =>
  isCanonicalIntegerString(value)
    ? ok(value)
    : invalid(param, "must be a canonical base-10 integer string");

/** A canonical integer string greater than zero. */
const positiveAmount: Check<string> = (value, param) => {
  const parsed = amount(value, param);
  if (!parsed.ok) return parsed;
  return BigInt(parsed.value) > 0n ? parsed : invalid(param, "must be strictly positive");
};

const rfc3339: Check<string> = (value, param) =>
  typeof value === "string" && RFC3339.test(value)
    ? ok(value)
    : invalid(param, "must be an RFC 3339 timestamp");

const bool: Check<boolean> = (value, param) =>
  typeof value === "boolean" ? ok(value) : invalid(param, "must be a boolean");

/** A whole number within `[min, max]`; a float or numeric string fails. */
const intRange =
  (min: number, max: number): Check<number> =>
  (value, param) => {
    if (typeof value !== "number" || !Number.isInteger(value))
      return invalid(param, "must be an integer");
    if (value < min || value > max) return invalid(param, `must be between ${min} and ${max}`);
    return ok(value);
  };

/** A closed set; a tolerant response read maps a future member to `"other"`. */
const oneOf =
  <T extends string>(options: readonly T[]): Check<T> =>
  (value, param) => {
    if (typeof value === "string") {
      if ((options as readonly string[]).includes(value)) return ok(value as T);
      if (lenient) return ok(UNKNOWN_ENUM_VALUE as T);
    }
    return invalid(param, `must be one of: ${options.join(", ")}`);
  };

const exactly =
  <T extends string | boolean>(expected: T): Check<T> =>
  (value, param) =>
    value === expected ? ok(expected) : invalid(param, `must be ${JSON.stringify(expected)}`);

const nullable =
  <T>(inner: Check<T>): Check<T | null> =>
  (value, param) =>
    value === null ? ok(null) : inner(value, param);

/** Marks an object member that may be absent. */
interface Optional<T> {
  readonly optional: Check<T>;
}
const optional = <T>(inner: Check<T>): Optional<T> => ({ optional: inner });
type Member = Check<unknown> | Optional<unknown>;

/**
 * An object with exactly the declared members. An unknown member is refused,
 * except that a tolerant response read drops it.
 */
const object =
  (members: Readonly<Record<string, Member>>): Check<Record<string, unknown>> =>
  (value, param) => {
    const at = (key: string) => (param === "" ? key : `${param}.${key}`);
    if (!isObject(value)) return invalid(param === "" ? "body" : param, "must be an object");
    if (!lenient) {
      for (const key of Object.keys(value)) {
        if (!(key in members))
          return fail(ENLITT_ERROR_CODE.unsupported_parameter, at(key), `"${key}" is not accepted`);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(members)) {
      const present = Object.prototype.hasOwnProperty.call(value, key);
      if (typeof member !== "function" && !present) continue;
      const check = typeof member === "function" ? member : member.optional;
      const parsed = check(value[key], at(key));
      if (!parsed.ok) return parsed;
      out[key] = parsed.value;
    }
    return ok(out);
  };

const arrayOf =
  <T>(item: Check<T>): Check<T[]> =>
  (value, param) => {
    if (!Array.isArray(value)) return invalid(param, "must be an array");
    const out: T[] = [];
    for (const [index, entry] of value.entries()) {
      const parsed = item(entry, `${param}[${index}]`);
      if (!parsed.ok) return parsed;
      out.push(parsed.value);
    }
    return ok(out);
  };

/** Any JSON object, passed through as received (backend-owned summaries). */
const freeObject: Check<Record<string, unknown>> = (value, param) =>
  isObject(value) ? ok(value) : invalid(param, "must be an object");

/** `inspect.user` / `inspect.business` take exactly one of `id` and `email`. */
const idOrEmail: Check<Record<string, unknown>> = (value, param) => {
  const parsed = object({ id: optional(str()), email: optional(str(320)) })(value, param);
  if (!parsed.ok) return parsed;
  const count = Number("id" in parsed.value) + Number("email" in parsed.value);
  return count === 1 ? parsed : invalid("args", 'must carry exactly one of "id" and "email"');
};

// ---------------------------------------------------------------------------
// Per-command validators
// ---------------------------------------------------------------------------

const idArgs = object({ id: str() });
const subjectArgs = object({ subject: oneOf(ADMIN_SUBJECTS), id: str() });
const limitsShape = object({
  standard_per_call: optional(amount),
  premium_per_call: optional(amount)
});

const ARG_CHECKS: Readonly<Record<AdminCommandName, Check<Record<string, unknown>>>> = {
  "inspect.user": idOrEmail,
  "inspect.business": idOrEmail,
  "inspect.app": idArgs,
  "inspect.order": idArgs,
  "inspect.call": idArgs,
  "inspect.txn": idArgs,
  sql: object({
    sql: str(ADMIN_SQL_MAX_LENGTH),
    limit: optional(intRange(1, ADMIN_SQL_MAX_LIMIT))
  }),
  log: object({
    operator: optional(str()),
    target_id: optional(str()),
    limit: optional(intRange(1, ADMIN_LOG_MAX_LIMIT)),
    cursor: optional(str())
  }),
  "report.platform": object({ days: optional(intRange(1, ADMIN_REPORT_MAX_DAYS)) }),
  "refund.cash": object({ order_id: str(), amount_minor_units: nullable(positiveAmount) }),
  "refund.manual": object({ order_id: str(), amount_minor_units: positiveAmount }),
  "refund.mark_paid": object({ transaction_id: str(), bank_reference: str() }),
  "refund.cancel_manual": object({ transaction_id: str() }),
  "credits.grant": object({
    user_id: str(),
    standard_units: amount,
    premium_units: amount,
    call_id: nullable(str())
  }),
  "plan.set": object({ user_id: str(), plan_id: str(), catalog_version: str() }),
  "plan.reset": object({ user_id: str() }),
  "status.suspend": object({
    subject: oneOf(ADMIN_SUBJECTS),
    id: str(),
    days: nullable(intRange(1, ADMIN_SUSPEND_MAX_DAYS))
  }),
  "status.unsuspend": subjectArgs,
  "payout.block": object({ business_id: str() }),
  "payout.unblock": object({ business_id: str() }),
  "payout.create": object({ business_id: str(), nano_usd: positiveAmount }),
  "payout.execute": object({ transaction_id: str() }),
  "gift.create": object({
    product_kind: oneOf(["subscription", "bundle"] as const),
    product_id: str(),
    catalog_version: str(),
    expires_at: nullable(rfc3339)
  }),
  "gift.revoke": object({ gift_code_id: str() }),
  "account.set_email": object({ auth_user_id: str(), email: str(320) }),
  "account.release_phone": object({ user_id: str() }),
  "account.set_app_limits": object({ user_id: str(), application_id: str(), limits: limitsShape }),
  "account.set_default_limit": object({ user_id: str(), premium_per_call: amount })
};

const actionSummary = object({
  action_id: str(),
  operator: str(),
  command: str(),
  kind: oneOf(ADMIN_ACTION_KINDS),
  reason: nullable(str(ADMIN_REASON_MAX_LENGTH)),
  status: oneOf(ADMIN_ACTION_STATUSES),
  target_type: nullable(str()),
  target_id: nullable(str()),
  error_code: nullable(str()),
  created_at: rfc3339,
  finished_at: nullable(rfc3339)
});

const anyString: Check<string> = (value, param) =>
  typeof value === "string" ? ok(value) : invalid(param, "must be a string");

/** A decimal integer string that may be negative, with no leading zero and no `-0`. */
const signedAmount: Check<string> = (value, param) =>
  typeof value === "string" && /^(0|-?[1-9][0-9]*)$/.test(value)
    ? ok(value)
    : invalid(param, "must be a canonical base-10 integer string");

const platformReport = object({
  environment: anyString,
  window_start: rfc3339,
  window_end: rfc3339,
  sections: arrayOf(
    object({
      title: anyString,
      rows: arrayOf(
        object({
          label: anyString,
          unit: oneOf(PLATFORM_REPORT_UNITS),
          window: nullable(signedAmount),
          total: signedAmount
        })
      )
    })
  )
});

/** The personal dashboard `subscription` block, read with the surrounding mode. */
const subscriptionBlock: Check<unknown> = (value, param) => {
  const parsed = validatePersonalDashboardSubscription(value, {
    mode: lenient ? "tolerant" : "strict"
  });
  return parsed.ok ? parsed : invalid(param, parsed.error.message);
};

const RESULT_CHECKS: Readonly<Record<AdminCommandName, Check<Record<string, unknown>>>> = {
  "inspect.user": freeObject,
  "inspect.business": freeObject,
  "inspect.app": freeObject,
  "inspect.order": freeObject,
  "inspect.call": freeObject,
  "inspect.txn": freeObject,
  sql: object({
    columns: arrayOf(anyString),
    rows: arrayOf((value, param) =>
      Array.isArray(value) ? ok(value) : invalid(param, "must be an array")
    ),
    truncated: bool
  }),
  log: object({ actions: arrayOf(actionSummary), next_cursor: nullable(anyString) }),
  "report.platform": platformReport,
  "refund.cash": object({
    order_id: anyString,
    refunds: arrayOf(
      object({ transaction_id: anyString, amount_minor_units: amount, status: anyString })
    ),
    remaining_minor_units: amount
  }),
  "refund.manual": object({ transaction_id: anyString, status: exactly("pending") }),
  "refund.mark_paid": object({ transaction_id: anyString, status: exactly("completed") }),
  "refund.cancel_manual": object({ transaction_id: anyString, status: exactly("canceled") }),
  "credits.grant": object({
    transaction_id: anyString,
    extra_credit: object({ standard_units: amount, premium_units: amount })
  }),
  "plan.set": object({ subscription: subscriptionBlock }),
  "plan.reset": object({
    subscription: subscriptionBlock,
    period_start: rfc3339,
    period_end: rfc3339
  }),
  "status.suspend": object({
    subject: oneOf(ADMIN_SUBJECTS),
    id: anyString,
    status: exactly("suspended"),
    suspended_until: nullable(rfc3339),
    billing: nullable(
      object({
        refunds: arrayOf(
          object({
            order_id: anyString,
            outcome: oneOf(["refunded", "under_review", "refused", "ineligible"] as const),
            refund_minor_units: amount,
            reason: anyString
          })
        ),
        subscription_canceled: bool
      })
    )
  }),
  "status.unsuspend": object({
    subject: oneOf(ADMIN_SUBJECTS),
    id: anyString,
    status: exactly("active")
  }),
  "payout.block": object({ business_id: anyString, payout_blocked: bool }),
  "payout.unblock": object({ business_id: anyString, payout_blocked: bool }),
  "payout.create": object({
    transaction_id: anyString,
    nano_usd: amount,
    status: exactly("pending")
  }),
  "payout.execute": object({ transaction_id: anyString, status: anyString }),
  "gift.create": object({ gift_code_id: anyString, code: nullable(anyString) }),
  "gift.revoke": object({ gift_code_id: anyString, status: exactly("revoked") }),
  "account.set_email": object({ auth_user_id: anyString, email: anyString }),
  "account.release_phone": object({ user_id: anyString, phone_released: exactly(true) }),
  "account.set_app_limits": object({ application_id: anyString, limits: limitsShape }),
  "account.set_default_limit": object({
    user_id: anyString,
    new_application_premium_per_call_limit: amount
  })
};

/** Validates `args` for one command (strict: unknown or missing fields fail). */
export function validateAdminCommandArgs<C extends AdminCommandName>(
  command: C,
  args: unknown
): Result<AdminCommandArgs[C]> {
  const parsed = ARG_CHECKS[command](args, "args");
  return parsed.ok ? (parsed as Result<AdminCommandArgs[C]>) : parsed;
}

/** Validates a command's `result` object (tolerant mode drops unknown fields). */
export function validateAdminCommandResult<C extends AdminCommandName>(
  command: C,
  result: unknown,
  options?: ParseOptions
): Result<AdminCommandResult[C]> {
  const parsed = withMode(options, () => RESULT_CHECKS[command](result, "result"));
  return parsed.ok ? (parsed as Result<AdminCommandResult[C]>) : parsed;
}

function withMode<T>(options: ParseOptions | undefined, run: () => Result<T>): Result<T> {
  const previous = lenient;
  lenient = options?.mode === "tolerant";
  try {
    return run();
  } finally {
    lenient = previous;
  }
}

// ---------------------------------------------------------------------------
// Request and responses
// ---------------------------------------------------------------------------

/**
 * `POST /v1/admin/actions` body: exactly `{ action_id, command, args, reason }`.
 * The returned `args` are the validated, normalised arguments for `command`.
 */
export function validateAdminActionRequest(value: unknown): Result<AdminActionRequest> {
  if (!isObject(value)) return invalid("body", "must be an object");
  for (const key of Object.keys(value)) {
    if (!["action_id", "command", "args", "reason"].includes(key)) {
      return fail(
        ENLITT_ERROR_CODE.unsupported_parameter,
        key,
        `"${key}" is not accepted by this route`
      );
    }
  }
  const actionId = value.action_id;
  if (typeof actionId !== "string" || !UUID.test(actionId))
    return invalid("action_id", "must be a UUID");
  const command = value.command;
  if (!isAdminCommandName(command)) {
    return invalid("command", `must be one of: ${ADMIN_COMMAND_NAMES.join(", ")}`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, "reason")) {
    return invalid("reason", "is required and must be a string or null");
  }
  const reason = nullable(str(ADMIN_REASON_MAX_LENGTH))(value.reason, "reason");
  if (!reason.ok) return reason;
  if (adminCommandKind(command) === "write" && reason.value === null) {
    return invalid(
      "reason",
      `is required (1 to ${ADMIN_REASON_MAX_LENGTH} characters) for ${command}`
    );
  }
  const args = validateAdminCommandArgs(command, value.args);
  if (!args.ok) return args;
  return ok({ action_id: actionId, command, args: args.value, reason: reason.value });
}

/** `200` body of `POST /v1/admin/actions`; `result` is checked against the command. */
export function validateAdminActionResponse(
  value: unknown,
  options?: ParseOptions
): Result<AdminActionSuccessResponse> {
  return withMode(options, () => {
    const head = object({
      action_id: anyString,
      command: anyString,
      status: exactly("succeeded"),
      replayed: bool,
      result: freeObject
    })(value, "");
    if (!head.ok) return head;
    const command = head.value.command as string;
    if (isAdminCommandName(command)) {
      const result = RESULT_CHECKS[command](head.value.result, "result");
      if (!result.ok) return result;
      return ok({ ...head.value, result: result.value } as unknown as AdminActionSuccessResponse);
    }
    // A command this reader does not know can only come from a newer server.
    if (!lenient) return invalid("command", `must be one of: ${ADMIN_COMMAND_NAMES.join(", ")}`);
    return ok(head.value as unknown as AdminActionSuccessResponse);
  });
}

/** Error body of the admin route: the dashboard envelope plus `action_id` when the body parsed. */
export function validateAdminActionErrorResponse(
  value: unknown,
  options?: ParseOptions
): Result<AdminActionErrorResponse> {
  return withMode(options, () => {
    const parsed = object({
      error: object({ code: anyString, message: anyString, param: optional(anyString) }),
      request_id: anyString,
      action_id: optional(anyString)
    })(value, "");
    return parsed.ok ? (parsed as unknown as Result<AdminActionErrorResponse>) : parsed;
  });
}

/** One audit-log row, as returned by `log`. */
export function validateAdminActionSummary(
  value: unknown,
  options?: ParseOptions
): Result<AdminActionSummary> {
  const parsed = withMode(options, () => actionSummary(value, "body"));
  return parsed.ok ? (parsed as unknown as Result<AdminActionSummary>) : parsed;
}
