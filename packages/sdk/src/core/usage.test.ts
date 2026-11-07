import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENLITT_API_VERSION } from "@enlitt/protocol";
import {
  EnlittAuthenticationError,
  EnlittConfigurationError,
  EnlittError,
  EnlittLoginRequiredError,
  EnlittRateLimitError
} from "./errors.js";
import { runWithEnlittSession } from "./session.js";
import { usage } from "./usage.js";

// Reads only the helper's own contract through a mocked fetch; Enlitt's real
// request building and tolerant parsing run.

const BASE_URL = "https://api.enlitt.test";
const OPTIONS = {
  secretKey: "sk_test_1234567890",
  baseUrl: BASE_URL,
  session: { token: "session-token-123" }
} as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(status: number, code: string, type = "invalid_request_error"): Response {
  return jsonResponse(status, { error: { message: "refused", type, param: null, code } });
}

const BODY = {
  standard: { remaining_percent: 42, limit_cap_nano_usd: "9007199254740993" },
  premium: { remaining_percent: 0, limit_cap_nano_usd: "0" }
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usage()", () => {
  it("exposes a function and issues no request until called", () => {
    expect(typeof usage).toBe("function");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends exactly one authenticated GET with the version header and no body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, BODY));
    await usage(OPTIONS);

    // One request only: no begin/terminal pair, so no call or reservation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${BASE_URL}/v1/enlitt/usage`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("enlitt-version")).toBe(ENLITT_API_VERSION);
    expect(headers.get("authorization")).toBe("Bearer sk_test_1234567890");
    expect(headers.get("x-enlitt-user-authorization")).toBe("Bearer session-token-123");
    expect(headers.get("accept")).toBe("application/json");
    // A GET carries no call ID, so it can never be mistaken for a reservation.
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("returns both pools byte-identically, including a NANOUSD cap above 2^53", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, BODY));
    await expect(usage(OPTIONS)).resolves.toEqual({
      standard: { remainingPercent: 42, limitCapNanoUsd: "9007199254740993" },
      premium: { remainingPercent: 0, limitCapNanoUsd: "0" }
    });
  });

  it("reports unlimited standard as 100 percent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        standard: { remaining_percent: 100, limit_cap_nano_usd: "5000000000" },
        premium: { remaining_percent: 100, limit_cap_nano_usd: "300" }
      })
    );
    const result = await usage(OPTIONS);
    expect(result.standard.remainingPercent).toBe(100);
    expect(result.premium).toEqual({ remainingPercent: 100, limitCapNanoUsd: "300" });
  });

  it("ignores unknown fields at every level and exposes none of them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        standard: { remaining_percent: 7, limit_cap_nano_usd: "11", plan: "pro", balance: 5 },
        premium: { remaining_percent: 8, limit_cap_nano_usd: "12", future: { a: 1 } },
        image: { remaining_percent: 1, limit_cap_nano_usd: "1" },
        period_end: "2026-10-01T00:00:00Z"
      })
    );
    const result = await usage(OPTIONS);
    expect(result).toEqual({
      standard: { remainingPercent: 7, limitCapNanoUsd: "11" },
      premium: { remainingPercent: 8, limitCapNanoUsd: "12" }
    });
    expect(Object.keys(result.standard).sort()).toEqual(["limitCapNanoUsd", "remainingPercent"]);
  });

  it("resolves the ambient session when no explicit one is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, BODY));
    await runWithEnlittSession({ token: "ambient-token" }, () =>
      usage({ secretKey: OPTIONS.secretKey, baseUrl: BASE_URL })
    );
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("x-enlitt-user-authorization")).toBe("Bearer ambient-token");
  });

  it("prefers an explicit session over the ambient one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, BODY));
    await runWithEnlittSession({ token: "ambient-token" }, () => usage(OPTIONS));
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("x-enlitt-user-authorization")).toBe("Bearer session-token-123");
  });

  it("rejects with EnlittConfigurationError when there is no session context, sending nothing", async () => {
    await expect(usage({ secretKey: OPTIONS.secretKey, baseUrl: BASE_URL })).rejects.toBeInstanceOf(
      EnlittConfigurationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with EnlittLoginRequiredError when the context holds no session, sending nothing", async () => {
    await expect(
      runWithEnlittSession(null, () => usage({ secretKey: OPTIONS.secretKey, baseUrl: BASE_URL }))
    ).rejects.toBeInstanceOf(EnlittLoginRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a personal_login_required refusal to EnlittLoginRequiredError", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "personal_login_required", "authentication_error"));
    await expect(usage(OPTIONS)).rejects.toBeInstanceOf(EnlittLoginRequiredError);
  });

  it("maps an invalid-key refusal to EnlittAuthenticationError", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401, "invalid_api_key", "authentication_error"));
    await expect(usage(OPTIONS)).rejects.toBeInstanceOf(EnlittAuthenticationError);
  });

  it("keeps an unknown error code from a newer server as a base EnlittError carrying the code", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, "brand_new_code"));
    const error = await usage(OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("brand_new_code");
  });

  it("surfaces an exhausted rate-limit refusal as EnlittRateLimitError after the transport's bounded retry", async () => {
    fetchMock.mockResolvedValue(errorResponse(429, "rate_limit_exceeded", "rate_limit_error"));
    await expect(
      usage({ ...OPTIONS, rateLimit: { maxAttempts: 1, maxTotalWaitMs: 0 } })
    ).rejects.toBeInstanceOf(EnlittRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises malformed_response when the body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } })
    );
    const error = await usage(OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("malformed_response");
  });

  it.each([
    ["a missing pool", { standard: BODY.standard }],
    ["a percentage above 100", { ...BODY, standard: { remaining_percent: 101, limit_cap_nano_usd: "1" } }],
    ["a negative percentage", { ...BODY, premium: { remaining_percent: -1, limit_cap_nano_usd: "1" } }],
    ["a non-integer percentage", { ...BODY, premium: { remaining_percent: 1.5, limit_cap_nano_usd: "1" } }],
    ["a non-canonical NANOUSD cap", { ...BODY, standard: { remaining_percent: 1, limit_cap_nano_usd: "01" } }],
    ["a numeric NANOUSD cap", { ...BODY, standard: { remaining_percent: 1, limit_cap_nano_usd: 5 } }]
  ])("raises malformed_response for %s", async (_name, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, body));
    const error = await usage(OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("malformed_response");
  });
});
