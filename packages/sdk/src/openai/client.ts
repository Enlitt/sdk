/** Thin OpenAI Responses adapter over Enlitt's existing standard transport and premium lifecycle. */
import {
  ENLITT_STANDARD_MODEL,
  validateEnlittStandardRequest,
  validateOpenAIResponse,
  validateResponseStreamEvent,
  type EnlittStandardMessage,
  type EnlittStandardRequest,
  type OpenAIResponse,
  type ResponseStreamEvent as EnlittResponseStreamEvent
} from "@enlitt/protocol";
import type OpenAI from "openai";
import type {
  Response as OpenAIResponseResult,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  ResponseUsage
} from "openai/resources/responses/responses";
import { EnlittConfigurationError, EnlittError } from "../core/errors.js";
import {
  assertCallId,
  assertCallerMetadata,
  assertNanoUsd,
  assertReportingDeadlineMs,
  generateRandomCallId,
  isCancellation,
  runPremiumCharge,
  type PremiumChargeHandle,
  type PremiumChargeRequest
} from "../core/premium.js";
import { createSseEventStream } from "../core/sse.js";
import {
  createInternalClient,
  readEnlittJson,
  requestEnlitt,
  type EnlittOptions,
  type InternalEnlittClient
} from "../core/transport.js";

export { ENLITT_STANDARD_MODEL };

export interface EnlittOpenAIRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

export interface EnlittOpenAICallOptions {
  readonly idempotencyKey?: string;
  readonly maxCharge?: string;
  readonly price?: EnlittOpenAIPrice;
  readonly reportingDeadlineMs?: number;
  readonly metadata?: Record<string, string>;
}

export interface OpenAIPremiumPriceContext {
  readonly status: "completed" | "canceled";
  readonly response?: OpenAIResponseResult;
  readonly events?: readonly ResponseStreamEvent[];
  readonly usage?: ResponseUsage;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly effectiveMaxChargeNanoUsd: string;
}

export type EnlittOpenAIPrice = string | ((context: OpenAIPremiumPriceContext) => string | Promise<string>);
export type EnlittOpenAIResponseCreateParamsNonStreaming = ResponseCreateParamsNonStreaming & {
  readonly enlitt?: EnlittOpenAICallOptions;
};
export type EnlittOpenAIResponseCreateParamsStreaming = ResponseCreateParamsStreaming & {
  readonly enlitt?: EnlittOpenAICallOptions;
};
export type EnlittOpenAIStream = AsyncIterable<ResponseStreamEvent>;

export interface EnlittOpenAIClient {
  readonly responses: {
    create(
      body: EnlittOpenAIResponseCreateParamsNonStreaming,
      options?: EnlittOpenAIRequestOptions
    ): Promise<OpenAIResponseResult>;
    create(
      body: EnlittOpenAIResponseCreateParamsStreaming,
      options?: EnlittOpenAIRequestOptions
    ): Promise<EnlittOpenAIStream>;
  };
}

interface OpenAIResponsesClient {
  readonly responses: {
    create(body: ResponseCreateParamsNonStreaming, options?: EnlittOpenAIRequestOptions): Promise<OpenAIResponseResult>;
    create(body: ResponseCreateParamsStreaming, options?: EnlittOpenAIRequestOptions): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
}

const RESPONSES_PATH = "/v1/responses";
const STANDARD_FIELDS = new Set(["model", "input", "instructions", "max_output_tokens", "tools", "tool_choice", "stream", "metadata", "enlitt"]);

export function enlitt(options?: EnlittOptions): EnlittOpenAIClient;
export function enlitt(client: OpenAI, options?: EnlittOptions): EnlittOpenAIClient;
export function enlitt(first: OpenAI | EnlittOptions = {}, second: EnlittOptions = {}): EnlittOpenAIClient {
  const looksLikeClient = hasResponsesProperty(first);
  let provider: OpenAIResponsesClient | undefined;
  let options: EnlittOptions;

  if (looksLikeClient) {
    if (!isOpenAIClient(first)) {
      throw new EnlittConfigurationError("The OpenAI client must expose responses.create().");
    }
    provider = first;
    options = second;
  } else {
    options = first as EnlittOptions;
  }

  const client = createInternalClient(options);
  return {
    responses: {
      create: (body: EnlittOpenAIResponseCreateParamsNonStreaming | EnlittOpenAIResponseCreateParamsStreaming, requestOptions?: EnlittOpenAIRequestOptions) => {
        validateRequestOptions(requestOptions);
        return body.model === ENLITT_STANDARD_MODEL
          ? createStandardResponse(client, body, requestOptions)
          : createPremiumResponse(client, provider, body, requestOptions);
      }
    }
  } as EnlittOpenAIClient;
}

function hasResponsesProperty(value: unknown): boolean {
  return typeof value === "object" && value !== null && "responses" in value;
}

function isOpenAIClient(value: unknown): value is OpenAIResponsesClient {
  if (!hasResponsesProperty(value)) return false;
  const responses = (value as { responses?: unknown }).responses;
  return typeof responses === "object" && responses !== null && typeof (responses as { create?: unknown }).create === "function";
}

function validateRequestOptions(options: EnlittOpenAIRequestOptions | undefined): void {
  if (options === undefined) return;
  for (const key of Object.keys(options)) {
    if (key !== "signal" && key !== "timeout") {
      throw new EnlittConfigurationError(`OpenAI request option "${key}" is not supported by the Enlitt adapter.`);
    }
  }
  if (options.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout <= 0)) {
    throw new EnlittConfigurationError("OpenAI request option timeout must be a positive safe integer.");
  }
}

function readCallOptions(body: { enlitt?: EnlittOpenAICallOptions }, mode: "standard" | "premium") {
  const input = body.enlitt ?? {};
  const known = new Set(["idempotencyKey", "maxCharge", "price", "reportingDeadlineMs", "metadata"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new EnlittConfigurationError(`enlitt.${key} is not a recognized Enlitt option.`);
  }
  if (mode === "standard" && (input.maxCharge !== undefined || input.price !== undefined || input.reportingDeadlineMs !== undefined)) {
    throw new EnlittConfigurationError("maxCharge, price, and reportingDeadlineMs are premium-only options.");
  }
  const idempotencyKey = input.idempotencyKey === undefined ? generateRandomCallId() : assertCallId(input.idempotencyKey);
  const metadata = input.metadata === undefined ? undefined : assertCallerMetadata(input.metadata, "enlitt.metadata");
  if (mode === "standard") return { idempotencyKey, metadata };

  const price = input.price;
  if (price !== undefined && typeof price !== "string" && typeof price !== "function") {
    throw new EnlittConfigurationError("enlitt.price must be a canonical NANOUSD string or a function.");
  }
  const constantPrice = typeof price === "string" ? assertNanoUsd(price, "enlitt.price") : price;
  const maxCharge = input.maxCharge === undefined
    ? (typeof constantPrice === "string" ? constantPrice : undefined)
    : assertNanoUsd(input.maxCharge, "enlitt.maxCharge");
  if (maxCharge === undefined) {
    throw new EnlittConfigurationError("A premium call requires enlitt.maxCharge, or a constant enlitt.price.");
  }
  if (typeof constantPrice === "string" && BigInt(constantPrice) > BigInt(maxCharge)) {
    throw new EnlittConfigurationError("enlitt.price cannot exceed enlitt.maxCharge.");
  }
  const reportingDeadlineMs = input.reportingDeadlineMs === undefined
    ? undefined
    : assertReportingDeadlineMs(input.reportingDeadlineMs, "enlitt.reportingDeadlineMs");
  return { idempotencyKey, metadata, maxCharge, price: constantPrice, reportingDeadlineMs };
}

function timedSignal(options: EnlittOpenAIRequestOptions | undefined): { signal?: AbortSignal; cleanup(): void } {
  if (options?.timeout === undefined) return { ...(options?.signal !== undefined ? { signal: options.signal } : {}), cleanup: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "AbortError")), options.timeout);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}

async function createStandardResponse(
  client: InternalEnlittClient,
  body: EnlittOpenAIResponseCreateParamsNonStreaming | EnlittOpenAIResponseCreateParamsStreaming,
  options?: EnlittOpenAIRequestOptions
): Promise<OpenAIResponseResult | EnlittOpenAIStream> {
  const call = readCallOptions(body, "standard");
  const request = buildStandardRequest(body, call.metadata);
  const timed = timedSignal(options);
  try {
    const response = await requestEnlitt(client, {
      path: RESPONSES_PATH,
      body: request,
      callId: call.idempotencyKey,
      accept: body.stream === true ? "text/event-stream" : "application/json",
      ...(timed.signal !== undefined ? { signal: timed.signal } : {})
    });
    if (body.stream === true) {
      if (response.body === null) throw new EnlittError("malformed_response", "Enlitt's streaming response carried no body.");
      return mapStandardStream(response.body, () => timed.cleanup());
    }
    const parsed = validateOpenAIResponse(await readEnlittJson(response), { mode: "tolerant" });
    if (!parsed.ok) throw malformed(parsed.error.message, parsed.error.param);
    return mapStandardResponse(parsed.value);
  } finally {
    if (body.stream !== true) timed.cleanup();
  }
}

function buildStandardRequest(
  body: EnlittOpenAIResponseCreateParamsNonStreaming | EnlittOpenAIResponseCreateParamsStreaming,
  metadata?: Record<string, string>
): EnlittStandardRequest {
  for (const key of Object.keys(body)) {
    if (!STANDARD_FIELDS.has(key)) throw new EnlittConfigurationError(`OpenAI field "${key}" is not supported by Enlitt's standard route.`);
  }
  const messages: EnlittStandardMessage[] = [];
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== "string") throw new EnlittConfigurationError("Standard instructions must be a string.");
    messages.push({ role: "system", content: body.instructions });
  }
  messages.push(...mapInput(body.input));

  const draft: Record<string, unknown> = { model: ENLITT_STANDARD_MODEL, messages };
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) draft.max_output_tokens = body.max_output_tokens;
  if (body.stream === true) draft.stream = true;
  if (metadata !== undefined) draft.metadata = metadata;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (metadata !== undefined) throw new EnlittConfigurationError("Supply metadata under enlitt.metadata, not both metadata locations.");
    draft.metadata = assertCallerMetadata(body.metadata, "metadata");
  }
  if (body.tool_choice !== undefined && body.tool_choice !== "auto" && body.tool_choice !== "none") {
    throw new EnlittConfigurationError("Standard tool_choice supports only auto or none.");
  }
  if (body.tools !== undefined && body.tool_choice !== "none") {
    draft.tools = body.tools.map((tool, index) => {
      const value = tool as unknown as Record<string, unknown>;
      if (value.type !== "function") throw new EnlittConfigurationError(`tools[${index}] must be a function tool.`);
      if (value.strict !== undefined) throw new EnlittConfigurationError(`tools[${index}].strict is not supported.`);
      return { name: value.name, ...(value.description !== undefined ? { description: value.description } : {}), input_schema: value.parameters };
    });
  }
  const validated = validateEnlittStandardRequest(draft);
  if (!validated.ok) throw new EnlittConfigurationError(`${validated.error.message} (${validated.error.param})`);
  return validated.value;
}

function mapInput(input: unknown): EnlittStandardMessage[] {
  if (typeof input === "string") return [{ role: "user", content: [{ type: "text", text: input }] }];
  if (!Array.isArray(input)) throw new EnlittConfigurationError("Standard input must be a string or an array of supported input items.");
  return input.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new EnlittConfigurationError(`input[${index}] is not supported.`);
    const value = item as Record<string, unknown>;
    if (value.type === "function_call") {
      return { role: "assistant", tool_calls: [{ id: String(value.call_id), name: String(value.name), arguments: String(value.arguments) }] };
    }
    if (value.type === "function_call_output") {
      if (typeof value.output !== "string") throw new EnlittConfigurationError(`input[${index}].output must be a string.`);
      return { role: "tool", tool_call_id: String(value.call_id), content: value.output };
    }
    const role = value.role;
    if (role !== "user" && role !== "system" && role !== "developer" && role !== "assistant") {
      throw new EnlittConfigurationError(`input[${index}].role is not supported.`);
    }
    const content = value.content;
    if (role === "system" || role === "developer") {
      if (typeof content !== "string") throw new EnlittConfigurationError(`input[${index}].content must be a string.`);
      return { role: "system", content };
    }
    if (role === "assistant") {
      if (typeof content !== "string") throw new EnlittConfigurationError(`input[${index}].content must be a string.`);
      return { role: "assistant", content };
    }
    const parts = typeof content === "string" ? [{ type: "input_text", text: content }] : content;
    if (!Array.isArray(parts)) throw new EnlittConfigurationError(`input[${index}].content is not supported.`);
    return {
      role: "user",
      content: parts.map((part, partIndex) => {
        const p = part as Record<string, unknown>;
        if (p.type === "input_text" && typeof p.text === "string") return { type: "text" as const, text: p.text };
        if (p.type === "input_image" && typeof p.image_url === "string") {
          const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(p.image_url);
          return match
            ? { type: "image" as const, source: { type: "base64" as const, media_type: match[1] as "image/png" | "image/jpeg", data: match[2]! } }
            : { type: "image" as const, source: { type: "url" as const, url: p.image_url } };
        }
        throw new EnlittConfigurationError(`input[${index}].content[${partIndex}] is not supported.`);
      })
    };
  });
}

function mapStandardResponse(value: OpenAIResponse): OpenAIResponseResult {
  const known = value.output.filter((item): item is Exclude<typeof item, { readonly unknown: true }> => !("unknown" in item));
  const output = known.map((item) => item.type === "message"
    ? { ...item, content: item.content.filter((part) => !("unknown" in part)).map((part) => ({ ...part, annotations: [] })) }
    : item);
  return {
    id: value.id,
    access_programs: null,
    created_at: value.created_at,
    ...(value.completed_at !== undefined ? { completed_at: value.completed_at } : {}),
    output_text: value.output_text ?? output.flatMap((item) => item.type === "message" ? item.content.flatMap((part) => "text" in part ? [part.text] : []) : []).join(""),
    error: value.error,
    incomplete_details: value.incomplete_details,
    instructions: null,
    metadata: value.metadata,
    model: ENLITT_STANDARD_MODEL,
    object: "response",
    output,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: value.status === "other" ? "failed" : value.status,
    usage: value.usage
  } as unknown as OpenAIResponseResult;
}

async function* mapStandardStream(stream: ReadableStream<Uint8Array>, cleanup: () => void): EnlittOpenAIStream {
  let previous: { readonly type: string; readonly sequence_number: number } | undefined;
  let previousJson: string | undefined;
  let sawTerminal = false;
  try {
    for await (const framed of createSseEventStream(stream)) {
      if (sawTerminal) throw malformed("a stream event followed the terminal event", "body");
      let json: unknown;
      try { json = JSON.parse(framed.data); } catch { throw malformed("stream event was not valid JSON", "body"); }
      const parsed = validateResponseStreamEvent(json, { mode: "tolerant" });
      if (!parsed.ok) throw malformed(parsed.error.message, parsed.error.param);
      const event = parsed.value;
      const eventJson = JSON.stringify(event);
      if (previous === undefined) {
        if (event.type !== "response.created") {
          throw malformed('the first stream event was not "response.created"', "body");
        }
      } else if (event.sequence_number === previous.sequence_number) {
        if (eventJson === previousJson) continue;
        throw malformed("two stream events reused a sequence number with different content", "body");
      } else if (event.sequence_number !== previous.sequence_number + 1) {
        throw malformed("stream event sequence numbers were not contiguous", "body");
      }
      previous = event;
      previousJson = eventJson;
      if ("unknown" in event) continue;
      const mapped = mapStandardEvent(event);
      if (mapped !== undefined) yield mapped;
      sawTerminal = event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed";
    }
    if (!sawTerminal) throw malformed("the stream ended without a terminal event", "body");
  } finally {
    cleanup();
  }
}

function mapStandardEvent(event: EnlittResponseStreamEvent): ResponseStreamEvent | undefined {
  if ("response" in event) return { ...event, response: mapStandardResponse(event.response) };
  if ("item" in event) {
    if ("unknown" in event.item) return undefined;
    const item = event.item.type === "message"
      ? { ...event.item, content: event.item.content.filter((part) => !("unknown" in part)).map((part) => ({ ...part, annotations: [] })) }
      : event.item;
    return { ...event, item } as ResponseStreamEvent;
  }
  if ("part" in event) {
    if ("unknown" in event.part) return undefined;
    return { ...event, part: { ...event.part, annotations: [] } };
  }
  return event as ResponseStreamEvent;
}

function malformed(message: string, param: string): EnlittError {
  return new EnlittError("malformed_response", `Enlitt's response could not be validated: ${message} (${param}).`);
}

async function createPremiumResponse(
  client: InternalEnlittClient,
  provider: OpenAIResponsesClient | undefined,
  body: EnlittOpenAIResponseCreateParamsNonStreaming | EnlittOpenAIResponseCreateParamsStreaming,
  options?: EnlittOpenAIRequestOptions
): Promise<OpenAIResponseResult | EnlittOpenAIStream> {
  if (provider === undefined) throw new EnlittConfigurationError("A premium OpenAI model requires an OpenAI client passed to enlitt().");
  if (typeof body.model !== "string" || body.model.length === 0) throw new EnlittConfigurationError("A premium OpenAI call requires a model name.");
  if ((body as { background?: unknown }).background === true) throw new EnlittConfigurationError("Background OpenAI responses are not supported.");
  const call = readCallOptions(body, "premium");
  const { enlitt: _removed, ...providerBody } = body;
  const request: PremiumChargeRequest = {
    maxCharge: call.maxCharge!,
    provider: { id: "openai", model: body.model },
    callId: call.idempotencyKey,
    ...(call.reportingDeadlineMs !== undefined ? { reportingDeadlineMs: call.reportingDeadlineMs } : {}),
    ...(call.metadata !== undefined ? { metadata: call.metadata } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {})
  };
  return body.stream === true
    ? wrapPremiumStream(client, provider, request, call.price, providerBody as ResponseCreateParamsStreaming, options)
    : wrapPremiumResponse(client, provider, request, call.price, providerBody as ResponseCreateParamsNonStreaming, options);
}

class TerminalResponse<T> extends Error {
  constructor(readonly result: T, canceled: boolean) { super(); this.name = canceled ? "AbortError" : "TerminalResponse"; }
}

async function wrapPremiumResponse(
  client: InternalEnlittClient,
  provider: OpenAIResponsesClient,
  request: PremiumChargeRequest,
  price: EnlittOpenAIPrice | undefined,
  body: ResponseCreateParamsNonStreaming,
  options?: EnlittOpenAIRequestOptions
): Promise<OpenAIResponseResult> {
  try {
    return await runPremiumCharge(client, request, async (charge, operation) => {
      const startedAt = new Date();
      let response: OpenAIResponseResult;
      try {
        response = await provider.responses.create(body, options);
      } catch (error) {
        if (isCancellation(error, request.signal)) {
          const endedAt = new Date();
          charge(await evaluatePrice(
            client,
            price,
            contextForEvents(
              undefined,
              undefined,
              startedAt,
              endedAt,
              operation,
              undefined,
              "canceled"
            )
          ));
          describe(operation, startedAt, endedAt, undefined, "canceled");
        }
        throw error;
      }
      const endedAt = new Date();
      const canceled = response.status === "cancelled";
      if (response.status !== "failed") charge(await evaluatePrice(client, price, contextForResponse(response, startedAt, endedAt, operation, canceled)));
      describe(operation, startedAt, endedAt, response, response.status === "failed" ? "provider" : canceled ? "canceled" : undefined);
      if (response.status === "failed" || canceled) throw new TerminalResponse(response, canceled);
      return response;
    });
  } catch (thrown) {
    if (thrown instanceof TerminalResponse) return thrown.result as OpenAIResponseResult;
    throw thrown;
  }
}

async function wrapPremiumStream(
  client: InternalEnlittClient,
  provider: OpenAIResponsesClient,
  request: PremiumChargeRequest,
  price: EnlittOpenAIPrice | undefined,
  body: ResponseCreateParamsStreaming,
  options?: EnlittOpenAIRequestOptions
): Promise<EnlittOpenAIStream> {
  let expose!: (stream: EnlittOpenAIStream) => void;
  let rejectExpose!: (error: unknown) => void;
  const exposed = new Promise<EnlittOpenAIStream>((resolve, reject) => { expose = resolve; rejectExpose = reject; });
  let wasExposed = false;
  void runPremiumCharge(client, request, async (charge, operation) => {
    const startedAt = new Date();
    let source: AsyncIterable<ResponseStreamEvent>;
    try {
      source = await provider.responses.create(body, options);
    } catch (error) {
      if (isCancellation(error, request.signal)) {
        const endedAt = new Date();
        charge(await evaluatePrice(
          client,
          price,
          contextForEvents(
            typeof price === "function" ? [] : undefined,
            undefined,
            startedAt,
            endedAt,
            operation,
            undefined,
            "canceled"
          )
        ));
        describe(operation, startedAt, endedAt, undefined, "canceled");
      }
      rejectExpose(error);
      throw error;
    }
    let settle!: (value?: void) => void;
    let fail!: (error: unknown) => void;
    const terminal = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
    wasExposed = true;
    expose(streamWithSettlement(source, price, client, charge, operation, startedAt, settle, fail, request.signal));
    return terminal;
  }).catch((error) => { if (!wasExposed) rejectExpose(error); });
  return exposed;
}

async function* streamWithSettlement(
  source: AsyncIterable<ResponseStreamEvent>,
  price: EnlittOpenAIPrice | undefined,
  client: InternalEnlittClient,
  charge: (amount: string) => void,
  operation: PremiumChargeHandle,
  startedAt: Date,
  settle: () => void,
  fail: (error: unknown) => void,
  signal?: AbortSignal
): EnlittOpenAIStream {
  const events = typeof price === "function" ? [] as ResponseStreamEvent[] : undefined;
  let terminal = false;
  let firstTokenAt: Date | undefined;
  try {
    for await (const event of source) {
      events?.push(event);
      if (firstTokenAt === undefined && (event.type === "response.output_text.delta" || event.type === "response.function_call_arguments.delta")) firstTokenAt = new Date();
      yield event;
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        terminal = true;
        const endedAt = new Date();
        charge(await evaluatePrice(client, price, contextForEvents(events, event.response.usage, startedAt, endedAt, operation, firstTokenAt, "completed")));
        describe(operation, startedAt, endedAt, event.response);
        settle();
        return;
      }
      if (event.type === "response.failed") {
        terminal = true;
        describe(operation, startedAt, new Date(), event.response, "provider");
        fail(new Error("OpenAI response failed"));
        return;
      }
    }
    terminal = true;
    fail(new Error("OpenAI stream ended without a terminal event"));
  } catch (error) {
    if (!terminal) {
      terminal = true;
      const endedAt = new Date();
      if (isCancellation(error, signal)) {
        charge(await evaluatePrice(
          client,
          price,
          contextForEvents(events, undefined, startedAt, endedAt, operation, firstTokenAt, "canceled")
        ));
        describe(operation, startedAt, endedAt, undefined, "canceled");
      } else {
        describe(operation, startedAt, endedAt, undefined, "provider");
      }
      fail(error);
    }
    throw error;
  } finally {
    if (!terminal) {
      const endedAt = new Date();
      charge(await evaluatePrice(client, price, contextForEvents(events, undefined, startedAt, endedAt, operation, firstTokenAt, "canceled")));
      describe(operation, startedAt, endedAt, undefined, "canceled");
      fail(new DOMException("OpenAI stream canceled", "AbortError"));
    }
  }
}

function contextForResponse(response: OpenAIResponseResult, startedAt: Date, endedAt: Date, operation: PremiumChargeHandle, canceled: boolean): OpenAIPremiumPriceContext {
  return { status: canceled ? "canceled" : "completed", response, ...(response.usage !== undefined ? { usage: response.usage } : {}), startedAt, endedAt, durationMs: endedAt.getTime() - startedAt.getTime(), effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd };
}

function contextForEvents(events: ResponseStreamEvent[] | undefined, usage: ResponseUsage | undefined, startedAt: Date, endedAt: Date, operation: PremiumChargeHandle, firstTokenAt: Date | undefined, status: "completed" | "canceled"): OpenAIPremiumPriceContext {
  return { status, ...(events !== undefined ? { events } : {}), ...(usage !== undefined ? { usage } : {}), startedAt, endedAt, durationMs: endedAt.getTime() - startedAt.getTime(), ...(firstTokenAt !== undefined ? { timeToFirstTokenMs: firstTokenAt.getTime() - startedAt.getTime() } : {}), effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd };
}

async function evaluatePrice(client: InternalEnlittClient, price: EnlittOpenAIPrice | undefined, context: OpenAIPremiumPriceContext): Promise<string> {
  if (price === undefined) return "0";
  if (typeof price === "string") return price;
  try { return assertNanoUsd(await price(context), "price() result"); }
  catch (error) {
    client.onTerminalReportError?.(error instanceof EnlittError ? error : new EnlittConfigurationError(`The price function failed, so the call was charged "0": ${error instanceof Error ? error.message : String(error)}`));
    return "0";
  }
}

function describe(operation: PremiumChargeHandle, startedAt: Date, endedAt: Date, response?: OpenAIResponseResult, errorCategory?: "provider" | "canceled"): void {
  const usage = response?.usage as ({
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  }) | undefined;
  operation.describe({
    timing: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
    delivery: { outputStarted: response !== undefined, outputCompleted: response !== undefined && response.status !== "failed" },
    ...(response?.id !== undefined ? { providerResponseId: response.id } : {}),
    ...(usage !== undefined ? {
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.input_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
          : {}),
        ...(usage.output_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
          : {})
      }
    } : {}),
    ...(errorCategory !== undefined ? { errorCategory } : {})
  });
}

export function perToken(rates: { readonly input: string; readonly output: string }): (context: OpenAIPremiumPriceContext) => string {
  const input = BigInt(assertNanoUsd(rates.input, "perToken input rate"));
  const output = BigInt(assertNanoUsd(rates.output, "perToken output rate"));
  return (context) => (input * BigInt(context.usage?.input_tokens ?? 0) + output * BigInt(context.usage?.output_tokens ?? 0)).toString();
}
