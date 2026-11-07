import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponse } from "@enlitt/protocol";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EnlittConfigurationError, EnlittError, EnlittInsufficientCreditsError, EnlittLoginRequiredError } from "../core/errors.js";
import type { InternalEnlittClient } from "../core/transport.js";
import type { SseEvent } from "../core/sse.js";
// `../language-model.js` does not exist yet — a concurrent task is writing it.
// Mocked below with `vi.mock` so this file can run against the already-written
// `standard-language-model.ts`, which imports these two names from it.
import { readEnlittCallOptions, resolveCallId } from "./language-model.js";
import {
  buildStandardRequest,
  createStandardLanguageModel,
  mapStandardGenerateResponse,
  mapStandardStream
} from "./standard-language-model.js";

vi.mock("./language-model.js", () => ({
  readEnlittCallOptions: vi.fn(),
  resolveCallId: vi.fn()
}));

// A valid 1x1 PNG: the protocol validator checks the image header.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const CALL_ID = "call-id-0123456789abcdef";

beforeEach(() => {
  vi.mocked(readEnlittCallOptions).mockReturnValue({});
  vi.mocked(resolveCallId).mockReturnValue(CALL_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --- Shared fixtures --------------------------------------------------

function minimalPrompt(): LanguageModelV3CallOptions["prompt"] {
  return [{ role: "user", content: [{ type: "text", text: "hi" }] }];
}

function minimalParams(overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return { prompt: minimalPrompt(), ...overrides };
}

function baseResponse(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "enlitt-standard",
    output: [],
    metadata: {},
    ...overrides
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function errorBody(code: string, message = "refused"): unknown {
  return { error: { message, type: "invalid_request_error", param: null, code } };
}

/** A stubbed `InternalEnlittClient` — no real session/transport wiring, per the read-scope boundary of this task. */
function makeClient(overrides: Partial<InternalEnlittClient> = {}): InternalEnlittClient {
  return {
    baseUrl: "https://enlitt.example",
    businessAuthorization: "Bearer sk_test_1234567890",
    sdkVersion: "0.0.0",
    resolveSession: () => ({ token: "session-token-abc" }),
    rateLimit: { maxAttempts: 1, maxTotalWaitMs: 1000 },
    ...overrides
  };
}

function sseEventFrom(payload: Record<string, unknown>): SseEvent {
  return { event: String(payload.type), data: JSON.stringify(payload) };
}

function created(seq: number, response: OpenAIResponse = baseResponse({ status: "in_progress" })): SseEvent {
  return sseEventFrom({ type: "response.created", sequence_number: seq, response });
}
function textDelta(seq: number, itemId: string, delta: string): SseEvent {
  return sseEventFrom({
    type: "response.output_text.delta",
    sequence_number: seq,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta
  });
}
function textDone(seq: number, itemId: string, text: string): SseEvent {
  return sseEventFrom({
    type: "response.output_text.done",
    sequence_number: seq,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text
  });
}
function completed(seq: number, response: OpenAIResponse = baseResponse()): SseEvent {
  return sseEventFrom({ type: "response.completed", sequence_number: seq, response });
}

/** A plain array-backed `ReadableStream<SseEvent>`. */
function eventStream(events: readonly SseEvent[]): ReadableStream<SseEvent> {
  let index = 0;
  return new ReadableStream<SseEvent>({
    pull(controller) {
      if (index >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(events[index]!);
      index += 1;
    }
  });
}

/** Same as {@link eventStream}, but counts `pull` invocations and records `cancel`. */
function trackedEventStream(events: readonly SseEvent[]): {
  stream: ReadableStream<SseEvent>;
  pullCount: () => number;
  canceled: () => boolean;
} {
  let index = 0;
  let pulls = 0;
  let canceled = false;
  const stream = new ReadableStream<SseEvent>({
    pull(controller) {
      pulls += 1;
      if (index >= events.length) {
        controller.close();
        return;
      }
      controller.enqueue(events[index]!);
      index += 1;
    },
    cancel() {
      canceled = true;
    }
  });
  return { stream, pullCount: () => pulls, canceled: () => canceled };
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/**
 * Drains a stream fully, tolerating a rejection partway through, so a test
 * can assert both what was emitted *before* an error and the error itself
 * without having to guess exactly which `read()` call will observe it — how
 * many output parts a single source event yields (zero, one, or several
 * enqueued together) is an implementation detail this helper deliberately
 * does not need to know.
 */
async function collectOrErrorLegacy(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<{ parts: LanguageModelV3StreamPart[]; error?: unknown }> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) return { parts: out };
      out.push(value);
    } catch (error) {
      return { parts: out, error };
    }
  }
}

/**
 * Drains a stream and reports a protocol violation the way the mapper emits it:
 * as exactly one `error` part followed by a clean close. A rejected read is
 * also reported, so a regression to throwing still surfaces here.
 */
async function collectOrError(
  stream: ReadableStream<LanguageModelV3StreamPart>
): Promise<{ parts: LanguageModelV3StreamPart[]; error?: unknown }> {
  const { parts, error } = await collectOrErrorLegacy(stream);
  if (error !== undefined) return { parts, error };
  const errorParts = parts.filter((part) => part.type === "error");
  expect(errorParts.length).toBeLessThanOrEqual(1);
  const errorPart = errorParts[0] as { error: unknown } | undefined;
  return { parts: parts.filter((part) => part.type !== "error"), error: errorPart?.error };
}

// --- buildStandardRequest ------------------------------------------------

describe("buildStandardRequest", () => {
  it("maps roles, content parts, tools, schemas, token limit, and metadata in order, and validates", () => {
    const params = minimalParams({
      prompt: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "file", mediaType: "image/png", data: TINY_PNG },
            { type: "file", mediaType: "image/png", data: new URL("https://example.com/a.png") }
          ]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Sure" },
            { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "x" } }
          ]
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "json", value: { result: 42 } } }]
        }
      ],
      tools: [{ type: "function", name: "lookup", description: "Look something up", inputSchema: { type: "object" } }],
      maxOutputTokens: 256
    });
    const result = buildStandardRequest(params, { metadata: { trace_id: "abc" } }, CALL_ID);

    expect(result).toEqual({
      model: "enlitt-standard",
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG } },
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } }
          ]
        },
        {
          role: "assistant",
          content: "Sure",
          tool_calls: [{ id: "call_1", name: "lookup", arguments: '{"q":"x"}' }]
        },
        { role: "tool", tool_call_id: "call_1", content: '{"result":42}' }
      ],
      tools: [{ name: "lookup", description: "Look something up", input_schema: { type: "object" } }],
      max_output_tokens: 256,
      metadata: { trace_id: "abc" }
    });
    // The stream flag is added only when the caller asks for a stream.
    expect(result.stream).toBeUndefined();
    expect(buildStandardRequest(params, {}, CALL_ID, true).stream).toBe(true);
  });

  it.each([
    ["temperature", { temperature: 0.5 }],
    ["topP", { topP: 0.9 }],
    ["a json responseFormat", { responseFormat: { type: "json" } }],
    ["a non-enlitt provider namespace", { providerOptions: { openai: { x: 1 } } }],
    ["a non-image file", { prompt: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "aGk=" }] }] }]
  ])("rejects %s at the SDK boundary", (_name, overrides) => {
    expect(() => buildStandardRequest(minimalParams(overrides as never), {}, CALL_ID)).toThrow(
      EnlittConfigurationError
    );
  });

  it('omits tools when toolChoice is "none"', () => {
    const params = minimalParams({
      toolChoice: { type: "none" },
      tools: [{ type: "function", name: "t", inputSchema: { type: "object" } }]
    });
    expect(buildStandardRequest(params, {}, CALL_ID).tools).toBeUndefined();
  });

  it("never sends conversation, previous-response, storage, replay, or background fields", () => {
    const result = buildStandardRequest(minimalParams(), {}, CALL_ID);
    const forbidden = [
      "conversation",
      "previous_response_id",
      "store",
      "background",
      "include",
      "max_tool_calls",
      "moderation",
      "prompt",
      "prompt_cache_key",
      "prompt_cache_options",
      "reasoning",
      "service_tier",
      "stream_options",
      "top_logprobs",
      "truncation"
    ];
    for (const field of forbidden) {
      expect(Object.keys(result)).not.toContain(field);
    }
  });

  it("uses model \"enlitt-standard\" unconditionally, with no caller-reachable override", () => {
    const result = buildStandardRequest(minimalParams(), { metadata: { model: "gpt-4", provider: "openai" } }, CALL_ID);
    expect(result.model).toBe("enlitt-standard");
    // Caller metadata is passed through as ordinary metadata, not read as an override.
    expect(result.metadata).toEqual({ model: "gpt-4", provider: "openai" });
  });

  it.each([
    ["stopSequences", { stopSequences: ["STOP"] }],
    ["topK", { topK: 5 }],
    ["presencePenalty", { presencePenalty: 0.1 }],
    ["frequencyPenalty", { frequencyPenalty: 0.1 }],
    ["seed", { seed: 42 }]
  ])("rejects unsupported control %s with EnlittConfigurationError instead of dropping it", (_name, overrides) => {
    expect(() => buildStandardRequest(minimalParams(overrides), {}, CALL_ID)).toThrow(EnlittConfigurationError);
  });

  it("rejects a provider-defined (non-function) tool", () => {
    const params = minimalParams({ tools: [{ type: "provider-defined", id: "p1", name: "search", args: {} } as never] });
    expect(() => buildStandardRequest(params, {}, CALL_ID)).toThrow(EnlittConfigurationError);
  });

  it("rejects provider-executed tool calls in assistant history", () => {
    const params = minimalParams({
      prompt: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "x", input: {}, providerExecuted: true }]
        }
      ]
    });
    expect(() => buildStandardRequest(params, {}, CALL_ID)).toThrow(EnlittConfigurationError);
  });

  it.each(["reasoning", "file", "tool-result"] as const)(
    "rejects an assistant \"%s\" part in history",
    (type) => {
      const part =
        type === "file"
          ? { type: "file", data: "aGk=", mediaType: "image/png" }
          : type === "tool-result"
            ? { type: "tool-result", toolCallId: "c1", toolName: "x", output: { type: "text", value: "ok" } }
            : { type: "reasoning", text: "thinking" };
      const params = minimalParams({ prompt: [{ role: "assistant", content: [part as never] }] });
      expect(() => buildStandardRequest(params, {}, CALL_ID)).toThrow(EnlittConfigurationError);
    }
  );

  it("rejects a tool-approval-response in a tool message", () => {
    const params = minimalParams({
      prompt: [{ role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] }]
    });
    expect(() => buildStandardRequest(params, {}, CALL_ID)).toThrow(EnlittConfigurationError);
  });

  it("rejects an unsupported tool-result output type instead of silently dropping it", () => {
    const params = minimalParams({
      prompt: [
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", toolName: "x", output: { type: "execution-denied" } }]
        }
      ]
    });
    expect(() => buildStandardRequest(params, {}, CALL_ID)).toThrow(EnlittConfigurationError);
  });
});

// --- mapStandardGenerateResponse ------------------------------------------

describe("mapStandardGenerateResponse", () => {
  it("maps text content, finish reason, and warnings", () => {
    const response = baseResponse({
      output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello world" }] }]
    });
    const result = mapStandardGenerateResponse(response);
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.finishReason).toEqual({ unified: "stop", raw: "completed" });
    expect(result.warnings).toEqual([]);
  });

  it("surfaces structured output as ordinary text content", () => {
    const response = baseResponse({
      output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"result":42}' }] }]
    });
    const result = mapStandardGenerateResponse(response);
    expect(result.content).toEqual([{ type: "text", text: '{"result":42}' }]);
  });

  it("maps a function call to a tool-call content part", () => {
    const response = baseResponse({
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}', status: "completed" }]
    });
    const result = mapStandardGenerateResponse(response);
    expect(result.content).toEqual([{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: '{"q":"x"}' }]);
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "completed" });
  });

  it.each([
    ["max_output_tokens", "length"],
    ["something_else", "other"]
  ] as const)("maps incomplete_details.reason %s to unified finish reason %s", (reason, unified) => {
    const response = baseResponse({ status: "incomplete", incomplete_details: { reason: reason as never } });
    expect(mapStandardGenerateResponse(response).finishReason).toEqual({ unified, raw: reason });
  });

  it("maps a failed response to an error finish reason", () => {
    const response = baseResponse({ status: "failed", error: { code: "server_error", message: "boom" } });
    expect(mapStandardGenerateResponse(response).finishReason).toEqual({ unified: "error", raw: "server_error" });
  });

  it("passes usage through exactly, with no fabricated zero for an absent field", () => {
    const withoutDetails = baseResponse({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } });
    expect(mapStandardGenerateResponse(withoutDetails).usage).toEqual({
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: 50, reasoning: undefined }
    });

    const withDetails = baseResponse({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 10 },
        total_tokens: 150
      }
    });
    expect(mapStandardGenerateResponse(withDetails).usage).toEqual({
      inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined },
      outputTokens: { total: 50, text: 40, reasoning: 10 }
    });

    const noUsage = baseResponse();
    expect(mapStandardGenerateResponse(noUsage).usage).toEqual({
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined }
    });
  });

  it("carries exactly the four documented enlitt_* keys in providerMetadata.enlitt and nothing else", () => {
    const response = baseResponse({
      metadata: {
        enlitt_operation_id: "op_1",
        enlitt_routed_provider: "openai",
        enlitt_routed_model: "gpt-4o",
        enlitt_policy_version: "v3",
        // A caller- or server-supplied key that must never leak into providerMetadata.enlitt.
        credit_balance: "999999"
      }
    });
    const result = mapStandardGenerateResponse(response);
    expect(result.providerMetadata).toEqual({
      enlitt: { operationId: "op_1", routedProvider: "openai", routedModel: "gpt-4o", policyVersion: "v3" }
    });
    expect(JSON.stringify(result.providerMetadata)).not.toContain("credit_balance");
    expect(JSON.stringify(result.providerMetadata)).not.toContain("999999");
  });

  it("omits providerMetadata entirely when no reserved key is present", () => {
    const result = mapStandardGenerateResponse(baseResponse({ metadata: { caller_key: "x" } }));
    expect(result.providerMetadata).toBeUndefined();
  });
});

// --- mapStandardStream -----------------------------------------------------

describe("mapStandardStream", () => {
  it("translates events incrementally and emits exactly one terminal part", async () => {
    const events = [created(0), textDelta(1, "item_1", "Hel"), textDelta(2, "item_1", "lo"), textDone(3, "item_1", "Hello"), completed(4)];
    const parts = await collect(mapStandardStream(eventStream(events)));
    expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "text-delta", "text-end", "finish"]);
    expect(parts.filter((p) => p.type === "finish" || p.type === "error")).toHaveLength(1);
  });

  it("permits an identical repeat of the last event without emitting a duplicate part", async () => {
    const delta = textDelta(1, "item_1", "Hel");
    const events = [created(0), delta, { ...delta }, completed(2)];
    const parts = await collect(mapStandardStream(eventStream(events)));
    // Exactly one text-delta despite the repeated event, and the stream still terminates cleanly.
    expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "finish"]);
  });

  it("rejects malformed JSON in an event's data payload", async () => {
    const events = [created(0), { event: "response.output_text.delta", data: "{not json" }];
    const { error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects an out-of-order event (decreasing sequence_number)", async () => {
    const events = [created(0), textDelta(1, "item_1", "a"), textDelta(0, "item_1", "b")];
    const { error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects two events with the same sequence_number but conflicting payloads", async () => {
    const events = [created(0), textDelta(1, "item_1", "a"), textDelta(1, "item_1", "different")];
    const { error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects a stream that ends before any terminal event", async () => {
    const events = [created(0), textDelta(1, "item_1", "a")];
    const { error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects a stream whose first event is not response.created", async () => {
    const events = [textDelta(0, "item_1", "a")];
    const { error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects data received after the terminal event", async () => {
    const events = [created(0), completed(1), textDelta(2, "item_1", "late")];
    const { parts, error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(parts.map((p) => p.type)).toEqual(["stream-start", "finish"]);
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("rejects a second terminal event", async () => {
    const events = [created(0), completed(1), completed(2)];
    const { parts, error } = await collectOrError(mapStandardStream(eventStream(events)));
    expect(parts.map((p) => p.type)).toEqual(["stream-start", "finish"]);
    expect(error).toBeInstanceOf(EnlittError);
  });

  it("closes cleanly with exactly one finish part when nothing follows the terminal event", async () => {
    const events = [created(0), completed(1)];
    const parts = await collect(mapStandardStream(eventStream(events)));
    expect(parts.map((p) => p.type)).toEqual(["stream-start", "finish"]);
  });

  it("propagates backpressure: does not read ahead of what the consumer has consumed", async () => {
    const events = [
      created(0),
      textDelta(1, "item_1", "a"),
      textDelta(2, "item_1", "b"),
      textDelta(3, "item_1", "c"),
      textDone(4, "item_1", "abc"),
      completed(5)
    ];
    const { stream, pullCount } = trackedEventStream(events);
    const reader = mapStandardStream(stream).getReader();

    const first = await reader.read();
    expect(first.value?.type).toBe("stream-start");
    // Only as much of the (six-event) source as was needed to produce the
    // first translated part has been read — the source has not been
    // drained ahead of the consumer.
    expect(pullCount()).toBeLessThan(events.length);
  });

  it("propagates consumer cancellation to the underlying event stream", async () => {
    const { stream, canceled } = trackedEventStream([created(0), textDelta(1, "item_1", "a"), completed(2)]);
    const output = mapStandardStream(stream);
    const reader = output.getReader();
    await reader.read();
    await reader.cancel("consumer done");
    expect(canceled()).toBe(true);
  });

  it("errors the stream and cancels the source when the abort signal fires", async () => {
    const controller = new AbortController();
    const { stream, canceled } = trackedEventStream([created(0), textDelta(1, "item_1", "a"), completed(2)]);
    const output = mapStandardStream(stream, controller.signal);
    const reader = output.getReader();
    await reader.read();
    const reason = new Error("aborted");
    controller.abort(reason);
    await expect(reader.read()).rejects.toBe(reason);
    expect(canceled()).toBe(true);
  });

  it("errors immediately when the signal is already aborted before the stream starts", async () => {
    const controller = new AbortController();
    const reason = new Error("already aborted");
    controller.abort(reason);
    const { stream } = trackedEventStream([created(0)]);
    const output = mapStandardStream(stream, controller.signal);
    await expect(output.getReader().read()).rejects.toBe(reason);
  });

  it("normalizes an SseFramingError raised by the source into the same EnlittError base class", async () => {
    const { SseFramingError } = await import("../core/sse.js");
    const failingStream = new ReadableStream<SseEvent>({
      pull(controller) {
        controller.error(new SseFramingError("line too long"));
      }
    });
    const { error } = await collectOrError(mapStandardStream(failingStream));
    expect(error).toBeInstanceOf(EnlittError);
  });
});

// --- createStandardLanguageModel -------------------------------------------

describe("createStandardLanguageModel", () => {
  it("has modelId \"enlitt-standard\" and never accepts a caller-supplied model or provider override", () => {
    const model = createStandardLanguageModel(makeClient());
    expect(model.modelId).toBe("enlitt-standard");
    expect(model.provider).toBe("enlitt");
  });

  it("doGenerate sends exactly one request to /v1/responses and maps a completed response", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, baseResponse({ output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi there" }] }] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createStandardLanguageModel(makeClient());
    const result = await model.doGenerate(minimalParams());

    expect(result.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://enlitt.example/v1/responses");
  });

  it("doGenerate raises EnlittLoginRequiredError with providerInvoked: false and calls no endpoint when no session resolves", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient({
      resolveSession: () => {
        throw new EnlittLoginRequiredError("No Enlitt session is available for this request.");
      }
    });

    const model = createStandardLanguageModel(client);
    let caught: unknown;
    try {
      await model.doGenerate(minimalParams());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnlittLoginRequiredError);
    expect((caught as EnlittError).providerInvoked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doGenerate raises EnlittInsufficientCreditsError(standard_balance_exhausted) with no number and no retry", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(402, errorBody("standard_balance_exhausted", "Standard usage ceiling reached.")));
    vi.stubGlobal("fetch", fetchMock);

    const model = createStandardLanguageModel(makeClient());
    let caught: unknown;
    try {
      await model.doGenerate(minimalParams());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnlittInsufficientCreditsError);
    expect((caught as EnlittError).providerInvoked).toBe(false);
    expect((caught as EnlittError).retryable).toBe(false);
    expect(JSON.stringify(caught)).not.toMatch(/\d/);
    // No automatic retry of a non-retryable refusal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doGenerate: an abort signal aborts the in-flight request and never calls a cancel endpoint", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createStandardLanguageModel(makeClient());
    const promise = model.doGenerate(minimalParams({ abortSignal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(EnlittError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/cancel");
    }
  });

  it("doStream sends stream:true, validates it, and never calls a cancel endpoint", async () => {
    const sse = "event: response.created\ndata: " + JSON.stringify({ type: "response.created", sequence_number: 0, response: baseResponse({ status: "in_progress" }) }) + "\n\n" +
      "event: response.completed\ndata: " + JSON.stringify({ type: "response.completed", sequence_number: 1, response: baseResponse() }) + "\n\n";
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createStandardLanguageModel(makeClient());
    const { stream } = await model.doStream(minimalParams());
    const parts = await collect(stream);

    expect(parts.map((p) => p.type)).toEqual(["stream-start", "finish"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string).stream).toBe(true);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/cancel");
    }
  });

  it("doStream: cancelling the returned stream aborts the in-flight HTTP body and calls no cancel endpoint", async () => {
    let bodyCanceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
      },
      cancel() {
        bodyCanceled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const model = createStandardLanguageModel(makeClient());
    const { stream } = await model.doStream(minimalParams());
    const reader = stream.getReader();
    await reader.cancel("consumer done");

    expect(bodyCanceled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
