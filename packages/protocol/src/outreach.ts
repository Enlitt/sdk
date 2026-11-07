/**
 * The outreach visit wire contract: `POST /v1/outreach/visits` and
 * `GET /v1/outreach/visits` (`specs/PROTOCOLS.md` "Outreach visits").
 *
 * Outreach emails link to `/developers?ref=<tracking_id>`. The developer page
 * reports that it was opened with such a link, and the outreach team reads the
 * reports back with a private token. Neither route is part of the SDK or the
 * dashboard API, so both are deliberately absent from `contract.json`'s public
 * route list; only the developer page, the backend, and the outreach tools use
 * these validators.
 *
 * Every validator is strict: an unknown member or query parameter is refused.
 */

import { ENLITT_ERROR_CODE } from "./errors.js";
import type { ResponseRequestErrorCode, ResponseValidationResult } from "./responses.js";

type Result<T> = ResponseValidationResult<T>;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A tracking ID and a visitor key: 32 lowercase hexadecimal characters. */
export const OUTREACH_TRACKING_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The largest `POST /v1/outreach/visits` body the backend reads. */
export const OUTREACH_VISIT_REQUEST_MAX_BYTES = 1024;

export const OUTREACH_VISIT_EVENTS = ["view", "engaged"] as const;
export type OutreachVisitEvent = (typeof OUTREACH_VISIT_EVENTS)[number];

/** Reasons a visit may come from a scanner or another program, in output order. */
export const OUTREACH_AUTOMATED_SIGNALS = ["user_agent", "webdriver", "hosting_network"] as const;
export type OutreachAutomatedSignal = (typeof OUTREACH_AUTOMATED_SIGNALS)[number];

export const OUTREACH_VISIT_LIST_DEFAULT_LIMIT = 200;
export const OUTREACH_VISIT_LIST_MAX_LIMIT = 500;

/** The body the developer page sends for one visit event. */
export interface OutreachVisitRequest {
  readonly tracking_id: string;
  readonly event: OutreachVisitEvent;
  readonly visitor_key: string;
  readonly webdriver: boolean;
}

/**
 * A validated list query: either every row of one tracking ID, or every row
 * created at or after `since`, paged by an opaque cursor.
 */
export type OutreachVisitListQuery =
  | { readonly kind: "tracking_id"; readonly tracking_id: string }
  | {
      readonly kind: "since";
      readonly since: string;
      readonly cursor: string | null;
      readonly limit: number;
    };

export interface OutreachVisit {
  readonly id: string;
  readonly tracking_id: string;
  readonly event: OutreachVisitEvent;
  readonly visitor_key: string;
  readonly visited_at: string;
  readonly user_agent: string | null;
  readonly webdriver: boolean;
  readonly country: string | null;
  readonly asn: number | null;
  readonly as_organization: string | null;
  readonly automated_signals: readonly OutreachAutomatedSignal[];
}

export interface OutreachVisitList {
  readonly visits: readonly OutreachVisit[];
  readonly next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const COUNTRY = /^[A-Z]{2}$/;

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
/** True for an RFC 3339 string that also names a real instant (no 2026-13-45). */
function isRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}
/** Refuses the first member of `value` that is not in `allowed`. */
function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string
): Result<never> | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return fail(ENLITT_ERROR_CODE.unsupported_parameter, `${prefix}${key}`, `"${key}" is not accepted`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/outreach/visits
// ---------------------------------------------------------------------------

/** Validates an already-parsed visit report body. */
export function validateOutreachVisitRequest(value: unknown): Result<OutreachVisitRequest> {
  if (!isObject(value)) return invalid("body", "must be a JSON object");
  const unknown = rejectUnknown(value, ["tracking_id", "event", "visitor_key", "webdriver"], "");
  if (unknown) return unknown;

  const { tracking_id, event, visitor_key, webdriver } = value;
  if (typeof tracking_id !== "string" || !OUTREACH_TRACKING_ID_PATTERN.test(tracking_id)) {
    return invalid("tracking_id", "must be 32 lowercase hexadecimal characters");
  }
  if (typeof event !== "string" || !(OUTREACH_VISIT_EVENTS as readonly string[]).includes(event)) {
    return invalid("event", `must be one of: ${OUTREACH_VISIT_EVENTS.join(", ")}`);
  }
  if (typeof visitor_key !== "string" || !OUTREACH_TRACKING_ID_PATTERN.test(visitor_key)) {
    return invalid("visitor_key", "must be 32 lowercase hexadecimal characters");
  }
  if (typeof webdriver !== "boolean") return invalid("webdriver", "must be a boolean");
  return ok({ tracking_id, event: event as OutreachVisitEvent, visitor_key, webdriver });
}

// ---------------------------------------------------------------------------
// GET /v1/outreach/visits
// ---------------------------------------------------------------------------

const LIST_PARAMS = ["tracking_id", "since", "cursor", "limit"] as const;

/**
 * Validates the list query. The cursor stays opaque here; the backend decodes
 * it and refuses one it did not issue.
 */
export function validateOutreachVisitListQuery(params: URLSearchParams): Result<OutreachVisitListQuery> {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!(LIST_PARAMS as readonly string[]).includes(key)) {
      return fail(ENLITT_ERROR_CODE.unsupported_parameter, key, `"${key}" is not accepted`);
    }
    if (seen.has(key)) return invalid(key, "must appear at most once");
    seen.add(key);
  }

  const trackingId = params.get("tracking_id");
  const since = params.get("since");
  const cursor = params.get("cursor");
  const limit = params.get("limit");

  if ((trackingId === null) === (since === null)) {
    return invalid(trackingId === null ? "since" : "tracking_id", "send exactly one of tracking_id or since");
  }

  if (trackingId !== null) {
    if (!OUTREACH_TRACKING_ID_PATTERN.test(trackingId)) {
      return invalid("tracking_id", "must be 32 lowercase hexadecimal characters");
    }
    // A tracking-ID query returns every row at once, so it has no paging.
    if (cursor !== null) return invalid("cursor", "is accepted only with since");
    if (limit !== null) return invalid("limit", "is accepted only with since");
    return ok({ kind: "tracking_id", tracking_id: trackingId });
  }

  if (!isRfc3339(since)) return invalid("since", "must be an RFC 3339 timestamp");
  if (cursor !== null && cursor.length === 0) return invalid("cursor", "must not be empty");
  let parsedLimit = OUTREACH_VISIT_LIST_DEFAULT_LIMIT;
  if (limit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > OUTREACH_VISIT_LIST_MAX_LIMIT) {
      return invalid("limit", `must be an integer between 1 and ${OUTREACH_VISIT_LIST_MAX_LIMIT}`);
    }
    parsedLimit = Number(limit);
  }
  return ok({ kind: "since", since, cursor, limit: parsedLimit });
}

/** Validates one `OutreachVisit`; `param` is its position in the list. */
function validateVisit(value: unknown, param: string): Result<OutreachVisit> {
  if (!isObject(value)) return invalid(param, "must be an object");
  const unknown = rejectUnknown(
    value,
    [
      "id",
      "tracking_id",
      "event",
      "visitor_key",
      "visited_at",
      "user_agent",
      "webdriver",
      "country",
      "asn",
      "as_organization",
      "automated_signals"
    ],
    `${param}.`
  );
  if (unknown) return unknown;

  const v = value;
  const at = (key: string) => `${param}.${key}`;
  if (typeof v.id !== "string" || !UUID.test(v.id)) return invalid(at("id"), "must be a UUID");
  if (typeof v.tracking_id !== "string" || !OUTREACH_TRACKING_ID_PATTERN.test(v.tracking_id)) {
    return invalid(at("tracking_id"), "must be 32 lowercase hexadecimal characters");
  }
  if (typeof v.event !== "string" || !(OUTREACH_VISIT_EVENTS as readonly string[]).includes(v.event)) {
    return invalid(at("event"), `must be one of: ${OUTREACH_VISIT_EVENTS.join(", ")}`);
  }
  if (typeof v.visitor_key !== "string" || !OUTREACH_TRACKING_ID_PATTERN.test(v.visitor_key)) {
    return invalid(at("visitor_key"), "must be 32 lowercase hexadecimal characters");
  }
  if (!isRfc3339(v.visited_at)) return invalid(at("visited_at"), "must be an RFC 3339 timestamp");
  if (v.user_agent !== null && (typeof v.user_agent !== "string" || v.user_agent.length > 512)) {
    return invalid(at("user_agent"), "must be null or a string of at most 512 characters");
  }
  if (typeof v.webdriver !== "boolean") return invalid(at("webdriver"), "must be a boolean");
  if (v.country !== null && (typeof v.country !== "string" || !COUNTRY.test(v.country))) {
    return invalid(at("country"), "must be null or two uppercase letters");
  }
  if (v.asn !== null && !(Number.isSafeInteger(v.asn) && (v.asn as number) > 0)) {
    return invalid(at("asn"), "must be null or a positive integer");
  }
  if (
    v.as_organization !== null &&
    (typeof v.as_organization !== "string" || v.as_organization.length > 128)
  ) {
    return invalid(at("as_organization"), "must be null or a string of at most 128 characters");
  }
  if (!Array.isArray(v.automated_signals)) return invalid(at("automated_signals"), "must be an array");
  // Signals are listed in the fixed vocabulary order with no duplicate.
  let previous = -1;
  for (const [index, signal] of v.automated_signals.entries()) {
    const position = OUTREACH_AUTOMATED_SIGNALS.indexOf(signal as OutreachAutomatedSignal);
    if (position === -1) {
      return invalid(`${at("automated_signals")}[${index}]`, `must be one of: ${OUTREACH_AUTOMATED_SIGNALS.join(", ")}`);
    }
    if (position <= previous) {
      return invalid(at("automated_signals"), "must be in vocabulary order without duplicates");
    }
    previous = position;
  }
  return ok(v as unknown as OutreachVisit);
}

/** Validates a `200` list response body. */
export function validateOutreachVisitList(value: unknown): Result<OutreachVisitList> {
  if (!isObject(value)) return invalid("body", "must be an object");
  const unknown = rejectUnknown(value, ["visits", "next_cursor"], "");
  if (unknown) return unknown;
  if (!Array.isArray(value.visits)) return invalid("visits", "must be an array");
  const visits: OutreachVisit[] = [];
  for (const [index, entry] of value.visits.entries()) {
    const parsed = validateVisit(entry, `visits[${index}]`);
    if (!parsed.ok) return parsed;
    visits.push(parsed.value);
  }
  const nextCursor = value.next_cursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0)) {
    return invalid("next_cursor", "must be null or a non-empty string");
  }
  return ok({ visits, next_cursor: nextCursor });
}
