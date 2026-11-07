import { describe, expect, it } from "vitest";

import {
  CLI_AUTHORIZATION_KINDS,
  ENLITT_ERROR_CODES,
  normalizeCliUserCode,
  validateBusinessKeyListQuery,
  validateCliAuthorizationView,
  validateCliCredentialList,
  validateCliTokenGrant,
  validateCliTokenRequest,
  validateStartCliAuthorizationRequest,
  validateStartedCliAuthorization
} from "../src/index.js";

// `specs/PROTOCOLS.md` "CLI authorization": the wire shapes of the device flow.

const started = {
  device_code: "dGhpcyBpcyBhIGRldmljZSBjb2Rl",
  user_code: "BCDF-GHJK",
  verification_uri: "https://enlitt.com/cli/authorize",
  verification_uri_complete: "https://enlitt.com/cli/authorize?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5
};

const loginGrant = {
  kind: "login",
  token: "enl_cli_secret",
  token_expires_at: "2027-01-16T00:00:00Z",
  credential_id: "cli_1",
  business: { id: "biz_1", name: "Acme" },
  login: { email: "dev@example.com" }
};

const credential = {
  id: "cli_1",
  device_label: "laptop (linux)",
  business: { id: "biz_1", name: "Acme" },
  approved_at: "2026-10-18T00:00:00Z",
  last_used_at: null,
  expires_at: "2027-01-16T00:00:00Z"
};

describe("CLI authorization wire contracts", () => {
  it("declares the kinds and the four device-flow error codes", () => {
    expect(CLI_AUTHORIZATION_KINDS).toEqual(["login", "step_up"]);
    for (const code of ["authorization_pending", "slow_down", "access_denied", "expired_token"] as const) {
      expect(ENLITT_ERROR_CODES[code]).toMatchObject({
        type: "invalid_request_error",
        status: 400,
        retryable: false,
        retryAfter: "forbidden",
        authorizeUrl: "forbidden"
      });
    }
  });

  it("normalizes user codes case-insensitively with or without the hyphen", () => {
    expect(normalizeCliUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeCliUserCode(" BCDF GHJK ")).toBe("BCDF-GHJK");
    expect(normalizeCliUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
    expect(normalizeCliUserCode("ABCD-EFGH")).toBeNull(); // vowels are not in the alphabet
    expect(normalizeCliUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeCliUserCode("BCDF-GHJKL")).toBeNull();
  });

  it("validates the start request strictly and trims the label", () => {
    expect(validateStartCliAuthorizationRequest({ kind: "login", device_label: "  box  " })).toEqual({
      ok: true,
      value: { kind: "login", device_label: "box" }
    });
    expect(validateStartCliAuthorizationRequest({ kind: "step_up", device_label: "x" }).ok).toBe(true);
    for (const body of [
      { kind: "login", device_label: "" },
      { kind: "login", device_label: "   " },
      { kind: "login", device_label: "a".repeat(65) },
      { kind: "login", device_label: "bad\nlabel" },
      { kind: "admin", device_label: "box" },
      { kind: "login", device_label: "box", extra: true },
      { kind: "login" },
      null
    ]) {
      expect(validateStartCliAuthorizationRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
    expect(validateStartCliAuthorizationRequest({ kind: "login", device_label: "a".repeat(64) }).ok).toBe(
      true
    );
  });

  it("validates the started authorization and refuses a malformed user code", () => {
    expect(validateStartedCliAuthorization(started)).toEqual({ ok: true, value: started });
    expect(validateStartedCliAuthorization({ ...started, user_code: "bcdf-ghjk" }).ok).toBe(false);
    expect(validateStartedCliAuthorization({ ...started, device_code: "" }).ok).toBe(false);
    expect(validateStartedCliAuthorization({ ...started, extra: 1 }).ok).toBe(false);
    expect(validateStartedCliAuthorization({ ...started, extra: 1 }, { mode: "tolerant" })).toEqual({
      ok: true,
      value: started
    });
  });

  it("validates the token request strictly", () => {
    expect(validateCliTokenRequest({ device_code: "abc" }).ok).toBe(true);
    expect(validateCliTokenRequest({ device_code: "" }).ok).toBe(false);
    expect(validateCliTokenRequest({ device_code: "a".repeat(257) }).ok).toBe(false);
    expect(validateCliTokenRequest({ device_code: "abc", user_code: "BCDF-GHJK" }).ok).toBe(false);
  });

  it("validates both grant kinds and refuses an unknown kind even when tolerant", () => {
    expect(validateCliTokenGrant(loginGrant)).toEqual({ ok: true, value: loginGrant });
    const stepUp = { kind: "step_up", reauthenticated_at: "2026-10-18T00:00:00Z" };
    expect(validateCliTokenGrant(stepUp)).toEqual({ ok: true, value: stepUp });
    expect(validateCliTokenGrant({ ...loginGrant, kind: "refresh" }, { mode: "tolerant" }).ok).toBe(false);
    expect(validateCliTokenGrant({ ...loginGrant, token: "" }).ok).toBe(false);
    const { login: _login, ...withoutLogin } = loginGrant;
    expect(validateCliTokenGrant(withoutLogin).ok).toBe(false);
    expect(validateCliTokenGrant({ ...loginGrant, extra: 1 }).ok).toBe(false);
  });

  it("validates the authorization view with a nullable business and a tolerant kind", () => {
    const view = {
      user_code: "BCDF-GHJK",
      kind: "login",
      device_label: "laptop",
      expires_at: "2026-10-18T00:10:00Z",
      business: null
    };
    expect(validateCliAuthorizationView(view)).toEqual({ ok: true, value: view });
    const stepUp = { ...view, kind: "step_up", business: { id: "biz_1", name: "Acme" } };
    expect(validateCliAuthorizationView(stepUp).ok).toBe(true);
    expect(validateCliAuthorizationView({ ...view, kind: "future" }).ok).toBe(false);
    expect(validateCliAuthorizationView({ ...view, kind: "future" }, { mode: "tolerant" })).toMatchObject({
      ok: true,
      value: { kind: "other" }
    });
  });

  it("validates the credential list and refuses any token on it", () => {
    const list = { credentials: [credential] };
    expect(validateCliCredentialList(list)).toEqual({ ok: true, value: list });
    expect(validateCliCredentialList({ credentials: [] }).ok).toBe(true);
    expect(validateCliCredentialList({ credentials: [{ ...credential, token: "enl_cli_x" }] }).ok).toBe(false);
    expect(
      validateCliCredentialList({ credentials: [{ ...credential, token: "enl_cli_x" }] }, { mode: "tolerant" }).ok
    ).toBe(false);
    expect(validateCliCredentialList({ credentials: [{ ...credential, expires_at: null }] }).ok).toBe(false);
  });

  it("validates the key-list filters", () => {
    expect(validateBusinessKeyListQuery({})).toEqual({ ok: true, value: {} });
    expect(validateBusinessKeyListQuery({ scope: null, application_id: null })).toEqual({ ok: true, value: {} });
    expect(validateBusinessKeyListQuery({ scope: "model", application_id: "app_1" })).toEqual({
      ok: true,
      value: { scope: "model", application_id: "app_1" }
    });
    expect(validateBusinessKeyListQuery({ application_id: "app_1" })).toEqual({
      ok: true,
      value: { application_id: "app_1" }
    });
    expect(validateBusinessKeyListQuery({ scope: "reporting" })).toEqual({ ok: true, value: { scope: "reporting" } });
    expect(validateBusinessKeyListQuery({ scope: "reporting", application_id: "app_1" })).toMatchObject({
      ok: false,
      error: { code: "invalid_value", param: "application_id" }
    });
    expect(validateBusinessKeyListQuery({ scope: "admin" })).toMatchObject({
      ok: false,
      error: { code: "invalid_value", param: "scope" }
    });
  });
});
