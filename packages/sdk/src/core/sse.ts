/**
 * Generic server-sent-event framing. This file knows nothing about Enlitt:
 * no event name, no sequence rule, no Enlitt-specific type. It turns a raw
 * byte stream into a stream of parsed `{ event, data }` pairs and nothing
 * more. It is kept separate from the modules that interpret those events
 * because framing — splitting arbitrary chunk boundaries into well-formed
 * lines and fields — is the largest and most failure-prone piece of the
 * standard streaming path, and is worth getting right and testing against
 * byte-level fixtures on its own.
 */

/**
 * One decoded SSE event. Only `event` and `data` are exposed because those
 * are the only fields a caller of this module ever needs: `id` and `retry`
 * are standard SSE fields this parser recognizes and consumes (so it never
 * misparses a line beginning with `id:` or `retry:` as a comment or an
 * unknown field), but neither reconnection nor last-event-id replay is a
 * concept this byte-framing layer implements, so their values are parsed
 * and discarded rather than threaded through as dead fields on every event.
 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Raised when the input violates SSE framing bounds — a line or an event
 * grew past the deployed maximum before a terminator ever arrived — which
 * is the one failure mode this purely-syntactic layer can detect on its
 * own. It carries the stable wire code `malformed_response` as `code` so a
 * caller can fold it into Enlitt's typed error hierarchy without this file
 * importing that hierarchy: this module must stay ignorant of Enlitt, so it
 * raises its own narrow, self-contained error shape instead of reaching for
 * one defined elsewhere.
 */
export class SseFramingError extends Error {
  readonly code = "malformed_response" as const;

  constructor(message: string) {
    super(message);
    this.name = "SseFramingError";
  }
}

/**
 * Maximum size, in UTF-8 bytes, of a single SSE line (a `field: value` line,
 * a comment line, or the blank delimiter line) before framing fails rather
 * than growing an unterminated line without bound. The spec names this bound
 * as "the deployed event and line size bounds" without giving a number;
 * 16 KiB comfortably covers any single field line a JSON-carrying `data:`
 * chunk would reasonably use and is called out here, exported, so the
 * concrete figure is visible and easy to reconcile against whatever value
 * the deployment settles on.
 */
export const MAX_SSE_LINE_BYTES = 16 * 1024;

/**
 * Maximum size, in UTF-8 bytes, of all lines belonging to one SSE event
 * (from the end of the previous blank line to the next one) before framing
 * fails rather than accumulating an unterminated event without bound. Not
 * named by the spec; 256 KiB is chosen as a multiple of `MAX_SSE_LINE_BYTES`
 * generous enough for a multi-line `data:` payload and is exported for the
 * same reason `MAX_SSE_LINE_BYTES` is.
 */
export const MAX_SSE_EVENT_BYTES = 256 * 1024;

const textEncoder = new TextEncoder();

/** Byte length of a decoded string, used to enforce the line/event bounds. */
function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Locates the next line terminator (CRLF, lone CR, or lone LF) in `buffer`.
 * Returns `null` when no terminator is found — including when `buffer` ends
 * with a lone CR that might turn out to be the first half of a CRLF pair
 * split across a chunk boundary, unless `atEof` says no further bytes are
 * coming, in which case that trailing CR is resolved as a terminator on its
 * own. This is what lets a CRLF pair land on either side of an arbitrary
 * chunk boundary without being misread as two separate blank lines.
 */
function findTerminator(
  buffer: string,
  atEof: boolean
): { readonly lineEnd: number; readonly nextStart: number } | null {
  for (let i = 0; i < buffer.length; i++) {
    const code = buffer.charCodeAt(i);
    if (code === 10 /* \n */) {
      return { lineEnd: i, nextStart: i + 1 };
    }
    if (code === 13 /* \r */) {
      if (i + 1 < buffer.length) {
        const next = buffer.charCodeAt(i + 1);
        return next === 10 ? { lineEnd: i, nextStart: i + 2 } : { lineEnd: i, nextStart: i + 1 };
      }
      if (atEof) {
        return { lineEnd: i, nextStart: i + 1 };
      }
      return null;
    }
  }
  return null;
}

/**
 * Mutable state for the one event currently being assembled. Nothing else
 * about the stream is ever buffered: once an event's blank-line delimiter
 * is seen and it is dispatched, this state resets to empty.
 */
interface AssemblyState {
  eventType: string;
  dataBuffer: string;
  hasData: boolean;
  eventByteCount: number;
}

function createAssemblyState(): AssemblyState {
  return { eventType: "", dataBuffer: "", hasData: false, eventByteCount: 0 };
}

/**
 * Applies one complete line (terminator already stripped) to the assembly
 * state, following the standard SSE field rules: comment lines beginning
 * with `:` are ignored, a line with no colon names a field with an empty
 * value, at most one leading space after the colon is stripped from the
 * value, `data:` lines accumulate joined by `\n`, `event:`/`id:`/`retry:`
 * set their respective buffers (only `event` is ever surfaced), unknown
 * field names are ignored, and a blank line dispatches the assembled event
 * — unless no `data:` line was ever seen, in which case the standard
 * dispatch algorithm discards the event instead of emitting an empty one.
 * Throws `SseFramingError` if this line, or the event it belongs to, has
 * grown past the deployed size bound.
 */
function applyLine(state: AssemblyState, line: string): SseEvent | null {
  const lineBytes = byteLength(line);
  if (lineBytes > MAX_SSE_LINE_BYTES) {
    throw new SseFramingError(`SSE line exceeds the maximum size of ${MAX_SSE_LINE_BYTES} bytes`);
  }

  if (line.length === 0) {
    let dispatched: SseEvent | null = null;
    if (state.hasData) {
      const data = state.dataBuffer.endsWith("\n") ? state.dataBuffer.slice(0, -1) : state.dataBuffer;
      dispatched = { event: state.eventType.length > 0 ? state.eventType : "message", data };
    }
    state.eventType = "";
    state.dataBuffer = "";
    state.hasData = false;
    state.eventByteCount = 0;
    return dispatched;
  }

  state.eventByteCount += lineBytes;
  if (state.eventByteCount > MAX_SSE_EVENT_BYTES) {
    throw new SseFramingError(`SSE event exceeds the maximum size of ${MAX_SSE_EVENT_BYTES} bytes`);
  }

  if (line.startsWith(":")) {
    return null;
  }

  const colonIndex = line.indexOf(":");
  const fieldName = colonIndex === -1 ? line : line.slice(0, colonIndex);
  let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  switch (fieldName) {
    case "event":
      state.eventType = value;
      break;
    case "data":
      state.dataBuffer += value + "\n";
      state.hasData = true;
      break;
    case "id":
    case "retry":
      // Recognized standard fields; reconnection and last-event-id replay
      // are not concepts this byte-framing layer implements, so their
      // values are consumed and intentionally discarded.
      break;
    default:
      // Unknown field name: the line is ignored entirely, per standard SSE.
      break;
  }
  return null;
}

/**
 * Turns a raw byte stream into a stream of parsed SSE events. Decodes UTF-8
 * incrementally so a multi-byte character split across an arbitrary chunk
 * boundary decodes correctly, splits on CRLF/CR/LF line terminators so a
 * terminator split across a boundary is recognized as one delimiter rather
 * than two, and accumulates `event:`/`data:`/`id:`/`retry:` fields into one
 * `SseEvent` per blank-line-delimited block.
 *
 * It is built as a pull-driven `ReadableStream` rather than eagerly reading
 * and enqueuing everything: `pull` reads from `source` only until it can
 * emit one event and then returns, so the platform's own backpressure
 * mechanics stop new reads until the consumer asks for more, and `cancel`
 * forwards straight to the source's reader. Only the event currently being
 * assembled — a handful of small strings — is ever held in memory; nothing
 * about already-dispatched or not-yet-arrived events is buffered.
 *
 * Fails the returned stream with `SseFramingError` (`code: "malformed_response"`)
 * if a line or event exceeds the deployed size bounds, so an unterminated
 * or malicious stream cannot grow this parser's memory without bound. Never
 * logs event data.
 */
export function createSseEventStream(source: ReadableStream<Uint8Array>): ReadableStream<SseEvent> {
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8");
  const state = createAssemblyState();
  let buffer = "";

  return new ReadableStream<SseEvent>({
    async pull(controller) {
      try {
        for (;;) {
          const terminator = findTerminator(buffer, false);
          if (terminator !== null) {
            const line = buffer.slice(0, terminator.lineEnd);
            buffer = buffer.slice(terminator.nextStart);
            const dispatched = applyLine(state, line);
            if (dispatched !== null) {
              controller.enqueue(dispatched);
              return;
            }
            continue;
          }

          if (byteLength(buffer) > MAX_SSE_LINE_BYTES) {
            throw new SseFramingError(
              `SSE line exceeds the maximum size of ${MAX_SSE_LINE_BYTES} bytes`
            );
          }

          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            for (;;) {
              const finalTerminator = findTerminator(buffer, true);
              if (finalTerminator === null) {
                break;
              }
              const line = buffer.slice(0, finalTerminator.lineEnd);
              buffer = buffer.slice(finalTerminator.nextStart);
              const dispatched = applyLine(state, line);
              if (dispatched !== null) {
                controller.enqueue(dispatched);
              }
            }
            if (buffer.length > 0) {
              const dispatched = applyLine(state, buffer);
              buffer = "";
              if (dispatched !== null) {
                controller.enqueue(dispatched);
              }
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}
