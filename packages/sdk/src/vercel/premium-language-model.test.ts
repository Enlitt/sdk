import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EnlittConfigurationError } from "../core/errors.js";
import { createInternalClient } from "../core/transport.js";
import { createPremiumLanguageModel, perToken } from "./premium-language-model.js";

// Premium lifecycle through the Vercel adapter. Only `fetch` and the wrapped
// provider model are fakes; Enlitt's request building runs for real.

const BASE_URL = "https://api.enlitt.test";

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

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

function generateResult(): Awaited<ReturnType<LanguageModelV3["doGenerate"]>> {
  return {
    content: [{ type: "text", text: "hello" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: []
  } as never;
}

function params(enlitt: Record<string, unknown> | undefined, extra: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "secret prompt text" }] }],
    ...(enlitt !== undefined ? { providerOptions: { enlitt } as never } : {}),
    ...extra
  };
}

function provider(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "openai",
    modelId: "gpt-5",
    supportedUrls: {},
    doGenerate: vi.fn(async () => generateResult()),
    doStream: vi.fn(),
    ...overrides
  };
}

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
}

async function drain(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

let fetchMock: ReturnType<typeof vi.fn>;
let reportErrors: unknown[];

function makeModel(inner: LanguageModelV3): LanguageModelV3 {
  const client = createInternalClient({
    secretKey: "sk_test_1234567890",
    baseUrl: BASE_URL,
    session: { token: "session-token-123" },
    onTerminalReportError: (error) => reportErrors.push(error)
  });
  return createPremiumLanguageModel(client, inner);
}

function bodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>);
}

beforeEach(() => {
  fetchMock = vi.fn();
  reportErrors = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("perToken()", () => {
  it("prices input and output tokens exactly in bigint", () => {
    const price = perToken({ input: "3", output: "15" });
    expect(price({ usage: USAGE } as never)).toBe("105");
  });

  it("counts a missing usage as zero", () => {
    expect(perToken({ input: "3", output: "15" })({} as never)).toBe("0");
  });

  it("rejects a non-canonical rate when created", () => {
    expect(() => perToken({ input: "1.5", output: "1" })).toThrow(EnlittConfigurationError);
  });
});

describe("createPremiumLanguageModel() doGenerate", () => {
  it("passes provider identity through unchanged", () => {
    const inner = provider();
    const model = makeModel(inner);
    expect(model.provider).toBe("openai");
    expect(model.modelId).toBe("gpt-5");
  });

  it("begins with maxCharge, runs the provider, and reports completed at the constant price", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const inner = provider();
    const result = await makeModel(inner).doGenerate(params({ maxCharge: "1000", price: "400" }));

    expect(inner.doGenerate).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toMatchObject({ mode: "premium", max_charge_nano_usd: "1000", provider: { id: "openai", model: "gpt-5" } });
    expect(bodies()[1]).toMatchObject({ status: "completed", charge_nano_usd: "400" });
    expect(result.providerMetadata?.enlitt).toEqual({ operationId: "op_1", effectiveMaxChargeNanoUsd: "1000" });
  });

  it("never sends prompt content to Enlitt", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await makeModel(provider()).doGenerate(params({ maxCharge: "1000" }));
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).body as string).not.toContain("secret prompt text");
    }
  });

  it("charges zero with only maxCharge", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await makeModel(provider()).doGenerate(params({ maxCharge: "1000" }));
    expect(bodies()[1]).toMatchObject({ charge_nano_usd: "0" });
  });

  it("calls a function price exactly once with the result's facts, and lowers an over-max price", async () => {
    fetchMock.mockResolvedValueOnce(admitted("50")).mockResolvedValueOnce(settled());
    const price = vi.fn(() => "9999");
    await makeModel(provider()).doGenerate(params({ maxCharge: "1000", price }));

    expect(price).toHaveBeenCalledTimes(1);
    const context = (price.mock.calls[0] as unknown[])[0] as { status: string; effectiveMaxChargeNanoUsd: string; usage: unknown };
    expect(context.status).toBe("completed");
    expect(context.effectiveMaxChargeNanoUsd).toBe("50");
    expect(context.usage).toEqual(USAGE);
    expect(bodies()[1]).toMatchObject({ charge_nano_usd: "50" });
  });

  it("charges zero and reports through onTerminalReportError when the price function throws", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const result = await makeModel(provider()).doGenerate(
      params({
        maxCharge: "1000",
        price: () => {
          throw new Error("bad price");
        }
      })
    );
    expect(result.content).toHaveLength(1);
    expect(bodies()[1]).toMatchObject({ status: "completed", charge_nano_usd: "0" });
    expect(reportErrors).toHaveLength(1);
    expect(reportErrors[0]).toBeInstanceOf(EnlittConfigurationError);
  });

  it("on provider failure reports failed with zero, never calls price, and rethrows unchanged", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const boom = new Error("provider down");
    const price = vi.fn(() => "100");
    const inner = provider({ doGenerate: vi.fn(async () => Promise.reject(boom)) });

    await expect(makeModel(inner).doGenerate(params({ maxCharge: "1000", price }))).rejects.toBe(boom);
    expect(price).not.toHaveBeenCalled();
    expect(bodies()[1]).toMatchObject({ status: "failed", charge_nano_usd: "0" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never invokes the provider when begin is refused", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(402, { error: { message: "no", type: "insufficient_quota", param: null, code: "premium_balance_exhausted" } })
    );
    const inner = provider();
    await expect(makeModel(inner).doGenerate(params({ maxCharge: "1000" }))).rejects.toMatchObject({ providerInvoked: false });
    expect(inner.doGenerate).not.toHaveBeenCalled();
  });

  it("rejects missing premium options before any request", async () => {
    const inner = provider();
    await expect(makeModel(inner).doGenerate(params(undefined))).rejects.toBeInstanceOf(EnlittConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(inner.doGenerate).not.toHaveBeenCalled();
  });

  it("uses a supplied idempotencyKey (with the prompt-length suffix) as the begin Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    await makeModel(provider()).doGenerate(params({ maxCharge: "10", idempotencyKey: "business-call-0000001" }));
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get("idempotency-key")).toBe("business-call-0000001.1");
  });
});

describe("createPremiumLanguageModel() doStream", () => {
  const FINISH: LanguageModelV3StreamPart = {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE
  } as never;
  const TEXT: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "hi" },
    { type: "text-end", id: "t" }
  ];

  it("reports completed once, before the stream closes, and adds enlitt metadata to the finish part", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const inner = provider({
      doStream: vi.fn(async () => ({ stream: streamOf([...TEXT, FINISH]) })) as never
    });
    const { stream } = await makeModel(inner).doStream(params({ maxCharge: "1000", price: perToken({ input: "3", output: "15" }) }));
    const parts = await drain(stream);

    // The report was awaited before close: both requests are done once the drain ends.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ status: "completed", charge_nano_usd: "105" });
    const finish = parts.find((part) => part.type === "finish") as { providerMetadata?: { enlitt?: unknown } };
    expect(finish.providerMetadata?.enlitt).toEqual({ operationId: "op_1", effectiveMaxChargeNanoUsd: "1000" });
  });

  it("reports canceled when the consumer cancels, with the price evaluated once", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const inner = provider({
      doStream: vi.fn(async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "hi" });
          }
        })
      })) as never
    });
    const price = vi.fn(() => "7");
    const { stream } = await makeModel(inner).doStream(params({ maxCharge: "1000", price }));
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    expect(price).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ status: "canceled", charge_nano_usd: "7" });
  });

  it("reports failed with zero when the provider fails to start a stream, and never calls price", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const boom = new Error("no stream");
    const price = vi.fn(() => "1");
    const inner = provider({ doStream: vi.fn(async () => Promise.reject(boom)) as never });
    await expect(makeModel(inner).doStream(params({ maxCharge: "1000", price }))).rejects.toBe(boom);
    expect(price).not.toHaveBeenCalled();
    expect(bodies()[1]).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });

  it("reports failed when the provider stream errors, never calls price, and sends exactly one report", async () => {
    fetchMock.mockResolvedValueOnce(admitted()).mockResolvedValueOnce(settled());
    const inner = provider({
      doStream: vi.fn(async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.error(new Error("mid-stream failure"));
          }
        })
      })) as never
    });
    const price = vi.fn(() => "1");
    const { stream } = await makeModel(inner).doStream(params({ maxCharge: "1000", price }));
    await drain(stream).catch(() => undefined);

    expect(price).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });
});
