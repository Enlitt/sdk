import { describe, expect, it } from "vitest";
import { validateAuthorizationExchangeResponse } from "../src/authentication.js";

const response = { session_token: "opaque-token", subject: "sub_application_user" };

describe("validateAuthorizationExchangeResponse", () => {
  it("requires both verified identity and a cookie-safe credential", () => {
    expect(validateAuthorizationExchangeResponse(response)).toEqual({ ok: true, value: response });
    for (const subject of [undefined, null, 42, "", "line\nbreak", "contains space", "s".repeat(256)]) {
      expect(validateAuthorizationExchangeResponse({ ...response, subject }).ok).toBe(false);
    }
    for (const session_token of [undefined, null, 42, "", "a;b", "a,b", "a\\b", 'a"b', "a\nb", "t".repeat(4097)]) {
      expect(validateAuthorizationExchangeResponse({ ...response, session_token }).ok).toBe(false);
    }
    for (const body of [null, [], "token", 42]) expect(validateAuthorizationExchangeResponse(body).ok).toBe(false);
    expect(validateAuthorizationExchangeResponse({ session_token: "t".repeat(4096), subject: "s".repeat(255) }).ok).toBe(true);
  });

  it("rejects unknown fields strictly and discards them tolerantly", () => {
    const future = { ...response, future: { detail: true } };
    expect(validateAuthorizationExchangeResponse(future).ok).toBe(false);
    expect(validateAuthorizationExchangeResponse(future, { mode: "tolerant" })).toEqual({ ok: true, value: response });
    expect(validateAuthorizationExchangeResponse({ session_token: "token", future: true }, { mode: "tolerant" }).ok).toBe(false);
  });
});
