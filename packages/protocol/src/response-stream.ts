/**
 * The `text/event-stream` wire contract for `POST /v1/responses` streaming,
 * shared by the backend emitter and the SDK reader.
 *
 * `specs/PROTOCOLS.md` "Model response stream" fixes three things this module
 * exists to check once instead of twice: the closed set of event names, the
 * shape every event carries (`type` plus a monotonic `sequence_number`), and
 * an ordering rule (`response.created` first, at most one terminal event,
 * nothing after it, sequence numbers monotonic). The ordering rule is pure —
 * it takes a list of already-parsed events and returns a verdict — so both
 * the backend, which must never emit a violation, and the SDK, which must
 * never trust a violation even from a well-behaved backend, run the identical
 * check instead of each inventing their own notion of "in order".
 *
 * As with `responses.ts`, the spec text this module reads names the event
 * types and the ordering rule but does not enumerate every per-event payload
 * field. The per-event payload shapes below are inferred from the event
 * names themselves (an `*.added`/`*.done` pair evidently carries the item or
 * part it announces; a `*.delta` event evidently carries the incremental
 * text) and from the pinned OpenAI Responses API subset this endpoint
 * implements. Where a field is not confirmed by the read spec text, this is
 * called out below rather than asserted as settled.
 */

import { ENLITT_ERROR_CODE, type EnlittErrorCode } from "./errors.js";
import type { ParseOptions, UnknownVariant } from "./compatibility.js";
import {
  validateOpenAIResponse,
  validateOutputTextPart,
  validateResponseOutputItem,
  type OpenAIResponse,
  type ResponseOutputContentPart,
  type ResponseOutputItem
} from "./responses.js";

/**
 * The closed set of stream event types, as a frozen record mapping each name
 * to whether it is one of the three terminal events. A record rather than
 * two separate arrays keeps "is this name known" and "is this name terminal"
 * as one lookup instead of two lists that could silently drift out of sync,
 * the same shape `ENLITT_ERROR_CODES` uses for the same reason.
 */
export const RESPONSE_STREAM_EVENT_TYPES = Object.freeze({
  "response.created": Object.freeze({ terminal: false }),
  "response.in_progress": Object.freeze({ terminal: false }),
  "response.output_item.added": Object.freeze({ terminal: false }),
  "response.output_item.done": Object.freeze({ terminal: false }),
  "response.content_part.added": Object.freeze({ terminal: false }),
  "response.content_part.done": Object.freeze({ terminal: false }),
  "response.output_text.delta": Object.freeze({ terminal: false }),
  "response.output_text.done": Object.freeze({ terminal: false }),
  "response.function_call_arguments.delta": Object.freeze({ terminal: false }),
  "response.function_call_arguments.done": Object.freeze({ terminal: false }),
  "response.completed": Object.freeze({ terminal: true }),
  "response.incomplete": Object.freeze({ terminal: true }),
  "response.failed": Object.freeze({ terminal: true })
} as const);

export type ResponseStreamEventType = keyof typeof RESPONSE_STREAM_EVENT_TYPES;

export const RESPONSE_STREAM_EVENT_TYPE_NAMES = Object.freeze(
  Object.keys(RESPONSE_STREAM_EVENT_TYPES) as readonly ResponseStreamEventType[]
);

export function isResponseStreamEventType(value: unknown): value is ResponseStreamEventType {
  return typeof value === "string" && Object.hasOwn(RESPONSE_STREAM_EVENT_TYPES, value);
}

export function isTerminalResponseStreamEventType(type: ResponseStreamEventType): boolean {
  return RESPONSE_STREAM_EVENT_TYPES[type].terminal;
}

/** The three event types that legally end a stream. */
export type TerminalResponseStreamEventType = "response.completed" | "response.incomplete" | "response.failed";

// --- Event validation --------------------------------------------------

export type StreamValidationErrorCode = Extract<
  EnlittErrorCode,
  "invalid_value" | "unsupported_parameter" | "unsupported_value"
>;

export interface StreamValidationFailure {
  readonly code: StreamValidationErrorCode;
  readonly param: string;
  readonly message: string;
}

export type StreamValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StreamValidationFailure };

function ok<T>(value: T): StreamValidationResult<T> {
  return { ok: true, value };
}

function invalidValue(param: string, message: string): StreamValidationResult<never> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.invalid_value, param, message } };
}

function unsupportedValue(param: string, message: string): StreamValidationResult<never> {
  return { ok: false, error: { code: ENLITT_ERROR_CODE.unsupported_value, param, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The per-event payload variants. Every event carries `type` and
 * `sequence_number`; the fields beyond that are inferred as described in the
 * module doc comment and are the least-committal reading of the event names
 * the spec text gives, not a spec quotation.
 */
export interface ResponseCreatedEvent {
  readonly type: "response.created";
  readonly sequence_number: number;
  readonly response: OpenAIResponse;
}

export interface ResponseInProgressEvent {
  readonly type: "response.in_progress";
  readonly sequence_number: number;
  readonly response: OpenAIResponse;
}

export interface OutputItemAddedEvent {
  readonly type: "response.output_item.added";
  readonly sequence_number: number;
  readonly output_index: number;
  readonly item: ResponseOutputItem;
}

export interface OutputItemDoneEvent {
  readonly type: "response.output_item.done";
  readonly sequence_number: number;
  readonly output_index: number;
  readonly item: ResponseOutputItem;
}

export interface ContentPartAddedEvent {
  readonly type: "response.content_part.added";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly part: ResponseOutputContentPart;
}

export interface ContentPartDoneEvent {
  readonly type: "response.content_part.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly part: ResponseOutputContentPart;
}

export interface OutputTextDeltaEvent {
  readonly type: "response.output_text.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly delta: string;
}

export interface OutputTextDoneEvent {
  readonly type: "response.output_text.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly text: string;
}

export interface FunctionCallArgumentsDeltaEvent {
  readonly type: "response.function_call_arguments.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly delta: string;
}

export interface FunctionCallArgumentsDoneEvent {
  readonly type: "response.function_call_arguments.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly arguments: string;
}

export interface ResponseCompletedEvent {
  readonly type: "response.completed";
  readonly sequence_number: number;
  readonly response: OpenAIResponse;
}

export interface ResponseIncompleteEvent {
  readonly type: "response.incomplete";
  readonly sequence_number: number;
  readonly response: OpenAIResponse;
}

export interface ResponseFailedEvent {
  readonly type: "response.failed";
  readonly sequence_number: number;
  readonly response: OpenAIResponse;
}

/**
 * A stream event introduced after this protocol package was released.
 *
 * Tolerant readers retain its type and sequence number so they can skip the
 * payload without weakening stream-order validation. The payload is not
 * copied: no older reader can safely interpret fields belonging to a variant
 * it does not know.
 */
export interface UnknownResponseStreamEvent extends UnknownVariant {
  readonly sequence_number: number;
}

export type ResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseFailedEvent;

function validateSequenceNumber(value: unknown, param: string): StreamValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return invalidValue(param, "must be a nonnegative integer");
  }
  return ok(value);
}

function validateStringField(value: unknown, param: string): StreamValidationResult<string> {
  if (typeof value !== "string") return invalidValue(param, "must be a string");
  return ok(value);
}

function validateIntegerField(value: unknown, param: string): StreamValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return invalidValue(param, "must be an integer");
  return ok(value);
}

function isTolerant(options: ParseOptions | undefined): boolean {
  return options?.mode === "tolerant";
}

function validateOnlyEventKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  options: ParseOptions | undefined
): StreamValidationResult<undefined> {
  if (isTolerant(options)) return ok(undefined);

  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return invalidValue(key, `unknown stream event field "${key}"`);
  }
  return ok(undefined);
}

/**
 * Validate one already-JSON-parsed SSE `data` payload.
 *
 * Response-bearing events delegate to `validateOpenAIResponse`, including its
 * strict/tolerant nested parsing. Item and part events remain outer-shape
 * checks: those partial objects are not complete `OpenAIResponse` values and
 * their stream-specific fields are validated by their own event variants.
 */
export function validateResponseStreamEvent(
  value: unknown,
  options?: ParseOptions
): StreamValidationResult<ResponseStreamEvent | UnknownResponseStreamEvent> {
  if (!isPlainObject(value)) return invalidValue("body", "stream event must be a JSON object");

  const type = value.type;
  if (typeof type !== "string") return invalidValue("type", "must be a string");
  const sequenceResult = validateSequenceNumber(value.sequence_number, "sequence_number");
  if (!sequenceResult.ok) return sequenceResult;
  const sequence_number = sequenceResult.value;

  if (!isResponseStreamEventType(type)) {
    if (type.length > 64) return invalidValue("type", "must not exceed 64 characters");
    if (isTolerant(options)) return ok({ unknown: true, type, sequence_number });
    return unsupportedValue("type", `unknown stream event type "${type}"`);
  }

  switch (type) {
    case "response.created":
    case "response.in_progress":
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const keysResult = validateOnlyEventKeys(value, ["type", "sequence_number", "response"], options);
      if (!keysResult.ok) return keysResult;
      const responseResult = validateOpenAIResponse(value.response, options);
      if (!responseResult.ok) return responseResult;
      // Grouped switch cases widen the discriminator union even though each
      // runtime value is one valid public event variant.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return ok({ type, sequence_number, response: responseResult.value } as ResponseStreamEvent);
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const keysResult = validateOnlyEventKeys(value, ["type", "sequence_number", "output_index", "item"], options);
      if (!keysResult.ok) return keysResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const itemResult = validateResponseOutputItem(value.item, "item", options);
      if (!itemResult.ok) return itemResult;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return ok({
        type,
        sequence_number,
        output_index: outputIndexResult.value,
        item: itemResult.value
      } as ResponseStreamEvent);
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      const keysResult = validateOnlyEventKeys(
        value,
        ["type", "sequence_number", "item_id", "output_index", "content_index", "part"],
        options
      );
      if (!keysResult.ok) return keysResult;
      const itemIdResult = validateStringField(value.item_id, "item_id");
      if (!itemIdResult.ok) return itemIdResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const contentIndexResult = validateIntegerField(value.content_index, "content_index");
      if (!contentIndexResult.ok) return contentIndexResult;
      const partResult = validateOutputTextPart(value.part, "part", options);
      if (!partResult.ok) return partResult;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      return ok({
        type,
        sequence_number,
        item_id: itemIdResult.value,
        output_index: outputIndexResult.value,
        content_index: contentIndexResult.value,
        part: partResult.value
      } as ResponseStreamEvent);
    }
    case "response.output_text.delta": {
      const keysResult = validateOnlyEventKeys(
        value,
        ["type", "sequence_number", "item_id", "output_index", "content_index", "delta"],
        options
      );
      if (!keysResult.ok) return keysResult;
      const itemIdResult = validateStringField(value.item_id, "item_id");
      if (!itemIdResult.ok) return itemIdResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const contentIndexResult = validateIntegerField(value.content_index, "content_index");
      if (!contentIndexResult.ok) return contentIndexResult;
      const deltaResult = validateStringField(value.delta, "delta");
      if (!deltaResult.ok) return deltaResult;
      return ok({
        type,
        sequence_number,
        item_id: itemIdResult.value,
        output_index: outputIndexResult.value,
        content_index: contentIndexResult.value,
        delta: deltaResult.value
      });
    }
    case "response.output_text.done": {
      const keysResult = validateOnlyEventKeys(
        value,
        ["type", "sequence_number", "item_id", "output_index", "content_index", "text"],
        options
      );
      if (!keysResult.ok) return keysResult;
      const itemIdResult = validateStringField(value.item_id, "item_id");
      if (!itemIdResult.ok) return itemIdResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const contentIndexResult = validateIntegerField(value.content_index, "content_index");
      if (!contentIndexResult.ok) return contentIndexResult;
      const textResult = validateStringField(value.text, "text");
      if (!textResult.ok) return textResult;
      return ok({
        type,
        sequence_number,
        item_id: itemIdResult.value,
        output_index: outputIndexResult.value,
        content_index: contentIndexResult.value,
        text: textResult.value
      });
    }
    case "response.function_call_arguments.delta": {
      const keysResult = validateOnlyEventKeys(
        value,
        ["type", "sequence_number", "item_id", "output_index", "delta"],
        options
      );
      if (!keysResult.ok) return keysResult;
      const itemIdResult = validateStringField(value.item_id, "item_id");
      if (!itemIdResult.ok) return itemIdResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const deltaResult = validateStringField(value.delta, "delta");
      if (!deltaResult.ok) return deltaResult;
      return ok({
        type,
        sequence_number,
        item_id: itemIdResult.value,
        output_index: outputIndexResult.value,
        delta: deltaResult.value
      });
    }
    case "response.function_call_arguments.done": {
      const keysResult = validateOnlyEventKeys(
        value,
        ["type", "sequence_number", "item_id", "output_index", "arguments"],
        options
      );
      if (!keysResult.ok) return keysResult;
      const itemIdResult = validateStringField(value.item_id, "item_id");
      if (!itemIdResult.ok) return itemIdResult;
      const outputIndexResult = validateIntegerField(value.output_index, "output_index");
      if (!outputIndexResult.ok) return outputIndexResult;
      const argsResult = validateStringField(value.arguments, "arguments");
      if (!argsResult.ok) return argsResult;
      return ok({
        type,
        sequence_number,
        item_id: itemIdResult.value,
        output_index: outputIndexResult.value,
        arguments: argsResult.value
      });
    }
  }
}

// --- Ordering rule -------------------------------------------------------

/** The minimal shape the ordering check needs from an event; deliberately not the full validated union so a caller can check ordering before or independent of full payload validation. */
export interface StreamOrderingEvent {
  /** Unknown stream events are kept in the sequence rather than dropped. */
  readonly type: string;
  readonly sequence_number: number;
}

export type StreamOrderingViolation =
  | { readonly kind: "missing_first_created" }
  | { readonly kind: "non_monotonic_sequence"; readonly index: number }
  | { readonly kind: "event_after_terminal"; readonly index: number }
  | { readonly kind: "missing_terminal" };

export type StreamOrderingCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly violation: StreamOrderingViolation };

/**
 * Check a full (or full-so-far) list of stream events against
 * `specs/PROTOCOLS.md`'s ordering rule: `response.created` first, sequence
 * numbers strictly increasing, at most one terminal event, and nothing after
 * it. No I/O and no dependency on wall-clock time — this runs identically
 * whether the backend calls it before emitting an event or the SDK calls it
 * after receiving one.
 *
 * A second terminal event is reported as `event_after_terminal` rather than
 * as its own violation kind: by the time a second terminal event arrives, an
 * earlier one has already closed the stream, and "an event arrived after the
 * terminal event" is the true description of what happened regardless of
 * what kind of event it is.
 *
 * "Monotonic" is read as strictly increasing. `specs/PROTOCOLS.md` does not
 * state whether a repeated sequence number would be tolerated; this module
 * takes the stricter reading because a repeated number cannot tell two
 * distinct events apart, which is the ordering guarantee's entire purpose.
 */
export function checkResponseStreamOrdering(
  events: readonly StreamOrderingEvent[]
): StreamOrderingCheck {
  if (events.length === 0 || events[0]?.type !== "response.created") {
    return { ok: false, violation: { kind: "missing_first_created" } };
  }

  let lastSequenceNumber = -Infinity;
  let sawTerminal = false;

  for (const [index, event] of events.entries()) {
    if (sawTerminal) {
      return { ok: false, violation: { kind: "event_after_terminal", index } };
    }
    if (event.sequence_number <= lastSequenceNumber) {
      return { ok: false, violation: { kind: "non_monotonic_sequence", index } };
    }
    lastSequenceNumber = event.sequence_number;
    if (isResponseStreamEventType(event.type) && isTerminalResponseStreamEventType(event.type)) {
      sawTerminal = true;
    }
  }

  if (!sawTerminal) {
    return { ok: false, violation: { kind: "missing_terminal" } };
  }

  return { ok: true };
}
