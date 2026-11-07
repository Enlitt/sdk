import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Response as OpenAIResponse, ResponseStreamEvent } from "openai/resources/responses/responses";
import { EnlittConfigurationError } from "../core/errors.js";
import { ENLITT_STANDARD_MODEL, enlitt, perToken } from "./client.js";

const BASE_URL = "https://api.enlitt.test";
const ORIGINAL_ENV = { ...process.env };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function standardResponse(): unknown {
  return {
    id: "resp_standard",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: ENLITT_STANDARD_MODEL,
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    metadata: {}
  };
}

function providerResponse(): OpenAIResponse {
  return { id: "resp_provider", object: "response", status: "completed", usage: { input_tokens: 2, output_tokens: 3 } } as unknown as OpenAIResponse;
}

function admitted(effectiveMax = "50"): Response {
  return json({
    operation_id: "op_1",
    billing: "managed",
    report_terminal: true,
    effective_max_charge_nano_usd: effectiveMax,
    reserved_nano_usd: effectiveMax,
    terminal_deadline: "2026-10-05T00:00:00Z"
  });
}

function settled(): Response {
  return json({
    operation_id: "op_1",
    status: "completed",
    idempotent_replay: false,
    settlement: { captured_nano_usd: "0", released_nano_usd: "0", business_earnings_nano_usd: "0" }
  });
}

function premiumFetch(requests: string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/enlitt/operations")) return admitted();
    const body = init?.body;
    requests.push(typeof body === "string" ? body : "");
    return settled();
  });
}

function premiumClient(provider: OpenAI): ReturnType<typeof enlitt> {
  return enlitt(provider, { baseUrl: BASE_URL, session: { token: "user-token" } });
}

function terminalBody(requests: string[]): Record<string, unknown> {
  expect(requests).toHaveLength(1);
  return JSON.parse(requests[0]!) as Record<string, unknown>;
}

function streamOf(events: ResponseStreamEvent[], failure?: Error): AsyncIterable<ResponseStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
      if (failure !== undefined) throw failure;
    }
  };
}

function completedEvent(): ResponseStreamEvent {
  return { type: "response.completed", sequence_number: 1, response: providerResponse() } as ResponseStreamEvent;
}

beforeEach(() => {
  process.env.ENLITT_SECRET_KEY = "sk_test_1234567890";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("OpenAI Responses adapter", () => {
  it("does not expose unsupported OpenAI resources or Responses helpers in its public type", () => {
    const client = enlitt({ baseUrl: BASE_URL, session: { token: "user-token" } });
    // @ts-expect-error Chat Completions are deliberately absent from this adapter.
    void client.chat;
    // @ts-expect-error The Responses parse helper is deliberately absent.
    void client.responses.parse;
    // @ts-expect-error The Responses stream helper is deliberately absent.
    void client.responses.stream;
  });

  it("routes the standard model directly to Enlitt without touching a supplied OpenAI client", async () => {
    const providerCreate = vi.fn();
    const provider = { responses: { create: providerCreate } } as unknown as OpenAI;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(standardResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const response = await enlitt(provider, {
      baseUrl: BASE_URL,
      session: { token: "user-token" }
    }).responses.create({ model: ENLITT_STANDARD_MODEL, input: "secret prompt" });

    expect(providerCreate).not.toHaveBeenCalled();
    expect(response.output_text).toBe("hello");
    const requestBody = fetchMock.mock.calls[0]![1]!.body;
    if (typeof requestBody !== "string") throw new Error("expected a JSON request body");
    const body = JSON.parse(requestBody);
    expect(body).toEqual({
      model: ENLITT_STANDARD_MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: "secret prompt" }] }]
    });
  });

  it("admits premium before calling OpenAI, strips enlitt, and forwards the exact response", async () => {
    const response = providerResponse();
    const providerCreate = vi.fn(async (_body: unknown, _options?: unknown) => response);
    const provider = { responses: { create: providerCreate } } as unknown as OpenAI;
    const requests: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body;
      requests.push({ url, body: typeof body === "string" ? body : "" });
      if (url.endsWith("/v1/enlitt/operations")) {
        return json({
          operation_id: "op_1",
          billing: "managed",
          report_terminal: true,
          effective_max_charge_nano_usd: "50",
          reserved_nano_usd: "50",
          terminal_deadline: "2026-10-05T00:00:00Z"
        });
      }
      return json({
        operation_id: "op_1",
        status: "completed",
        idempotent_replay: false,
        settlement: { captured_nano_usd: "10", released_nano_usd: "40", business_earnings_nano_usd: "10" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await enlitt(provider, {
      baseUrl: BASE_URL,
      session: { token: "user-token" }
    }).responses.create({
      model: "gpt-5.5",
      input: "provider-only prompt",
      enlitt: { idempotencyKey: "1234567890abcdef", maxCharge: "50", price: "10" }
    });

    expect(result).toBe(response);
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(providerCreate.mock.calls[0]![0]).toEqual({ model: "gpt-5.5", input: "provider-only prompt" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).not.toContain("provider-only prompt");
    expect(requests[1]!.body).not.toContain("provider-only prompt");
    expect(providerCreate.mock.invocationCallOrder[0]).toBeGreaterThan(fetchMock.mock.invocationCallOrder[0]!);
  });

  it("refuses premium locally when no OpenAI client was supplied", async () => {
    await expect(enlitt({ baseUrl: BASE_URL, session: { token: "user-token" } }).responses.create({
      model: "gpt-5.5",
      input: "hello",
      enlitt: { maxCharge: "1" }
    })).rejects.toBeInstanceOf(EnlittConfigurationError);
  });

  it("prevents the provider call when premium admission is refused", async () => {
    const providerCreate = vi.fn();
    const provider = { responses: { create: providerCreate } } as unknown as OpenAI;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "no premium capacity", type: "insufficient_quota", param: null, code: "premium_balance_exhausted" }
    }), { status: 402, headers: { "content-type": "application/json" } })));

    await expect(premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", enlitt: { maxCharge: "50" }
    })).rejects.toMatchObject({ providerInvoked: false });
    expect(providerCreate).not.toHaveBeenCalled();
  });

  it("reports a resolved failed response once with zero charge and returns it unchanged", async () => {
    const failed = { ...providerResponse(), status: "failed" } as OpenAIResponse;
    const provider = { responses: { create: vi.fn(async () => failed) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));

    const result = await premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", enlitt: { maxCharge: "50", price: "25" }
    });
    expect(result).toBe(failed);
    expect(terminalBody(reports)).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });

  it("reports a resolved canceled response once using the calculated price", async () => {
    const canceled = { ...providerResponse(), status: "cancelled" } as OpenAIResponse;
    const price = vi.fn(() => "21");
    const provider = { responses: { create: vi.fn(async () => canceled) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));

    const result = await premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", enlitt: { maxCharge: "50", price }
    });
    expect(result).toBe(canceled);
    expect(price).toHaveBeenCalledWith(expect.objectContaining({ status: "canceled", response: canceled }));
    expect(terminalBody(reports)).toMatchObject({ status: "canceled", charge_nano_usd: "21" });
  });

  it("forwards a completed stream event by identity and reports exactly once", async () => {
    const event = completedEvent();
    const provider = { responses: { create: vi.fn(async () => streamOf([event])) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));
    const stream = await premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", stream: true, enlitt: { maxCharge: "50", price: "12" }
    });
    const seen: ResponseStreamEvent[] = [];
    for await (const item of stream) seen.push(item);
    expect(seen).toEqual([event]);
    expect(seen[0]).toBe(event);
    expect(terminalBody(reports)).toMatchObject({ status: "completed", charge_nano_usd: "12" });
  });

  it("reports an early iterator return as canceled exactly once", async () => {
    const delta = { type: "response.output_text.delta", sequence_number: 1, item_id: "msg", output_index: 0, content_index: 0, delta: "hi" } as ResponseStreamEvent;
    const provider = { responses: { create: vi.fn(async () => streamOf([delta, completedEvent()])) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));
    const stream = await premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", stream: true, enlitt: { maxCharge: "50", price: "9" }
    });
    for await (const item of stream) {
      expect(item).toBe(delta);
      break;
    }
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(terminalBody(reports)).toMatchObject({ status: "canceled", charge_nano_usd: "9" });
  });

  it("calculates canceled pricing when the provider aborts", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const price = vi.fn(() => "7");
    const provider = { responses: { create: vi.fn(async () => { throw abort; }) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));
    await expect(premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", enlitt: { maxCharge: "50", price }
    })).rejects.toBe(abort);
    expect(price).toHaveBeenCalledWith(expect.objectContaining({ status: "canceled" }));
    expect(terminalBody(reports)).toMatchObject({ status: "canceled", charge_nano_usd: "7" });
  });

  it.each([
    ["provider stream failure", new Error("stream failed")],
    ["unterminated stream", undefined]
  ])("reports %s once as failed", async (_name, failure) => {
    const provider = { responses: { create: vi.fn(async () => streamOf([], failure)) } } as unknown as OpenAI;
    const reports: string[] = [];
    vi.stubGlobal("fetch", premiumFetch(reports));
    const stream = await premiumClient(provider).responses.create({
      model: "gpt-5.5", input: "secret", stream: true, enlitt: { maxCharge: "50", price: "20" }
    });
    if (failure !== undefined) await expect(async () => { for await (const _event of stream) void _event; }).rejects.toBe(failure);
    else for await (const _event of stream) void _event;
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(terminalBody(reports)).toMatchObject({ status: "failed", charge_nano_usd: "0" });
  });

  it("prices tokens with exact bigint arithmetic", async () => {
    const price = perToken({ input: "9007199254740993", output: "2" });
    expect(price({
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 3 } as never,
      startedAt: new Date(0),
      endedAt: new Date(1),
      durationMs: 1,
      effectiveMaxChargeNanoUsd: "999999999999999999999"
    })).toBe("18014398509481992");
  });
});
