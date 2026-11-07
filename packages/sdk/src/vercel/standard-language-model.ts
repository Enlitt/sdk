/**
 * Implements the whole-request path, where Enlitt is the model provider.
 *
 * `specs/SDK-side routing.md` gives this file the job of mapping a pinned
 * Vercel AI SDK call into Enlitt's standard request (`EnlittStandardRequest`),
 * sending the complete request to Enlitt over `core/transport.ts`, and mapping
 * the response or event stream back into provider-interface parts. It is kept
 * separate from `premium-language-model.ts` because the two paths send Enlitt
 * fundamentally different things (a whole request here, a content-free billing
 * lifecycle there), and conflating them would make it possible for a change to
 * one to leak a field into the other.
 *
 * The business supplies no provider model: `model: "enlitt-standard"` is the
 * only value this file ever sends, and no parameter anywhere here can override
 * it. `buildStandardRequest()` is also the standard framework-normalization
 * boundary: anything the standard capability floor does not carry is rejected
 * there with `EnlittConfigurationError`, before any request, and never silently
 * dropped or deferred to route selection.
 *
 * Responses and stream events are read in tolerant mode, so a newer server's
 * additions (an unknown enum member, output item, content part, or stream event)
 * degrade into `"other"`, a skipped item, or a skipped event instead of an
 * error. Nothing here ever receives or displays a credit, balance, or tier
 * fact: the wire schemas carry none.
 */

import {
  ENLITT_STANDARD_MODEL,
  isTerminalResponseStreamEventType,
  validateEnlittStandardRequest,
  validateOpenAIResponse,
  validateResponseStreamEvent,
  type EnlittAssistantMessage,
  type EnlittFunctionTool,
  type EnlittStandardMessage,
  type EnlittStandardRequest,
  type EnlittToolCall,
  type EnlittUserPart,
  type OpenAIResponse,
  type ResponseOutputItem,
  type ResponseStreamEvent,
  type UnknownResponseStreamEvent,
  type UnknownVariant
} from "@enlitt/protocol";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning
} from "@ai-sdk/provider";
import { EnlittConfigurationError, EnlittError } from "../core/errors.js";
import { readEnlittJson, requestEnlitt, type InternalEnlittClient } from "../core/transport.js";
import { createSseEventStream, SseFramingError, type SseEvent } from "../core/sse.js";
import { readEnlittCallOptions, resolveCallId, type EnlittProviderOptions } from "./language-model.js";

/**
 * Derived rather than invented, per the shared type conventions: the pinned
 * package exports no name for what `doGenerate()` returns, so this alias is the
 * only place that fact is stated, and it can never drift from the interface it
 * claims to implement.
 */
type GenerateResult = Awaited<ReturnType<LanguageModelV3["doGenerate"]>>;

/** Same reasoning as {@link GenerateResult}, for `doStream()`. */
type StreamResult = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

/** The one relative path this file ever calls, from `specs/PROTOCOLS.md` "Create model response". */
const RESPONSES_PATH = "/v1/responses";

/**
 * Enlitt's own reserved response metadata keys, mapped one-to-one onto
 * `providerMetadata.enlitt`. Reading exactly these four and nothing else keeps
 * a future reserved key (say, a plan fact) from silently reaching a caller just
 * because it showed up in the same map.
 */
const ENLITT_METADATA_KEYS = {
  operationId: "enlitt_operation_id",
  routedProvider: "enlitt_routed_provider",
  routedModel: "enlitt_routed_model",
  policyVersion: "enlitt_policy_version"
} as const;

/**
 * The `providerMetadata.enlitt` shape this module ever produces. Never a
 * credit, balance, limit, tier, or period fact. The index signature is what
 * lets it satisfy `SharedV3ProviderMetadata` structurally.
 */
interface EnlittRoutingMetadata {
  readonly operationId?: string;
  readonly routedProvider?: string;
  readonly routedModel?: string;
  readonly policyVersion?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Implements `doGenerate()` and `doStream()` for the pinned Vercel AI SDK
 * provider interface, with `modelId` `"enlitt-standard"`.
 *
 * Every invocation follows the sequence the spec names:
 * `readEnlittCallOptions()`, `resolveCallId()`, `buildStandardRequest()`,
 * `requestEnlitt()`. The call ID used for `Idempotency-Key` is therefore derived
 * before the body it protects is built, and a caller's options are read exactly
 * once. This function contains no session logic and no error classification of
 * its own: both live in `transport.ts` and `errors.ts`.
 */
export function createStandardLanguageModel(client: InternalEnlittClient): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "enlitt",
    modelId: ENLITT_STANDARD_MODEL,
    // Every URL is downloaded by the caller or sent as an image URL rather than
    // referenced natively: no pattern is claimed because none can be verified.
    supportedUrls: {},

    async doGenerate(params: LanguageModelV3CallOptions): Promise<GenerateResult> {
      const options = readEnlittCallOptions(params.providerOptions, "standard");
      const callId = resolveCallId(options, params);
      const body = buildStandardRequest(params, options, callId);

      const response = await requestEnlitt(client, {
        path: RESPONSES_PATH,
        body,
        callId,
        accept: "application/json",
        ...(params.abortSignal !== undefined ? { signal: params.abortSignal } : {})
      });

      // Tolerant in: unknown fields are dropped and unknown enum members read as "other".
      const validated = validateOpenAIResponse(await readEnlittJson(response), { mode: "tolerant" });
      if (!validated.ok) {
        throw new EnlittError(
          "malformed_response",
          `Enlitt's response could not be validated: ${validated.error.message} (${validated.error.param}).`
        );
      }
      return mapStandardGenerateResponse(validated.value);
    },

    async doStream(params: LanguageModelV3CallOptions): Promise<StreamResult> {
      const options = readEnlittCallOptions(params.providerOptions, "standard");
      const callId = resolveCallId(options, params);
      const body = buildStandardRequest(params, options, callId, true);

      const response = await requestEnlitt(client, {
        path: RESPONSES_PATH,
        body,
        callId,
        accept: "text/event-stream",
        ...(params.abortSignal !== undefined ? { signal: params.abortSignal } : {})
      });
      if (response.body === null) {
        throw new EnlittError("malformed_response", "Enlitt's streaming response carried no body.");
      }
      const events = createSseEventStream(response.body);
      return { stream: mapStandardStream(events, params.abortSignal) };
    }
  };
}

// --- Request mapping --------------------------------------------------

/**
 * True when a prompt-level, part-level, or tool-level `providerOptions` object
 * carries anything: standard has no provider-specific per-item controls (an
 * image detail level, a cache hint), so none can be honored and none is dropped.
 */
function hasProviderOptions(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/** Rejects a per-item `providerOptions` instead of silently ignoring it. */
function rejectItemProviderOptions(value: unknown, where: string): void {
  if (hasProviderOptions(value)) {
    throw new EnlittConfigurationError(
      `Enlitt's standard route does not support provider-specific options on ${where}; remove its providerOptions.`
    );
  }
}

/**
 * Maps supported Vercel input into an `EnlittStandardRequest` and validates it
 * with the protocol's strict validator, so a body built here can never diverge
 * from what the wire accepts.
 *
 * Uses `model: "enlitt-standard"` unconditionally. It never sends a provider or
 * model override, `conversation`, `previous_response_id`, `store`, `background`,
 * `include`, `service_tier`, or any other field the protocol rejects, and it
 * raises `EnlittConfigurationError` for each unsupported capability instead of
 * dropping it: structured response formats, sampling controls (temperature,
 * topP, topK, penalties, seed, stop sequences), required or named tool choice,
 * provider-defined tools, file/audio/video parts, reasoning, and
 * provider-specific options.
 *
 * `stream` is the fourth, optional argument because the call site, not the
 * prompt, decides it; it defaults to `false` and is omitted from the body then.
 */
export function buildStandardRequest(
  params: LanguageModelV3CallOptions,
  options: EnlittProviderOptions,
  callId: string,
  stream = false
): EnlittStandardRequest {
  void callId; // The call ID travels as `Idempotency-Key`, not as a body field.

  rejectUnsupportedCallControls(params);

  const draft: Record<string, unknown> = {
    model: ENLITT_STANDARD_MODEL,
    messages: mapPromptToMessages(params.prompt)
  };

  // Unset or "auto" sends the tools and relies on automatic selection; "none"
  // omits them; required or a named tool cannot be honored and fails locally.
  const choice = params.toolChoice?.type;
  if (choice === "required" || choice === "tool") {
    throw new EnlittConfigurationError(
      "Enlitt's standard route supports only automatic tool choice; remove `toolChoice` or set it to auto or none."
    );
  }
  if (choice !== "none" && params.tools !== undefined && params.tools.length > 0) {
    draft.tools = mapTools(params.tools);
  }

  if (params.maxOutputTokens !== undefined) {
    draft.max_output_tokens = params.maxOutputTokens;
  }
  if (stream) {
    draft.stream = true;
  }
  if (options.metadata !== undefined) {
    draft.metadata = options.metadata;
  }

  const validated = validateEnlittStandardRequest(draft);
  if (!validated.ok) {
    throw new EnlittConfigurationError(
      `The call could not be mapped to Enlitt's standard request shape: ${validated.error.message} (${validated.error.param}).`
    );
  }
  return validated.value;
}

/** Rejects every call-level control the standard capability floor does not carry. */
function rejectUnsupportedCallControls(params: LanguageModelV3CallOptions): void {
  const unsupported: [string, boolean][] = [
    ["temperature", params.temperature !== undefined],
    ["topP", params.topP !== undefined],
    ["topK", params.topK !== undefined],
    ["presencePenalty", params.presencePenalty !== undefined],
    ["frequencyPenalty", params.frequencyPenalty !== undefined],
    ["seed", params.seed !== undefined],
    ["stopSequences", params.stopSequences !== undefined && params.stopSequences.length > 0],
    // A "text" response format is the default and carries nothing; "json" is structured output.
    ["responseFormat", params.responseFormat !== undefined && params.responseFormat.type !== "text"]
  ];
  for (const [name, present] of unsupported) {
    if (present) {
      throw new EnlittConfigurationError(
        `Enlitt's standard route does not support \`${name}\`; remove it from the call.`
      );
    }
  }

  // Everything other than the Enlitt namespace is provider-specific (reasoning
  // controls, parallel-tool settings, image detail, and so on) and unsupported.
  for (const namespace of Object.keys(params.providerOptions ?? {})) {
    if (namespace !== "enlitt") {
      throw new EnlittConfigurationError(
        `Enlitt's standard route does not support provider-specific options (providerOptions.${namespace}); remove them.`
      );
    }
  }
}

/**
 * Maps the pinned prompt array to the protocol's ordered `messages`. A `tool`
 * role message's results each become their own tool message, in order.
 */
function mapPromptToMessages(prompt: LanguageModelV3CallOptions["prompt"]): EnlittStandardMessage[] {
  const messages: EnlittStandardMessage[] = [];
  for (const message of prompt) {
    rejectItemProviderOptions(message.providerOptions, `a ${message.role} message`);
    switch (message.role) {
      case "system": {
        messages.push({ role: "system", content: message.content });
        break;
      }
      case "user": {
        messages.push({ role: "user", content: message.content.map(mapUserPart) });
        break;
      }
      case "assistant": {
        messages.push(mapAssistantMessage(message.content));
        break;
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-approval-response") {
            throw new EnlittConfigurationError(
              "Enlitt's standard route does not support tool approval responses; remove the approval response."
            );
          }
          rejectItemProviderOptions(part.providerOptions, "a tool result");
          messages.push({ role: "tool", tool_call_id: part.toolCallId, content: mapToolResultOutput(part.output) });
        }
        break;
      }
    }
  }
  return messages;
}

/** Maps one user part: text stays text, an image keeps its position, anything else is rejected. */
function mapUserPart(
  part: Extract<LanguageModelV3CallOptions["prompt"][number], { role: "user" }>["content"][number]
): EnlittUserPart {
  rejectItemProviderOptions(part.providerOptions, `a user ${part.type} part`);
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (!part.mediaType.startsWith("image/")) {
    throw new EnlittConfigurationError(
      `Enlitt's standard route supports only text and image parts; "${part.mediaType}" files are not supported.`
    );
  }
  if (part.data instanceof URL) {
    return { type: "image", source: { type: "url", url: part.data.toString() } };
  }
  const data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
  // The protocol validator is the authority on which media types are accepted.
  return { type: "image", source: { type: "base64", media_type: part.mediaType as "image/png", data } };
}

/** Maps an assistant message's text and tool calls; reasoning, files, and provider-run tools are rejected. */
function mapAssistantMessage(
  content: Extract<LanguageModelV3CallOptions["prompt"][number], { role: "assistant" }>["content"]
): EnlittAssistantMessage {
  let text = "";
  const toolCalls: EnlittToolCall[] = [];
  for (const part of content) {
    rejectItemProviderOptions(part.providerOptions, `an assistant ${part.type} part`);
    switch (part.type) {
      case "text":
        text += part.text;
        break;
      case "tool-call": {
        if (part.providerExecuted === true) {
          throw new EnlittConfigurationError(
            "Enlitt's standard route does not support provider-executed tool calls in history."
          );
        }
        toolCalls.push({
          id: part.toolCallId,
          name: part.toolName,
          arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input)
        });
        break;
      }
      case "file":
      case "reasoning":
      case "tool-result":
        throw new EnlittConfigurationError(
          `Enlitt's standard route does not support an assistant "${part.type}" part in history.`
        );
    }
  }
  return {
    role: "assistant",
    ...(text.length > 0 ? { content: text } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  };
}

/** Renders a tool result's output as the string the protocol's tool message carries. */
function mapToolResultOutput(output: { readonly type: string; readonly value?: unknown }): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value);
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    default:
      throw new EnlittConfigurationError(
        `Enlitt's standard route does not support a tool result output of type "${output.type}".`
      );
  }
}

/** Maps application-defined function tools; provider-defined tools are rejected. */
function mapTools(tools: NonNullable<LanguageModelV3CallOptions["tools"]>): EnlittFunctionTool[] {
  return tools.map((tool) => {
    if (tool.type !== "function") {
      throw new EnlittConfigurationError(
        "Enlitt's standard route accepts only application-defined function tools, not provider-defined tools."
      );
    }
    rejectItemProviderOptions(tool.providerOptions, `the tool "${tool.name}"`);
    if (tool.strict !== undefined) {
      throw new EnlittConfigurationError(
        `Enlitt's standard route does not support strict tool schemas; remove \`strict\` from the tool "${tool.name}".`
      );
    }
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.inputSchema as Record<string, unknown>
    };
  });
}

// --- Non-streaming response mapping ------------------------------------

/** True for a future output item or content part the protocol reader could not interpret. */
function isUnknownVariant(value: object): value is UnknownVariant {
  return "unknown" in value && (value as { unknown?: unknown }).unknown === true;
}

/**
 * Maps `OpenAIResponse` back into `GenerateResult`, preserving text, function
 * calls, finish reason, and exact usage.
 *
 * An output item or content part that is an `UnknownVariant` is skipped and
 * contributes no content. Each distinct unknown `type` adds exactly one `other`
 * warning telling the business to upgrade the SDK, so a newer server never
 * produces a silent gap.
 */
export function mapStandardGenerateResponse(response: OpenAIResponse): GenerateResult {
  const content: LanguageModelV3Content[] = [];
  const skippedTypes = new Set<string>();

  for (const item of response.output) {
    if (isUnknownVariant(item)) {
      skippedTypes.add(item.type);
    } else if (item.type === "message") {
      for (const part of item.content) {
        if (isUnknownVariant(part)) {
          skippedTypes.add(part.type);
        } else {
          content.push({ type: "text", text: part.text });
        }
      }
    } else {
      content.push({ type: "tool-call", toolCallId: item.call_id, toolName: item.name, input: item.arguments });
    }
  }

  const warnings: SharedV3Warning[] = [...skippedTypes].map((type) => ({
    type: "other",
    message:
      `Enlitt returned an output item of type "${type}" that this version of @enlitt/sdk does not recognize ` +
      "and skipped it. Upgrade @enlitt/sdk to receive it."
  }));

  return {
    content,
    finishReason: mapFinishReason(response),
    usage: mapUsage(response),
    warnings,
    ...(hasRoutingMetadata(response) ? { providerMetadata: { enlitt: routingMetadata(response) } } : {})
  };
}

/**
 * Maps a response's terminal facts to the unified finish reason. A status or an
 * incomplete reason read as `"other"` (a newer server's member) is never
 * mapped to `"stop"` and never triggers the tool-call or length branch.
 */
function mapFinishReason(response: OpenAIResponse): LanguageModelV3FinishReason {
  switch (response.status) {
    case "other":
      return { unified: "other", raw: undefined };
    case "failed":
      return { unified: "error", raw: response.error?.code };
    case "incomplete": {
      const reason = response.incomplete_details?.reason;
      if (reason === "max_output_tokens") {
        return { unified: "length", raw: reason };
      }
      return { unified: "other", raw: reason === "other" ? undefined : reason };
    }
    case "completed":
      return response.output.some((item) => !isUnknownVariant(item) && item.type === "function_call")
        ? { unified: "tool-calls", raw: response.status }
        : { unified: "stop", raw: response.status };
    case "in_progress":
    case "queued":
    case "cancelled":
      // Not a finished answer, so not "stop".
      return { unified: "other", raw: response.status };
  }
}

/**
 * Passes `OpenAIResponse.usage` through exactly: no derived figure beyond the
 * documented subtractions, and no default when a token count is absent.
 * `undefined` stays `undefined` rather than becoming `0`, because a zero the
 * provider never reported is a fabricated fact.
 */
function mapUsage(response: OpenAIResponse): LanguageModelV3Usage {
  const usage = response.usage;
  const cachedTokens = usage?.input_tokens_details?.cached_tokens;
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: {
      total: usage?.input_tokens,
      noCache: usage !== undefined && cachedTokens !== undefined ? usage.input_tokens - cachedTokens : undefined,
      cacheRead: cachedTokens,
      cacheWrite: undefined
    },
    outputTokens: {
      total: usage?.output_tokens,
      text:
        usage?.output_tokens !== undefined && reasoningTokens !== undefined
          ? usage.output_tokens - reasoningTokens
          : usage?.output_tokens,
      reasoning: reasoningTokens
    }
  };
}

function hasRoutingMetadata(response: OpenAIResponse): boolean {
  return Object.values(ENLITT_METADATA_KEYS).some((key) => response.metadata[key] !== undefined);
}

/**
 * Reads exactly the four documented `enlitt_*` keys off `response.metadata` by
 * name, never wholesale, so a caller-supplied entry or a future reserved key
 * cannot leak into `providerMetadata.enlitt`.
 */
function routingMetadata(response: OpenAIResponse): EnlittRoutingMetadata {
  const metadata = response.metadata;
  const pick = <K extends keyof typeof ENLITT_METADATA_KEYS>(name: K): Partial<Record<K, string>> => {
    const value = metadata[ENLITT_METADATA_KEYS[name]];
    return value !== undefined ? ({ [name]: value } as Partial<Record<K, string>>) : {};
  };
  return {
    ...pick("operationId"),
    ...pick("routedProvider"),
    ...pick("routedModel"),
    ...pick("policyVersion")
  };
}

// --- Streaming response mapping -----------------------------------------

/** A parsed stream event that may be a future, skipped one. */
type ParsedEvent = ResponseStreamEvent | UnknownResponseStreamEvent;

/** True for an event this version knows (an unknown event has no `response`/`item` payload kept). */
function isKnownEvent(event: ParsedEvent): event is ResponseStreamEvent {
  return !isUnknownVariant(event);
}

/** A known terminal event; an unknown event is never terminal. */
function isTerminalEvent(event: ParsedEvent): boolean {
  return isKnownEvent(event) && isTerminalResponseStreamEventType(event.type);
}

/** Structural equality over parsed events, to tell an identical repeat from a conflicting duplicate. */
function sameEvent(a: ParsedEvent, b: ParsedEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Consumes the events `createSseEventStream()` produces, parses each `data`
 * payload in tolerant mode, enforces the ordering rule incrementally, and emits
 * provider-interface stream parts one event at a time.
 *
 * Ordering: the first event must be `response.created`; each next event's
 * `sequence_number` must be exactly one more than the previous (a gap or a
 * lower number is rejected), except an identical repeat of the last event,
 * which is absorbed; nothing may follow the terminal event; and a stream that
 * ends without a known terminal event is rejected. An unknown event takes part
 * in the sequence check but emits nothing and is never terminal.
 *
 * Every protocol violation (bad JSON, a bad shape, a gap, an out-of-order or
 * conflicting event, a missing or trailing terminal) ends the stream with one
 * `error` part carrying a `malformed_response` `EnlittError`, then closes it.
 * A failed response terminates with a single `finish` part whose reason is
 * `"error"`. Abort and source read failures error the stream with the
 * underlying reason.
 *
 * Backpressure and cancellation are preserved: `pull` reads and enqueues at
 * most one batch of parts per consumer pull, so the consumer's read rate
 * governs how far the HTTP read runs ahead, and `cancel` and `signal` abort the
 * same in-flight request. No event content is buffered whole, copied, hashed,
 * or logged.
 */
export function mapStandardStream(
  events: ReadableStream<SseEvent>,
  signal?: AbortSignal
): ReadableStream<LanguageModelV3StreamPart> {
  const reader = events.getReader();
  let lastEvent: ParsedEvent | undefined;
  let terminated = false;
  // Set once the terminal part has been emitted but before `terminated`: data
  // after the terminal event can only be detected by reading one event past it.
  let sawTerminal = false;
  const openText = new Set<string>();
  // Function-call items announced by `output_item.added`, keyed by item ID, so
  // later deltas and the done event can recover the call ID and tool name.
  const toolItems = new Map<string, { callId: string; name: string }>();

  function onAbort(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>): void {
    if (!terminated) {
      terminated = true;
      controller.error(signal?.reason);
      void reader.cancel(signal?.reason).catch(() => undefined);
    }
  }

  /** Ends the stream with one malformed-response error part, then closes and cancels the source. */
  function reject(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, message: string): void {
    terminated = true;
    controller.enqueue({ type: "error", error: new EnlittError("malformed_response", message) });
    controller.close();
    void reader.cancel().catch(() => undefined);
  }

  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort(controller);
        } else {
          signal.addEventListener("abort", () => onAbort(controller), { once: true });
        }
      }
    },
    async pull(controller) {
      // A loop, not one pass: Web Streams re-invoke `pull()` only after it
      // enqueues something, and several events translate to zero parts on
      // purpose (an absorbed repeat, an unknown event, bookkeeping events).
      for (;;) {
        if (terminated) {
          return;
        }

        let raw: ReadableStreamReadResult<SseEvent>;
        try {
          raw = await reader.read();
        } catch (thrown) {
          if (thrown instanceof SseFramingError) {
            reject(controller, thrown.message);
          } else {
            terminated = true;
            controller.error(thrown);
          }
          return;
        }

        if (sawTerminal) {
          // This cycle exists only to confirm nothing followed the terminal event.
          if (raw.done) {
            terminated = true;
            controller.close();
          } else {
            reject(controller, "A stream event was received after the terminal event.");
          }
          return;
        }

        if (raw.done) {
          reject(controller, "The stream ended before a terminal event was received.");
          return;
        }

        let json: unknown;
        try {
          json = JSON.parse(raw.value.data) as unknown;
        } catch {
          reject(controller, "A stream event's data payload was not valid JSON.");
          return;
        }

        const validated = validateResponseStreamEvent(json, { mode: "tolerant" });
        if (!validated.ok) {
          reject(controller, `A stream event failed validation: ${validated.error.message} (${validated.error.param}).`);
          return;
        }

        const event = validated.value;
        const orderingError = checkIncrementalOrdering(lastEvent, event);
        if (orderingError !== undefined) {
          reject(controller, orderingError);
          return;
        }

        // An identical repeat carries no new information and is absorbed.
        const isIdenticalRepeat = lastEvent !== undefined && sameEvent(lastEvent, event);
        lastEvent = event;
        if (isIdenticalRepeat) {
          continue;
        }

        const parts = isKnownEvent(event) ? translateEvent(event, openText, toolItems) : [];

        if (isTerminalEvent(event)) {
          sawTerminal = true;
        }

        if (parts.length === 0) {
          continue;
        }
        for (const part of parts) {
          controller.enqueue(part);
        }
        return;
      }
    },
    async cancel(reason) {
      terminated = true;
      await reader.cancel(reason);
    }
  });
}

/**
 * The incremental form of the protocol's ordering rule: `response.created`
 * first, then sequence numbers advancing by exactly one (an identical repeat of
 * the previous event excepted), and nothing after the terminal event.
 */
function checkIncrementalOrdering(previous: ParsedEvent | undefined, next: ParsedEvent): string | undefined {
  if (previous === undefined) {
    return next.type === "response.created"
      ? undefined
      : `The first stream event must be "response.created", got "${next.type}".`;
  }
  if (isTerminalEvent(previous)) {
    return "A stream event was received after the terminal event.";
  }
  if (next.sequence_number === previous.sequence_number) {
    return sameEvent(previous, next)
      ? undefined
      : "Two stream events carried the same sequence_number with conflicting payloads.";
  }
  if (next.sequence_number < previous.sequence_number) {
    return "A stream event arrived out of order (its sequence_number was lower than a prior event's).";
  }
  if (next.sequence_number !== previous.sequence_number + 1) {
    return "A stream event's sequence_number skipped a value (a gap in the sequence).";
  }
  return undefined;
}

/**
 * Translates one known stream event into zero or more provider-interface parts.
 * Each event maps to at most a handful of parts and none needs anything beyond
 * the single event just received, plus the small ID bookkeeping, which is what
 * keeps the stream from ever buffering a complete output.
 */
function translateEvent(
  event: ResponseStreamEvent,
  openText: Set<string>,
  toolItems: Map<string, { callId: string; name: string }>
): LanguageModelV3StreamPart[] {
  switch (event.type) {
    case "response.created":
      return [{ type: "stream-start", warnings: [] }];

    case "response.output_item.added": {
      // An unknown item emits nothing; a function call announces its tool input.
      const item: ResponseOutputItem = event.item;
      if (isUnknownVariant(item) || item.type !== "function_call") {
        return [];
      }
      toolItems.set(item.id, { callId: item.call_id, name: item.name });
      return [{ type: "tool-input-start", id: item.call_id, toolName: item.name }];
    }

    case "response.output_text.delta": {
      const parts: LanguageModelV3StreamPart[] = [];
      if (!openText.has(event.item_id)) {
        openText.add(event.item_id);
        parts.push({ type: "text-start", id: event.item_id });
      }
      parts.push({ type: "text-delta", id: event.item_id, delta: event.delta });
      return parts;
    }

    case "response.output_text.done": {
      const parts: LanguageModelV3StreamPart[] = [];
      if (!openText.has(event.item_id)) {
        parts.push({ type: "text-start", id: event.item_id });
      }
      openText.delete(event.item_id);
      parts.push({ type: "text-end", id: event.item_id });
      return parts;
    }

    case "response.function_call_arguments.delta": {
      const tool = toolItems.get(event.item_id);
      return [{ type: "tool-input-delta", id: tool?.callId ?? event.item_id, delta: event.delta }];
    }

    case "response.function_call_arguments.done": {
      const tool = toolItems.get(event.item_id);
      const callId = tool?.callId ?? event.item_id;
      return [
        { type: "tool-input-end", id: callId },
        { type: "tool-call", toolCallId: callId, toolName: tool?.name ?? event.item_id, input: event.arguments }
      ];
    }

    case "response.completed":
    case "response.incomplete":
    case "response.failed":
      // A failure ends in a single finish part whose reason is "error"; this
      // keeps "exactly one finish or error part" true on every terminal path.
      // A terminal response may carry an empty `output` after streaming, so a
      // completed stream that emitted tool calls finishes as "tool-calls".
      return [
        {
          type: "finish",
          finishReason:
            event.type === "response.completed" && toolItems.size > 0 && event.response.status === "completed"
              ? { unified: "tool-calls", raw: event.response.status }
              : mapFinishReason(event.response),
          usage: mapUsage(event.response),
          ...(hasRoutingMetadata(event.response) ? { providerMetadata: { enlitt: routingMetadata(event.response) } } : {})
        }
      ];

    // Bookkeeping events carry nothing a consumer needs.
    case "response.in_progress":
    case "response.output_item.done":
    case "response.content_part.added":
    case "response.content_part.done":
      return [];
  }
}
