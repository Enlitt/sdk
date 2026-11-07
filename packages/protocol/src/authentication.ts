import type { ParseOptions } from "./compatibility.js";
import { ENLITT_ERROR_CODE } from "./errors.js";
import type { ResponseValidationResult } from "./responses.js";

/** Identity returned only by the authenticated, server-side code exchange. */
export interface AuthorizationExchangeResponse {
  readonly session_token: string;
  readonly subject: string;
}

/** RFC 6265 cookie-octet: refuse values that could inject cookie attributes. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;
const SUBJECT = /^[A-Za-z0-9_-]{1,255}$/;

export function validateAuthorizationExchangeResponse(
  payload: unknown,
  options?: ParseOptions
): ResponseValidationResult<AuthorizationExchangeResponse> {
  const invalid = (param: string): ResponseValidationResult<never> => ({
    ok: false,
    error: { code: ENLITT_ERROR_CODE.invalid_value, param, message: "Invalid authorization exchange response" }
  });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return invalid("body");
  const body = payload as Record<string, unknown>;
  if (options?.mode !== "tolerant") {
    for (const key of Object.keys(body)) {
      if (key !== "session_token" && key !== "subject") return invalid(key);
    }
  }
  if (typeof body.session_token !== "string" || !COOKIE_VALUE.test(body.session_token)) {
    return invalid("session_token");
  }
  if (typeof body.subject !== "string" || !SUBJECT.test(body.subject)) return invalid("subject");
  return { ok: true, value: { session_token: body.session_token, subject: body.subject } };
}
