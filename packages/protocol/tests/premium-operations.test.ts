import { describe, expect, it } from "vitest";

import { ENLITT_ERROR_CODE } from "../src/errors.js";
import {
  PREMIUM_OPERATION_MAX_CHARGE_NANO_USD,
  validateBeginPremiumOperationRequest,
  validateBeginPremiumOperationResponse,
  validateReportPremiumTerminalRequest,
  validateReportPremiumTerminalResponse
} from "../src/premium-operations.js";

function beginRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "premium",
    max_charge_nano_usd: "1000",
    provider: { id: "openai", model: "gpt-5" },
    ...overrides
  };
}

function terminalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { report_id: "report-id-123456", status: "completed", charge_nano_usd: "1000", ...overrides };
}

describe("premium operation begin request", () => {
  it("accepts the documented content-free request", () => {
    const result = validateBeginPremiumOperationRequest(
      beginRequest({ reporting_deadline_ms: 1, metadata: { invoice: "42" } })
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("uses the shared string-only metadata validator", () => {
    expect(validateBeginPremiumOperationRequest(beginRequest({ metadata: { count: 1 } })).ok).toBe(false);
    expect(validateBeginPremiumOperationRequest(beginRequest({ metadata: { enlitt_internal: "no" } })).ok).toBe(false);
  });

  it("rejects unknown, legacy, and content-carrying fields", () => {
    for (const field of ["charge", "reported_nano_usd", "prompt", "output", "provider_key", "content_hash"]) {
      const result = validateBeginPremiumOperationRequest(beginRequest({ [field]: "forbidden" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({ code: ENLITT_ERROR_CODE.unsupported_parameter, param: field });
      }
    }
  });

  it("requires canonical maximums within the deployed policy maximum", () => {
    for (const amount of [1, "01", "-1", "1.5", "1e3", " 1"]) {
      expect(validateBeginPremiumOperationRequest(beginRequest({ max_charge_nano_usd: amount })).ok).toBe(false);
    }
    expect(validateBeginPremiumOperationRequest(beginRequest({ max_charge_nano_usd: PREMIUM_OPERATION_MAX_CHARGE_NANO_USD })).ok).toBe(true);
    expect(validateBeginPremiumOperationRequest(beginRequest({ max_charge_nano_usd: "100000000001" })).ok).toBe(false);
  });

  it("rejects unknown nested provider fields and invalid deadlines", () => {
    expect(validateBeginPremiumOperationRequest(beginRequest({ provider: { id: "a", model: "b", key: "no" } })).ok).toBe(false);
    expect(validateBeginPremiumOperationRequest(beginRequest({ reporting_deadline_ms: 0 })).ok).toBe(false);
    expect(validateBeginPremiumOperationRequest(beginRequest({ reporting_deadline_ms: 1.5 })).ok).toBe(false);
  });
});

describe("premium operation begin response", () => {
  const response = {
    operation_id: "op_1",
    billing: "managed",
    report_terminal: true,
    effective_max_charge_nano_usd: "1000",
    reserved_nano_usd: "1000",
    terminal_deadline: "2026-09-29T12:00:00Z"
  };

  it("accepts only the documented response fields", () => {
    expect(validateBeginPremiumOperationResponse(response).ok).toBe(true);
    expect(validateBeginPremiumOperationResponse({ ...response, credit_units: "1" }).ok).toBe(false);
    expect(validateBeginPremiumOperationResponse({ ...response, reserved_nano_usd: "001" }).ok).toBe(false);
  });

  it("drops future fields and maps future billing tolerantly", () => {
    const future = { ...response, billing: "delegated", future: true };
    expect(validateBeginPremiumOperationResponse(future).ok).toBe(false);
    expect(validateBeginPremiumOperationResponse(future, { mode: "tolerant" })).toEqual({
      ok: true,
      value: { ...response, billing: "other" }
    });
  });
});

describe("premium terminal request", () => {
  it("accepts every safe optional operational fact", () => {
    const result = validateReportPremiumTerminalRequest(
      terminalRequest({
        usage: { input_tokens: 1, output_tokens: 2, cached_input_tokens: 0, reasoning_tokens: 3 },
        finish_reason: "length",
        provider_response_id: "response_1",
        delivery: { output_started: true, output_completed: false },
        timing: { started_at: "2026-09-29T12:00:00Z", ended_at: "2026-09-29T12:00:01Z" },
        error_category: "provider"
      })
    );
    expect(result.ok).toBe(true);
  });

  it("accepts canceled and failed reports, including a nonzero failed reported charge", () => {
    expect(validateReportPremiumTerminalRequest(terminalRequest({ status: "canceled" })).ok).toBe(true);
    expect(validateReportPremiumTerminalRequest(terminalRequest({ status: "failed", charge_nano_usd: "7" })).ok).toBe(true);
  });

  it("rejects incomplete as unsupported and malformed charges as invalid", () => {
    const incomplete = validateReportPremiumTerminalRequest(terminalRequest({ status: "incomplete" }));
    expect(incomplete).toMatchObject({ ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_value, param: "status" } });
    expect(validateReportPremiumTerminalRequest(terminalRequest({ charge_nano_usd: "1".repeat(31) })).ok).toBe(false);
    expect(validateReportPremiumTerminalRequest(terminalRequest({ charge_nano_usd: "01" })).ok).toBe(false);
  });

  it("rejects unknown nested facts and content/raw-provider fields", () => {
    const nested = validateReportPremiumTerminalRequest(terminalRequest({ usage: { input_tokens: 1, cost: 2 } }));
    expect(nested).toMatchObject({ ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_parameter, param: "usage.cost" } });
    const legacy = validateReportPremiumTerminalRequest(terminalRequest({ reported_nano_usd: "1" }));
    expect(legacy).toMatchObject({ ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_parameter, param: "reported_nano_usd" } });
  });
});

describe("premium terminal response", () => {
  const response = {
    operation_id: "op_1",
    status: "completed",
    idempotent_replay: false,
    settlement: {
      captured_nano_usd: "700",
      released_nano_usd: "300",
      business_earnings_nano_usd: "700"
    }
  };

  it("validates the exact settlement response including replay", () => {
    expect(validateReportPremiumTerminalResponse(response).ok).toBe(true);
    expect(validateReportPremiumTerminalResponse({ ...response, transaction_id: "tx_1" }).ok).toBe(false);
    expect(validateReportPremiumTerminalResponse({ ...response, settlement: { ...response.settlement, fee: "0" } }).ok).toBe(false);
  });

  it("drops future fields and maps future status tolerantly", () => {
    const future = { ...response, status: "expired", future: true, settlement: { ...response.settlement, future: true } };
    expect(validateReportPremiumTerminalResponse(future).ok).toBe(false);
    expect(validateReportPremiumTerminalResponse(future, { mode: "tolerant" })).toEqual({
      ok: true,
      value: { ...response, status: "other" }
    });
  });
});
