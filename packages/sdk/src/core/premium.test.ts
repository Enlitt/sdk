import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENLITT_API_VERSION } from "@enlitt/protocol";
import {
  EnlittAuthorizationError,
  EnlittConfigurationError,
  EnlittInsufficientCreditsError,
  EnlittError
} from "./errors.js";
import { withPremiumCharge } from "./premium.js";

// Premium lifecycle tests: one begin, the callback, exactly one terminal
// report. Only `fetch` is mocked; Enlitt's real request building runs.

const BASE_URL = "https://api.enlitt.test";
const OPTIONS = {
  secretKey: "sk_test_1234567890",
  baseUrl: BASE_URL,
  session: { token: "session-token-123" },
  provider: { id: "openai", model: "gpt-5" },
  maxCharge: "1000"
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function admitted(effectiveMax = "1000"): Response {
  return jsonResponse(200, {
    operation_id: "op_1",
    billing: "managed",
    report_terminal: true,
    effective_max_charge_nano_usd: effectiveMax,
    reserved_nano_usd: effectiveMax,
    terminal_deadline: "2026-09-29T12:00:00Z"
  });
}

function settled(): Response {
  return jsonResponse(200, {
    operation_id: "op_1",
    status: "completed",
    idempotent_replay: false,
    settlement: { captured_nano_usd: "0", released_nano_usd: "0", business_earnings_nano_usd: "0" }
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The JSON bodies of every request, in order. */
function bodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>);
}

function urls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("withPremiumCharge()", () => {
  it("begins with the declared maximum, runs once, and sends one completed report with the last charge", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const run = vi.fn(async (charge: (amount: string) => void) => {
      charge("400");
      charge("700");
      return "answer";
    });

    await expect(withPremiumCharge(OPTIONS, run)).resolves.toBe("answer");

    expect(run).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual([`${BASE_URL}/v1/enlitt/operations`, `${BASE_URL}/v1/enlitt/operations/op_1/terminal`]);
    const [begin, report] = bodies();
    expect(begin).toMatchObject({ mode: "premium", max_charge_nano_usd: "1000", provider: { id: "openai", model: "gpt-5" } });
    expect(report).toMatchObject({ status: "completed", charge_nano_usd: "700" });
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("enlitt-version")).toBe(ENLITT_API_VERSION);
  });

  it("charges zero when the callback never calls charge()", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await withPremiumCharge(OPTIONS, async () => "ok");
    expect(bodies()[1]).toMatchObject({ status: "completed", charge_nano_usd: "0" });
  });

  it("lowers an over-maximum charge to the server's effective maximum without an error", async () => {
    fetchMock.mockResolvedValueOnce(admitted("500")).mockResolvedValueOnce(settled());
    await withPremiumCharge(OPTIONS, async (charge) => {
      charge("900");
    });
    expect(bodies()[1]).toMatchObject({ charge_nano_usd: "500" });
  });

  it("hands the callback the effective maximum from the begin response", async () => {
    fetchMock.mockResolvedValueOnce(admitted("500")).mockResolvedValueOnce(settled());
    let seen: string | undefined;
    await withPremiumCharge(OPTIONS, async (_charge, operation) => {
      seen = operation.effectiveMaxChargeNanoUsd;
    });
    expect(seen).toBe("500");
  });

  it("reports a thrown callback as failed with zero charge and rethrows the original error", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const boom = new Error("provider exploded");
    await expect(
      withPremiumCharge(OPTIONS, async (charge) => {
        charge("900");
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(bodies()[1]).toMatchObject({ status: "failed", charge_nano_usd: "0" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a callback that rejects while the signal is aborted as canceled, keeping the recorded charge", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const controller = new AbortController();
    await expect(
      withPremiumCharge({ ...OPTIONS, signal: controller.signal }, async (charge) => {
        charge("300");
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      })
    ).rejects.toThrow();
    expect(bodies()[1]).toMatchObject({ status: "canceled", charge_nano_usd: "300" });
  });

  it("never runs the callback when begin is refused, and surfaces the typed error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(402, {
        error: { message: "no balance", type: "insufficient_quota", param: null, code: "premium_balance_exhausted" }
      })
    );
    const run = vi.fn();
    const thrown: unknown = await withPremiumCharge(OPTIONS, run).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(EnlittInsufficientCreditsError);
    expect(run).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The application's premium switch (owner decision 2026-10-25).
  const PREMIUM_OFF = {
    error: {
      message: "Premium credit is not enabled for this application.",
      type: "permission_error",
      param: null,
      code: "premium_not_enabled"
    }
  };

  it("never runs the callback when the premium switch is off at begin, and surfaces EnlittAuthorizationError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, PREMIUM_OFF));
    const run = vi.fn();
    const thrown: unknown = await withPremiumCharge(OPTIONS, run).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(EnlittAuthorizationError);
    expect((thrown as EnlittError).code).toBe("premium_not_enabled");
    expect(run).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands a terminal report blocked by the premium switch to onTerminalReportError as EnlittAuthorizationError", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(jsonResponse(403, PREMIUM_OFF));
    const onTerminalReportError = vi.fn();
    await expect(
      withPremiumCharge({ ...OPTIONS, onTerminalReportError }, async (charge) => {
        charge("500");
        return "kept";
      })
    ).resolves.toBe("kept");
    const reported = onTerminalReportError.mock.calls[0]![0] as EnlittError;
    expect(reported).toBeInstanceOf(EnlittAuthorizationError);
    expect(reported.code).toBe("premium_not_enabled");
  });

  it("does not turn an undeliverable terminal report into a thrown error, and hands it to onTerminalReportError", async () => {
    fetchMock
      .mockResolvedValueOnce(admitted())
      .mockResolvedValueOnce(
        jsonResponse(409, { error: { message: "conflict", type: "invalid_request_error", param: null, code: "conflict_error" } })
      );
    const onTerminalReportError = vi.fn();
    await expect(withPremiumCharge({ ...OPTIONS, onTerminalReportError }, async () => "kept")).resolves.toBe("kept");
    expect(onTerminalReportError).toHaveBeenCalledTimes(1);
    expect(onTerminalReportError.mock.calls[0]![0]).toBeInstanceOf(EnlittError);
  });

  it("rejects charge() after the report was sent", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    let late: ((amount: string) => void) | undefined;
    await withPremiumCharge(OPTIONS, async (charge) => {
      late = charge;
    });
    expect(() => late!("5")).toThrow(EnlittConfigurationError);
  });

  it("rejects a non-canonical charge amount synchronously", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await withPremiumCharge(OPTIONS, async (charge) => {
      expect(() => charge("1.5")).toThrow(EnlittConfigurationError);
      expect(() => charge("-1")).toThrow(EnlittConfigurationError);
    });
  });

  it.each([
    ["a non-canonical maxCharge", { maxCharge: "01" }],
    ["a too-short idempotencyKey", { idempotencyKey: "short" }],
    ["a bad reportingDeadlineMs", { reportingDeadlineMs: 0 }],
    ["reserved metadata keys", { metadata: { enlitt_x: "1" } }]
  ])("rejects %s before any request", async (_label, override) => {
    await expect(withPremiumCharge({ ...OPTIONS, ...override }, async () => "x")).rejects.toBeInstanceOf(
      EnlittConfigurationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the supplied idempotencyKey as the begin Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await withPremiumCharge({ ...OPTIONS, idempotencyKey: "business-call-0000001" }, async () => "x");
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("idempotency-key")).toBe("business-call-0000001");
  });
});
