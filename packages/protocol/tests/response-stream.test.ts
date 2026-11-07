import { describe, expect, it } from "vitest";

import { ENLITT_ERROR_CODE } from "../src/errors.js";
import {
  checkResponseStreamOrdering,
  isResponseStreamEventType,
  isTerminalResponseStreamEventType,
  RESPONSE_STREAM_EVENT_TYPE_NAMES,
  RESPONSE_STREAM_EVENT_TYPES,
  validateResponseStreamEvent,
  type StreamOrderingEvent
} from "../src/response-stream.js";

const MINIMAL_RESPONSE = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "in_progress",
  error: null,
  incomplete_details: null,
  model: "enlitt-standard",
  output: [],
  metadata: {}
};

describe("RESPONSE_STREAM_EVENT_TYPES", () => {
  it("covers every minimum-supported event named by specs/PROTOCOLS.md", () => {
    const expected = [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_item.done",
      "response.content_part.added",
      "response.content_part.done",
      "response.output_text.delta",
      "response.output_text.done",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.completed",
      "response.incomplete",
      "response.failed"
    ];
    expect([...RESPONSE_STREAM_EVENT_TYPE_NAMES].sort()).toEqual([...expected].sort());
  });

  it("marks exactly the three terminal events as terminal", () => {
    const terminal = RESPONSE_STREAM_EVENT_TYPE_NAMES.filter((type) =>
      isTerminalResponseStreamEventType(type)
    );
    expect([...terminal].sort()).toEqual(
      ["response.completed", "response.failed", "response.incomplete"].sort()
    );
  });

  it("is frozen", () => {
    expect(Object.isFrozen(RESPONSE_STREAM_EVENT_TYPES)).toBe(true);
    for (const type of RESPONSE_STREAM_EVENT_TYPE_NAMES) {
      expect(Object.isFrozen(RESPONSE_STREAM_EVENT_TYPES[type])).toBe(true);
    }
  });

  it("recognizes only its own names", () => {
    expect(isResponseStreamEventType("response.created")).toBe(true);
    expect(isResponseStreamEventType("response.made_up")).toBe(false);
    expect(isResponseStreamEventType(123)).toBe(false);
  });
});

describe("validateResponseStreamEvent", () => {
  it("accepts response.created", () => {
    const result = validateResponseStreamEvent({
      type: "response.created",
      sequence_number: 0,
      response: MINIMAL_RESPONSE
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an output_item.added event", () => {
    const result = validateResponseStreamEvent({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] }
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an output_text.delta event", () => {
    const result = validateResponseStreamEvent({
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hi"
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a function_call_arguments.delta event", () => {
    const result = validateResponseStreamEvent({
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_1",
      output_index: 1,
      delta: "{\"a\":"
    });
    expect(result.ok).toBe(true);
  });

  it("accepts each terminal event", () => {
    for (const type of ["response.completed", "response.incomplete", "response.failed"]) {
      const result = validateResponseStreamEvent({
        type,
        sequence_number: 9,
        response: MINIMAL_RESPONSE
      });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an unknown event type in strict mode", () => {
    const result = validateResponseStreamEvent({ type: "response.mystery", sequence_number: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ENLITT_ERROR_CODE.unsupported_value);
      expect(result.error.param).toBe("type");
    }
  });

  it("reads a future event tolerantly without retaining its payload", () => {
    const result = validateResponseStreamEvent(
      {
        type: "response.reasoning.delta",
        sequence_number: 4,
        future_payload: { chain_of_thought: "not for this client" }
      },
      { mode: "tolerant" }
    );
    expect(result).toEqual({
      ok: true,
      value: { unknown: true, type: "response.reasoning.delta", sequence_number: 4 }
    });
  });

  it("rejects a future event type longer than 64 characters in every mode", () => {
    const event = { type: "x".repeat(65), sequence_number: 0 };
    expect(validateResponseStreamEvent(event).ok).toBe(false);
    expect(validateResponseStreamEvent(event, { mode: "tolerant" }).ok).toBe(false);
  });

  it("rejects extra known-event fields strictly and drops them tolerantly", () => {
    const event = {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hi",
      future_field: true
    };
    expect(validateResponseStreamEvent(event).ok).toBe(false);
    expect(validateResponseStreamEvent(event, { mode: "tolerant" })).toEqual({
      ok: true,
      value: {
        type: "response.output_text.delta",
        sequence_number: 2,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "hi"
      }
    });
  });

  it("uses the response parser's strict and tolerant handling for response-bearing events", () => {
    const event = {
      type: "response.created",
      sequence_number: 0,
      response: { ...MINIMAL_RESPONSE, future_response_field: true }
    };
    expect(validateResponseStreamEvent(event).ok).toBe(false);

    const tolerant = validateResponseStreamEvent(event, { mode: "tolerant" });
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok && "response" in tolerant.value) {
      expect(tolerant.value.response).not.toHaveProperty("future_response_field");
    }
  });

  it("rejects a negative or non-integer sequence_number as invalid_value", () => {
    for (const bad of [-1, 1.5, "0"]) {
      const result = validateResponseStreamEvent({
        type: "response.in_progress",
        sequence_number: bad,
        response: MINIMAL_RESPONSE
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ENLITT_ERROR_CODE.invalid_value);
        expect(result.error.param).toBe("sequence_number");
      }
    }
  });

  it("rejects a non-object payload as invalid_value", () => {
    const result = validateResponseStreamEvent("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ENLITT_ERROR_CODE.invalid_value);
  });
});

describe("checkResponseStreamOrdering", () => {
  function event(type: StreamOrderingEvent["type"], sequence_number: number): StreamOrderingEvent {
    return { type, sequence_number };
  }

  it("accepts a well-formed stream", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      event("response.in_progress", 1),
      event("response.output_item.added", 2),
      event("response.output_text.delta", 3),
      event("response.output_text.done", 4),
      event("response.output_item.done", 5),
      event("response.completed", 6)
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty stream and a stream not starting with response.created", () => {
    expect(checkResponseStreamOrdering([]).ok).toBe(false);
    const result = checkResponseStreamOrdering([event("response.in_progress", 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation.kind).toBe("missing_first_created");
  });

  it("rejects a stream missing its terminal event", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      event("response.in_progress", 1)
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation.kind).toBe("missing_terminal");
  });

  it("rejects a stream with two terminal events", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      event("response.completed", 1),
      event("response.failed", 2)
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.kind).toBe("event_after_terminal");
      expect(result.violation).toMatchObject({ index: 2 });
    }
  });

  it("rejects a non-monotonic sequence_number", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      event("response.in_progress", 0),
      event("response.completed", 2)
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.kind).toBe("non_monotonic_sequence");
      expect(result.violation).toMatchObject({ index: 1 });
    }
  });

  it("rejects an event after the terminal event", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      event("response.completed", 1),
      event("response.output_text.done", 2)
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.kind).toBe("event_after_terminal");
      expect(result.violation).toMatchObject({ index: 2 });
    }
  });

  it("keeps unknown events in ordering and never treats them as terminal", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      { type: "response.reasoning.delta", sequence_number: 1 },
      event("response.completed", 2)
    ]);
    expect(result.ok).toBe(true);
  });

  it("detects a non-monotonic sequence through an unknown event", () => {
    const result = checkResponseStreamOrdering([
      event("response.created", 0),
      { type: "response.reasoning.delta", sequence_number: 2 },
      event("response.completed", 1)
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toMatchObject({ kind: "non_monotonic_sequence", index: 2 });
  });
});
