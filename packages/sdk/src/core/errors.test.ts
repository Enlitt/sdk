import { ENLITT_ERROR_CODE, ENLITT_ERROR_CODES, isEnlittErrorCode } from "@enlitt/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EnlittAuthenticationError,
  EnlittAuthorizationError,
  EnlittConfigurationError,
  EnlittError,
  EnlittInsufficientCreditsError,
  EnlittLimitExceededError,
  EnlittLoginRequiredError,
  EnlittRateLimitError,
  EnlittSubscriptionInactiveError,
  normalizeEnlittModelError,
  type EnlittLocalCode
} from "./errors.js";

/** The class each named stable code maps to. Every other record code maps to the base class. */
const CLASS_BY_WIRE_CODE: Record<string, new (...args: never[]) => EnlittError> = {
  personal_login_required: EnlittLoginRequiredError,
  spending_limit_exceeded: EnlittLimitExceededError,
  premium_balance_exhausted: EnlittInsufficientCreditsError,
  standard_balance_exhausted: EnlittInsufficientCreditsError,
  subscription_inactive: EnlittSubscriptionInactiveError,
  rate_limit_exceeded: EnlittRateLimitError,
  invalid_api_key: EnlittAuthenticationError,
  insufficient_permissions: EnlittAuthorizationError,
  premium_not_enabled: EnlittAuthorizationError
};

const LOCAL_CODES: readonly EnlittLocalCode[] = [
  "configuration_invalid",
  "transport_failed",
  "malformed_response",
  "request_canceled"
];

const AUTHORIZE_URL = "https://dashboard.enlitt.example/authorize";

/** Builds the shape the transport hands `normalizeEnlittModelError()` for an HTTP refusal. */
function httpError(
  status: number,
  code: unknown,
  options: {
    type?: string;
    message?: string;
    enlitt?: Record<string, unknown>;
    retryAfter?: string;
    requestId?: string;
  } = {}
): unknown {
  return {
    kind: "http_error",
    status,
    body: {
      error: {
        message: options.message ?? `refused: ${String(code)}`,
        type: options.type ?? "api_error",
        param: null,
        code,
        ...(options.enlitt !== undefined ? { enlitt: options.enlitt } : {})
      }
    },
    headers: {
      ...(options.retryAfter !== undefined ? { "retry-after": options.retryAfter } : {}),
      ...(options.requestId !== undefined ? { "x-request-id": options.requestId } : {})
    }
  };
}

/** Builds a refusal for a record code, filling every extension the record requires or allows. */
function recordHttpError(code: keyof typeof ENLITT_ERROR_CODES, extras: { withAuthorizeUrl?: boolean } = {}): unknown {
  const definition = ENLITT_ERROR_CODES[code];
  return httpError(definition.status, code, {
    type: definition.type,
    requestId: "req_123",
    ...(definition.retryAfter === "required" ? { retryAfter: "7" } : {}),
    enlitt: {
      ...(extras.withAuthorizeUrl === true ? { authorize_url: AUTHORIZE_URL } : {}),
      ...(definition.limitRule === "required" ? { limit_rule: "premium_per_call" } : {}),
      ...(definition.admissibleMaxCharge === "allowed" ? { admissible_max_charge_nano_usd: "12345" } : {})
    }
  });
}

describe("EnlittLocalCode", () => {
  it("is disjoint from the protocol record's codes", () => {
    for (const local of LOCAL_CODES) {
      expect(Object.hasOwn(ENLITT_ERROR_CODES, local)).toBe(false);
    }
  });

  it("every locally raised error carries a local code and providerInvoked: false", () => {
    for (const local of LOCAL_CODES) {
      const err = normalizeEnlittModelError({ kind: local }, false);
      expect(LOCAL_CODES).toContain(err.code);
      expect(err.providerInvoked).toBe(false);
      expect(err.retryable).toBe(false);
    }
    const configError = new EnlittConfigurationError("bad config");
    expect(configError.code).toBe("configuration_invalid");
    expect(configError.providerInvoked).toBe(false);
    expect(configError.retryable).toBe(false);
  });
});

describe("named wire code classes", () => {
  it("maps each named stable code to exactly one class", () => {
    for (const [code, expectedClass] of Object.entries(CLASS_BY_WIRE_CODE)) {
      const err = normalizeEnlittModelError(recordHttpError(code as keyof typeof ENLITT_ERROR_CODES), false);
      expect(err, code).toBeInstanceOf(expectedClass);
      expect(err.code).toBe(code);
    }
  });

  it("copies the raw limit rule onto EnlittLimitExceededError", () => {
    const err = normalizeEnlittModelError(
      httpError(403, "spending_limit_exceeded", {
        type: "insufficient_credits_error",
        enlitt: { limit_rule: "rate.premium" }
      }),
      false
    );
    expect(err).toBeInstanceOf(EnlittLimitExceededError);
    expect((err as EnlittLimitExceededError).limitRule).toBe("rate.premium");
  });

  it("keeps the credit classes apart and never makes the rate-limit class a credit refusal", () => {
    const rate = normalizeEnlittModelError(recordHttpError("rate_limit_exceeded"), false);
    expect(rate).toBeInstanceOf(EnlittRateLimitError);
    expect(rate).not.toBeInstanceOf(EnlittInsufficientCreditsError);
    expect(rate.retryAfterMs).toBe(7000);
  });

  it("carries admissibleMaxChargeNanoUsd byte for byte on premium_balance_exhausted only", () => {
    const premium = normalizeEnlittModelError(recordHttpError("premium_balance_exhausted"), false);
    expect((premium as EnlittInsufficientCreditsError).admissibleMaxChargeNanoUsd).toBe("12345");

    const standard = normalizeEnlittModelError(
      httpError(402, "standard_balance_exhausted", {
        type: "insufficient_credits_error",
        enlitt: { admissible_max_charge_nano_usd: "12345" }
      }),
      false
    );
    expect((standard as EnlittInsufficientCreditsError).admissibleMaxChargeNanoUsd).toBeUndefined();
  });
});

describe("the protocol record, iterated rather than listed", () => {
  it("maps every record code with the record's retryability, requestId, and providerInvoked false", () => {
    for (const code of Object.keys(ENLITT_ERROR_CODES) as (keyof typeof ENLITT_ERROR_CODES)[]) {
      const definition = ENLITT_ERROR_CODES[code];
      const err = normalizeEnlittModelError(recordHttpError(code), true);

      expect(err, code).toBeInstanceOf(EnlittError);
      expect(err.code).toBe(code);
      expect(err.providerInvoked).toBe(false);
      expect(err.retryable).toBe(definition.retryable);
      expect(err.requestId).toBe("req_123");

      const expectedClass = CLASS_BY_WIRE_CODE[code];
      if (expectedClass !== undefined) {
        expect(err, code).toBeInstanceOf(expectedClass);
      } else {
        // Every other record code is carried by the base class itself.
        expect(Object.getPrototypeOf(err), code).toBe(EnlittError.prototype);
      }

      if (definition.retryAfter === "required") {
        expect(err.retryAfterMs).toBe(7000);
      } else {
        expect(err.retryAfterMs).toBeUndefined();
      }
    }
  });

  it("names no class for a code the record does not declare", () => {
    for (const code of Object.keys(CLASS_BY_WIRE_CODE)) {
      expect(isEnlittErrorCode(code)).toBe(true);
    }
  });

  it("populates authorizeUrl exactly where the record allows it, even when a response supplies one everywhere", () => {
    for (const code of Object.keys(ENLITT_ERROR_CODES) as (keyof typeof ENLITT_ERROR_CODES)[]) {
      const err = normalizeEnlittModelError(recordHttpError(code, { withAuthorizeUrl: true }), false);
      if (ENLITT_ERROR_CODES[code].authorizeUrl === "allowed") {
        expect(err.authorizeUrl, code).toBe(AUTHORIZE_URL);
      } else {
        expect(err.authorizeUrl, code).toBeUndefined();
      }
    }
  });

  it("reports non-retryable for every code except rate_limit_exceeded and the retryable 5xx codes", () => {
    for (const [code, definition] of Object.entries(ENLITT_ERROR_CODES)) {
      const mayRetry = code === "rate_limit_exceeded" || (definition.retryable && definition.status >= 500);
      expect(definition.retryable, code).toBe(mayRetry);
    }
    // The three 409 conflicts are explicitly non-retryable, so a configured
    // maxRetries cannot multiply a single refusal.
    for (const conflict of ["conflict_error", "operation_in_progress", "idempotency_replay_unavailable"] as const) {
      expect(ENLITT_ERROR_CODES[conflict].retryable).toBe(false);
      expect(ENLITT_ERROR_CODES[conflict].status).toBe(409);
    }
  });

  it("keys the mapping on the stable code, not the status", () => {
    // A 429 carrying another code is not the rate-limit class.
    const err = normalizeEnlittModelError(httpError(429, "brand_new_refusal"), false);
    expect(err).not.toBeInstanceOf(EnlittRateLimitError);
    expect(Object.getPrototypeOf(err)).toBe(EnlittError.prototype);
  });
});

describe("unrecognized codes from a newer server", () => {
  it("classifies by status: 5xx is retryable, every other status is not", () => {
    expect(normalizeEnlittModelError(httpError(503, "brand_new_refusal"), false).retryable).toBe(true);
    for (const status of [400, 402, 429]) {
      const err = normalizeEnlittModelError(httpError(status, "brand_new_refusal"), false);
      expect(err.retryable, String(status)).toBe(false);
      expect(Object.getPrototypeOf(err)).toBe(EnlittError.prototype);
    }
  });

  it("treats an insufficient_credits_error type as a credit refusal at any status, copying only a safe authorize URL", () => {
    for (const status of [402, 403]) {
      const err = normalizeEnlittModelError(
        httpError(status, "future_credit_refusal", {
          type: "insufficient_credits_error",
          enlitt: { authorize_url: AUTHORIZE_URL }
        }),
        false
      );
      expect(err).toBeInstanceOf(EnlittInsufficientCreditsError);
      expect(err.code).toBe("future_credit_refusal");
      expect(err.authorizeUrl).toBe(AUTHORIZE_URL);
      expect(err.retryable).toBe(false);
    }

    const unsafe = normalizeEnlittModelError(
      httpError(402, "future_credit_refusal", {
        type: "insufficient_credits_error",
        enlitt: { authorize_url: "http://evil.example/authorize" }
      }),
      false
    );
    expect(unsafe).toBeInstanceOf(EnlittInsufficientCreditsError);
    expect(unsafe.authorizeUrl).toBeUndefined();
  });

  it("never makes a 429 unknown code a rate-limit error and ignores Retry-After on it", () => {
    const err = normalizeEnlittModelError(httpError(429, "brand_new_refusal", { retryAfter: "2" }), false);
    expect(err).not.toBeInstanceOf(EnlittRateLimitError);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("uses the specified upgrade message followed by the server message, and attaches the request id", () => {
    const err = normalizeEnlittModelError(
      httpError(409, "brand_new_refusal", { type: "invalid_request_error", message: "Server words.", requestId: "req_9" }),
      false
    );
    expect(err.message).toBe(
      'Enlitt returned error code "brand_new_refusal" (HTTP 409, type "invalid_request_error"), ' +
        "which this version of @enlitt/sdk does not recognize. Upgrade @enlitt/sdk to handle it. Server words."
    );
    expect(err.requestId).toBe("req_9");
  });

  it('maps a null, numeric, or pattern-violating code to "unrecognized"', () => {
    for (const code of [null, 7, "Bad-Code"]) {
      const err = normalizeEnlittModelError(httpError(500, code), false);
      expect(err.code).toBe("unrecognized");
    }
  });

  it("maps an HTML, empty, or array body to malformed_response without throwing", () => {
    for (const body of ["<html>Bad gateway</html>", "", [], null]) {
      const err = normalizeEnlittModelError({ kind: "http_error", status: 502, body, headers: {} }, false);
      expect(err.code).toBe("malformed_response");
      expect(err.providerInvoked).toBe(false);
    }
  });

  it("keeps every record code recognized, so the known mapping is unchanged", () => {
    for (const code of Object.keys(ENLITT_ERROR_CODES) as (keyof typeof ENLITT_ERROR_CODES)[]) {
      const err = normalizeEnlittModelError(recordHttpError(code), false);
      expect(err.message, code).not.toContain("does not recognize");
    }
  });

  it("types code as an open string so a business switch needs a default branch", () => {
    expectTypeOf<string>().toMatchTypeOf<EnlittError["code"]>();
  });
});

describe("no error class exposes more than the specified numeric facts", () => {
  it("has no enumerable own numeric property beyond retryAfterMs, and no digits in a message", () => {
    const instances: EnlittError[] = [
      new EnlittError(ENLITT_ERROR_CODE.server_error, "boom"),
      new EnlittConfigurationError("bad config"),
      new EnlittLoginRequiredError("log in"),
      new EnlittLimitExceededError("over limit", "premium_per_call"),
      new EnlittInsufficientCreditsError(ENLITT_ERROR_CODE.premium_balance_exhausted, "exhausted"),
      new EnlittSubscriptionInactiveError("inactive"),
      new EnlittRateLimitError("slow down", { retryAfterMs: 5000 }),
      new EnlittAuthenticationError("bad key"),
      new EnlittAuthorizationError("out of scope")
    ];

    for (const instance of instances) {
      for (const [key, value] of Object.entries(instance)) {
        if (typeof value === "number") {
          expect(key).toBe("retryAfterMs");
        }
      }
      expect(instance.message).not.toMatch(/\d/);
    }
  });
});

describe("normalizeEnlittModelError", () => {
  it("maps transport failure, malformed response, and cancellation to the base class with a local code", () => {
    expect(normalizeEnlittModelError({ kind: "transport_failed" }, false).code).toBe("transport_failed");
    expect(normalizeEnlittModelError({ kind: "malformed_response" }, false).code).toBe("malformed_response");
    expect(normalizeEnlittModelError({ kind: "request_canceled" }, false).code).toBe("request_canceled");
    expect(normalizeEnlittModelError("not an object", false).code).toBe("malformed_response");
  });

  it("reports providerInvoked: false for every Enlitt refusal regardless of the passed flag", () => {
    expect(normalizeEnlittModelError(recordHttpError("server_error"), true).providerInvoked).toBe(false);
  });

  it("keeps the audience split: configuration and authentication errors carry no remediation facts", () => {
    expect(new EnlittConfigurationError("bad config").authorizeUrl).toBeUndefined();
    for (const code of ["invalid_api_key", "personal_login_required"] as const) {
      const err = normalizeEnlittModelError(recordHttpError(code, { withAuthorizeUrl: true }), false);
      expect(err.authorizeUrl, code).toBeUndefined();
    }
  });

  it("redacts nothing sensitive because none was provided: no credential-shaped text in an authentication message", () => {
    const err = normalizeEnlittModelError(recordHttpError("invalid_api_key"), false);
    expect(err.message).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
  });
});
