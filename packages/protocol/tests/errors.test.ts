import { describe, expect, it } from "vitest";

import {
  classifyEnlittErrorResponse,
  ENLITT_ERROR_CODE,
  ENLITT_ERROR_CODE_NAMES,
  ENLITT_ERROR_CODES,
  ENLITT_ERROR_TYPES,
  EnlittErrorContractViolation,
  getEnlittErrorDefinition,
  isEnlittErrorCode,
  renderEnlittError
} from "../src/errors.js";

function openAiEnvelope(
  code: unknown,
  type = "server_error",
  extension?: Record<string, unknown>
): unknown {
  return {
    error: {
      message: "A stable error message.",
      type,
      param: null,
      code,
      ...(extension === undefined ? {} : { enlitt: extension })
    }
  };
}

describe("the stable error record", () => {
  it("gives every code all seven immutable properties", () => {
    for (const code of ENLITT_ERROR_CODE_NAMES) {
      const definition = getEnlittErrorDefinition(code);
      expect(ENLITT_ERROR_TYPES).toContain(definition.type);
      expect(Number.isInteger(definition.status)).toBe(true);
      expect(["required", "forbidden"]).toContain(definition.retryAfter);
      expect(["allowed", "forbidden"]).toContain(definition.authorizeUrl);
      expect(["allowed", "forbidden"]).toContain(definition.admissibleMaxCharge);
      expect(["required", "forbidden"]).toContain(definition.limitRule);
      expect(Object.isFrozen(ENLITT_ERROR_CODES[code])).toBe(true);
    }
    expect(Object.isFrozen(ENLITT_ERROR_CODES)).toBe(true);
  });

  it("uses spending_limit_exceeded instead of retired routing and per-call codes", () => {
    expect(isEnlittErrorCode("spending_limit_exceeded")).toBe(true);
    expect(isEnlittErrorCode("premium_per_call_limit_exceeded")).toBe(false);
    expect(isEnlittErrorCode("no_capable_route")).toBe(false);
    expect(isEnlittErrorCode("unrecognized")).toBe(false);
    expect(isEnlittErrorCode("other")).toBe(false);
    expect(getEnlittErrorDefinition("spending_limit_exceeded")).toMatchObject({
      type: "insufficient_credits_error",
      status: 403,
      retryable: false,
      authorizeUrl: "allowed",
      admissibleMaxCharge: "forbidden",
      limitRule: "required"
    });
    expect(getEnlittErrorDefinition("premium_balance_exhausted").admissibleMaxCharge).toBe("allowed");
  });

  it("keeps only rate limiting and the two 5xx codes retryable", () => {
    const retryable = ENLITT_ERROR_CODE_NAMES.filter((code) => ENLITT_ERROR_CODES[code].retryable);
    expect(retryable.sort()).toEqual(["provider_error", "rate_limit_exceeded", "server_error"]);
    expect(ENLITT_ERROR_CODES.rate_limit_exceeded.retryAfter).toBe("required");
  });

  it("maps each key to itself through the public code record", () => {
    for (const code of ENLITT_ERROR_CODE_NAMES) expect(ENLITT_ERROR_CODE[code]).toBe(code);
  });
});

describe("renderEnlittError", () => {
  it("renders the spending-rule extension and no unpermitted extension", () => {
    const rendered = renderEnlittError({
      code: "spending_limit_exceeded",
      message: "The authorization refused this reservation.",
      authorizeUrl: "https://enlitt.example/authorize/app_1",
      limitRule: "rate.premium"
    });

    expect(rendered).toMatchObject({ status: 403, retryable: false, headers: {} });
    expect(rendered.body.error).toEqual({
      message: "The authorization refused this reservation.",
      type: "insufficient_credits_error",
      param: null,
      code: "spending_limit_exceeded",
      enlitt: {
        authorize_url: "https://enlitt.example/authorize/app_1",
        limit_rule: "rate.premium"
      }
    });
  });

  it("requires the record-mandated amount and rule, validates the amount, and rejects foreign fields", () => {
    expect(() => renderEnlittError({ code: "premium_balance_exhausted", message: "No capacity." })).toThrow(
      EnlittErrorContractViolation
    );
    expect(() =>
      renderEnlittError({
        code: "premium_balance_exhausted",
        message: "No capacity.",
        admissibleMaxChargeNanoUsd: "01"
      })
    ).toThrow(EnlittErrorContractViolation);
    expect(() => renderEnlittError({ code: "spending_limit_exceeded", message: "No." })).toThrow(
      EnlittErrorContractViolation
    );
    expect(() =>
      renderEnlittError({
        code: "standard_balance_exhausted",
        message: "No capacity.",
        admissibleMaxChargeNanoUsd: "0"
      })
    ).toThrow(EnlittErrorContractViolation);
  });

  it("renders the one Retry-After floor and rejects it on every other code", () => {
    expect(
      renderEnlittError({ code: "rate_limit_exceeded", message: "Slow down.", retryAfterSeconds: 2 }).headers
    ).toEqual({ "retry-after": "2" });
    expect(() =>
      renderEnlittError({ code: "server_error", message: "Retry later.", retryAfterSeconds: 2 })
    ).toThrow(EnlittErrorContractViolation);
  });
});

describe("classifyEnlittErrorResponse", () => {
  it("uses the frozen record for every recognized error", () => {
    for (const code of ENLITT_ERROR_CODE_NAMES) {
      const definition = ENLITT_ERROR_CODES[code];
      const extension: Record<string, unknown> = {};
      if (definition.authorizeUrl === "allowed") extension.authorize_url = "https://enlitt.example/authorize";
      if (definition.admissibleMaxCharge === "allowed") extension.admissible_max_charge_nano_usd = "0";
      if (definition.limitRule === "required") extension.limit_rule = "premium_per_call";
      const classified = classifyEnlittErrorResponse(
        definition.status,
        openAiEnvelope(code, definition.type, extension)
      );
      expect(classified).toMatchObject({
        code,
        recognized: true,
        retryable: definition.retryable,
        creditRefusal: definition.type === "insufficient_credits_error"
      });
    }
  });

  it("requires a valid limit rule for the recorded spending refusal", () => {
    expect(
      classifyEnlittErrorResponse(
        403,
        openAiEnvelope("spending_limit_exceeded", "insufficient_credits_error")
      )
    ).toBeNull();
    expect(
      classifyEnlittErrorResponse(
        403,
        openAiEnvelope("spending_limit_exceeded", "insufficient_credits_error", { limit_rule: "rate.standard" })
      )?.limitRule
    ).toBe("rate.standard");
  });

  it("classifies unknown codes by type and status and retains only safe authorize URLs", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyEnlittErrorResponse(status, openAiEnvelope("future_error"))?.retryable).toBe(true);
    }
    for (const status of [400, 404, 409, 429]) {
      expect(classifyEnlittErrorResponse(status, openAiEnvelope("future_error"))?.retryable).toBe(false);
    }
    const credit = classifyEnlittErrorResponse(
      503,
      openAiEnvelope("future_credit_refusal", "insufficient_credits_error", {
        authorize_url: "http://localhost:3000/authorize"
      })
    );
    expect(credit).toMatchObject({ recognized: false, retryable: false, creditRefusal: true });
    expect(credit?.authorizeUrl).toBe("http://localhost:3000/authorize");
    for (const url of ["http://example.com/authorize", "/authorize", "javascript:alert(1)"]) {
      expect(
        classifyEnlittErrorResponse(
          403,
          openAiEnvelope("future_credit_refusal", "insufficient_credits_error", { authorize_url: url })
        )?.authorizeUrl
      ).toBeUndefined();
    }
  });

  it("uses the reserved code for malformed codes and supports dashboard envelopes", () => {
    for (const code of [undefined, null, 1, "Bad-Code"]) {
      expect(classifyEnlittErrorResponse(500, openAiEnvelope(code))?.code).toBe("unrecognized");
    }
    expect(
      classifyEnlittErrorResponse(503, {
        error: { code: "future_dashboard_error", message: "No type here." },
        request_id: "req_123"
      })
    ).toMatchObject({ type: null, creditRefusal: false, retryable: true });
  });

  it("rejects non-envelopes and truncates a message without changing it", () => {
    expect(classifyEnlittErrorResponse(502, "<html>bad gateway</html>")).toBeNull();
    expect(classifyEnlittErrorResponse(502, [])).toBeNull();
    const message = "x".repeat(600);
    expect(classifyEnlittErrorResponse(500, { error: { message, type: "server_error", param: null, code: "future" } })?.message)
      .toHaveLength(512);
  });
});
