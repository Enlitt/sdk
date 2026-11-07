import { describe, expect, it, vi, afterEach } from "vitest";
import { createSseEventStream, MAX_SSE_LINE_BYTES, MAX_SSE_EVENT_BYTES, SseFramingError } from "./sse.js";
import type { SseEvent } from "./sse.js";

const encoder = new TextEncoder();

/** Encodes a plain-text SSE fixture to raw bytes for byte-level chunking. */
function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** A `ReadableStream<Uint8Array>` that yields exactly the given byte chunks. */
function streamOfChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    }
  });
}

/** Splits one byte buffer into two chunks at `at`, simulating an arbitrary chunk boundary. */
function splitAt(all: Uint8Array, at: number): Uint8Array[] {
  return [all.slice(0, at), all.slice(at)];
}

/** Splits one byte buffer into single-byte chunks: the most adversarial chunking possible. */
function byteAtATime(all: Uint8Array): Uint8Array[] {
  return Array.from(all, (b) => Uint8Array.of(b));
}

async function collect(stream: ReadableStream<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createSseEventStream", () => {
  it("parses a single well-formed event", async () => {
    const source = streamOfChunks([bytes("event: greeting\ndata: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "greeting", data: "hello" }]);
  });

  it("defaults the event type to 'message' when no event field is given", async () => {
    const source = streamOfChunks([bytes("data: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("joins multiple data lines with a newline", async () => {
    const source = streamOfChunks([bytes("data: line one\ndata: line two\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "line one\nline two" }]);
  });

  it("ignores comment lines beginning with a colon", async () => {
    const source = streamOfChunks([bytes(": this is a comment\ndata: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("strips exactly one leading space after the field colon", async () => {
    const source = streamOfChunks([bytes("data:  hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    // Only the single space immediately after the colon is stripped.
    expect(events).toEqual([{ event: "message", data: " hello" }]);
  });

  it("treats a line with no colon as a field name with an empty value", async () => {
    // A bare "data" line (no colon) contributes an empty data line, so the
    // event still dispatches with empty-string data.
    const source = streamOfChunks([bytes("data\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "" }]);
  });

  it("ignores unrecognized field names", async () => {
    const source = streamOfChunks([bytes("bogus: whatever\ndata: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("consumes id and retry fields without surfacing them", async () => {
    const source = streamOfChunks([bytes("id: 42\nretry: 3000\ndata: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
    expect(Object.keys(events[0]!)).toEqual(["event", "data"]);
  });

  it("discards an event with no data field at all", async () => {
    const source = streamOfChunks([bytes("event: ping\n\ndata: hello\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("dispatches multiple events found in a single chunk", async () => {
    const source = streamOfChunks([bytes("data: first\n\ndata: second\n\ndata: third\n\n")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([
      { event: "message", data: "first" },
      { event: "message", data: "second" },
      { event: "message", data: "third" }
    ]);
  });

  it("assembles an event spread across many single-byte chunks", async () => {
    const full = bytes("event: slow\ndata: one byte at a time\n\n");
    const source = streamOfChunks(byteAtATime(full));
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([{ event: "slow", data: "one byte at a time" }]);
  });

  it("drops a final unterminated line instead of synthesizing a dispatch", async () => {
    // No trailing blank line ever arrives, so the in-progress event must be
    // discarded, not flushed just because the stream ended.
    const source = streamOfChunks([bytes("event: partial\ndata: never dispatched")]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([]);
  });

  it("handles a valid final chunk with no trailing newline after the blank line", async () => {
    const full = bytes("data: first\n\ndata: last\n\n");
    // The stream simply ends right after the last delimiter with nothing more.
    const source = streamOfChunks([full]);
    const events = await collect(createSseEventStream(source));
    expect(events).toEqual([
      { event: "message", data: "first" },
      { event: "message", data: "last" }
    ]);
  });

  describe("arbitrary chunk boundaries", () => {
    const fixture = "event: split\ndata: hello world\n\n";
    const expected: SseEvent[] = [{ event: "split", data: "hello world" }];

    it("reassembles the event no matter where the two-way split falls", async () => {
      const full = bytes(fixture);
      for (let at = 0; at <= full.length; at++) {
        const source = streamOfChunks(splitAt(full, at));
        const events = await collect(createSseEventStream(source));
        expect(events, `split at byte ${at}`).toEqual(expected);
      }
    });

    it("reassembles a multi-byte UTF-8 character split at every byte boundary", async () => {
      // "café €" (trailing euro sign) encodes the euro sign as three
      // bytes (E2 82 AC); every split point below lands either between
      // characters or inside that multi-byte sequence.
      const full = bytes("data: café €\n\n");
      for (let at = 0; at <= full.length; at++) {
        const source = streamOfChunks(splitAt(full, at));
        const events = await collect(createSseEventStream(source));
        expect(events, `split at byte ${at}`).toEqual([{ event: "message", data: "café €" }]);
      }
    });

    it("reassembles a CRLF terminator split at the boundary between CR and LF", async () => {
      const full = bytes("event: crlf\r\ndata: hello\r\n\r\n");
      for (let at = 0; at <= full.length; at++) {
        const source = streamOfChunks(splitAt(full, at));
        const events = await collect(createSseEventStream(source));
        expect(events, `split at byte ${at}`).toEqual([{ event: "crlf", data: "hello" }]);
      }
    });

    it("treats a lone CR line ending the same as LF", async () => {
      const source = streamOfChunks([bytes("event: cr\rdata: hello\r\r")]);
      const events = await collect(createSseEventStream(source));
      expect(events).toEqual([{ event: "cr", data: "hello" }]);
    });
  });

  describe("size bounds", () => {
    it("fails the stream when a single line exceeds the maximum line size", async () => {
      const oversized = "data: " + "a".repeat(MAX_SSE_LINE_BYTES + 1) + "\n\n";
      const source = streamOfChunks([bytes(oversized)]);
      const reader = createSseEventStream(source).getReader();
      await expect(reader.read()).rejects.toMatchObject({
        name: "SseFramingError",
        code: "malformed_response"
      });
    });

    it("fails the stream when many small data lines together exceed the maximum event size", async () => {
      // Each line (96 bytes) is well below the per-line bound, but summed
      // across enough `data:` lines the event exceeds the maximum event size.
      const lineByteSize = 96;
      const lineCount = Math.ceil(MAX_SSE_EVENT_BYTES / lineByteSize) + 50;
      const parts: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        parts.push("data: " + "b".repeat(90));
      }
      const source = streamOfChunks([bytes(parts.join("\n") + "\n\n")]);
      const reader = createSseEventStream(source).getReader();
      await expect(reader.read()).rejects.toMatchObject({
        name: "SseFramingError",
        code: "malformed_response"
      });
    });

    it("fails rather than growing without bound when no terminator ever arrives", async () => {
      const neverTerminated = "data: " + "c".repeat(MAX_SSE_LINE_BYTES + 100);
      const source = streamOfChunks([bytes(neverTerminated)]);
      const reader = createSseEventStream(source).getReader();
      await expect(reader.read()).rejects.toBeInstanceOf(SseFramingError);
    });

    it("raises SseFramingError as a genuine Error instance", async () => {
      const oversized = "data: " + "a".repeat(MAX_SSE_LINE_BYTES + 1) + "\n\n";
      const source = streamOfChunks([bytes(oversized)]);
      const reader = createSseEventStream(source).getReader();
      try {
        await reader.read();
        expect.unreachable("expected the read to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(SseFramingError);
      }
    });
  });

  describe("backpressure and cancellation", () => {
    it("does not read all chunks ahead of what the consumer has requested", async () => {
      let reads = 0;
      const values = ["one", "two", "three"].map((v) => bytes(`data: ${v}\n\n`));
      let index = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          if (index >= values.length) {
            controller.close();
            return;
          }
          controller.enqueue(values[index]!);
          index += 1;
        }
      });

      const reader = createSseEventStream(source).getReader();
      const first = await reader.read();
      expect(first.value).toEqual({ event: "message", data: "one" });

      // A queuing strategy fills at most one chunk ahead, so consuming a
      // single event must not have already pulled every remaining chunk.
      const readsAfterFirst = reads;
      expect(readsAfterFirst).toBeLessThan(values.length);

      await reader.read();
      await reader.read();
      expect(reads).toBeGreaterThanOrEqual(readsAfterFirst);
    });

    it("propagates consumer cancellation to the source", async () => {
      const cancel = vi.fn();
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(bytes("data: hello\n\n"));
        },
        cancel
      });

      const stream = createSseEventStream(source);
      const reader = stream.getReader();
      await reader.read();
      const reason = new Error("consumer stopped listening");
      await reader.cancel(reason);

      expect(cancel).toHaveBeenCalledWith(reason);
    });
  });

  describe("logging", () => {
    const consoleSpies = ["log", "info", "warn", "error", "debug"] as const;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("never logs event data while parsing", async () => {
      const spies = consoleSpies.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const source = streamOfChunks([bytes("event: secret\ndata: super-sensitive-payload\n\n")]);
      await collect(createSseEventStream(source));
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it("never logs event data even when framing fails", async () => {
      const spies = consoleSpies.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      const oversized = "data: " + "s".repeat(MAX_SSE_LINE_BYTES + 1) + "\n\n";
      const source = streamOfChunks([bytes(oversized)]);
      const reader = createSseEventStream(source).getReader();
      await reader.read().catch(() => undefined);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });
});
