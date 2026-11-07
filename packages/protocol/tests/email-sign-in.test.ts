/**
 * `specs/PROTOCOLS.md` "Email sign-in": both request shapes, both response
 * shapes, and the one refusal code the verify route adds.
 */
import { describe, expect, it } from "vitest";

import {
  validateEmailSignInCompleted,
  validateEmailSignInSendRequest,
  validateEmailSignInSent,
  validateEmailSignInVerifyRequest
} from "../src/dashboard.js";
import { ENLITT_ERROR_CODE, getEnlittErrorDefinition } from "../src/errors.js";

describe("validateEmailSignInSendRequest", () => {
  it("accepts an address and either account type", () => {
    for (const accountType of ["user", "business"]) {
      const result = validateEmailSignInSendRequest({ email: "a@example.com", account_type: accountType });
      expect(result).toEqual({ ok: true, value: { email: "a@example.com", account_type: accountType } });
    }
  });

  it("refuses an address longer than 254 characters and accepts one of exactly 254", () => {
    const domain = "@example.com";
    const exact = `${"a".repeat(254 - domain.length)}${domain}`;
    expect(validateEmailSignInSendRequest({ email: exact, account_type: "user" }).ok).toBe(true);
    const tooLong = `a${exact}`;
    const result = validateEmailSignInSendRequest({ email: tooLong, account_type: "user" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "invalid_value", param: "email" });
  });

  it.each(["", "plain", "@example.com", "a@", "a@b", "a b@example.com", "a@@example.com", "a@example..com", 42])(
    "refuses the malformed address %j",
    (email) => {
      const result = validateEmailSignInSendRequest({ email, account_type: "user" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "invalid_value", param: "email" });
    }
  );

  it("refuses any account type other than the two members", () => {
    for (const accountType of ["personal", "admin", "", undefined]) {
      const result = validateEmailSignInSendRequest({ email: "a@example.com", account_type: accountType });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.param).toBe("account_type");
    }
  });

  it("refuses a password, a redirect target, or any other extra field", () => {
    for (const extra of ["password", "redirect_uri", "return_to", "code"]) {
      const result = validateEmailSignInSendRequest({
        email: "a@example.com",
        account_type: "user",
        [extra]: "x"
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "unsupported_parameter", param: extra });
    }
  });
});

describe("validateEmailSignInVerifyRequest", () => {
  it("accepts a six-digit code and keeps its leading zeros", () => {
    const result = validateEmailSignInVerifyRequest({
      email: "a@example.com",
      account_type: "business",
      code: "000123"
    });
    expect(result).toEqual({
      ok: true,
      value: { email: "a@example.com", account_type: "business", code: "000123" }
    });
  });

  it.each(["12345", "1234567", "12345a", " 123456", "１２３４５６", "", 123456])(
    "refuses the malformed code %j",
    (code) => {
      const result = validateEmailSignInVerifyRequest({ email: "a@example.com", account_type: "user", code });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "invalid_value", param: "code" });
    }
  );
});

describe("email sign-in responses", () => {
  it("validates the send response", () => {
    expect(validateEmailSignInSent({ status: "sent", resend_after_seconds: 60 }).ok).toBe(true);
    expect(validateEmailSignInSent({ status: "queued", resend_after_seconds: 60 }).ok).toBe(false);
    expect(validateEmailSignInSent({ status: "sent" }).ok).toBe(false);
  });

  it("validates the verify response", () => {
    expect(
      validateEmailSignInCompleted({
        status: "signed_in",
        account_type: "user",
        registered: false,
        phone_verification_required: true
      }).ok
    ).toBe(true);
    expect(
      validateEmailSignInCompleted({
        status: "signed_in",
        account_type: "user",
        registered: "no",
        phone_verification_required: true
      }).ok
    ).toBe(false);
  });
});

describe("invalid_sign_in_code", () => {
  it("is a non-retryable 400 invalid_request_error with no Retry-After or authorize_url", () => {
    expect(getEnlittErrorDefinition(ENLITT_ERROR_CODE.invalid_sign_in_code)).toEqual({
      type: "invalid_request_error",
      status: 400,
      retryable: false,
      retryAfter: "forbidden",
      authorizeUrl: "forbidden",
      admissibleMaxCharge: "forbidden",
      limitRule: "forbidden"
    });
  });
});
