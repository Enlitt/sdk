"""Server-sent-event framing (port of ``core/sse.ts``).

Knows no Enlitt event name, sequence rule, or JSON shape. It decodes UTF-8 across arbitrary
chunk boundaries, splits events on blank lines, and enforces line and event size bounds.
"""

from __future__ import annotations

import codecs
from collections.abc import AsyncIterator
from dataclasses import dataclass

from .errors import EnlittError

MAX_LINE_CHARS = 256 * 1024
"""Deployed bound on one SSE line."""

MAX_EVENT_CHARS = 1024 * 1024
"""Deployed bound on the data accumulated for one SSE event."""


@dataclass(frozen=True)
class SseEvent:
    """One complete event: its ``event:`` name (default ``message``) and joined ``data:``."""

    event: str
    data: str


def _too_big(what: str) -> EnlittError:
    return EnlittError(
        f"An Enlitt stream {what} exceeded the size bound.", code="malformed_response"
    )


class _Framer:
    """Incremental line/event assembler. Holds only the partial event being built."""

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._buffer = ""
        self._event = ""
        self._data: list[str] = []
        self._data_chars = 0
        self._has_event = False

    def feed(self, chunk: bytes, *, final: bool = False) -> list[SseEvent]:
        self._buffer += self._decoder.decode(chunk, final=final)
        events: list[SseEvent] = []
        while True:
            line = self._take_line(final)
            if line is None:
                break
            event = self._consume_line(line)
            if event is not None:
                events.append(event)
        if not final and len(self._buffer) > MAX_LINE_CHARS:
            raise _too_big("line")
        if final:
            event = self._dispatch()  # a valid final event with no trailing blank line
            if event is not None:
                events.append(event)
        return events

    def _take_line(self, final: bool) -> str | None:
        buf = self._buffer
        for i, ch in enumerate(buf):
            if ch == "\n":
                line, self._buffer = buf[:i], buf[i + 1 :]
                return line
            if ch == "\r":
                if i + 1 >= len(buf) and not final:
                    return None  # a CR at the chunk edge may be half of CRLF
                skip = 2 if buf[i + 1 : i + 2] == "\n" else 1
                line, self._buffer = buf[:i], buf[i + skip :]
                return line
        if final and buf:
            self._buffer = ""
            return buf
        return None

    def _consume_line(self, line: str) -> SseEvent | None:
        if len(line) > MAX_LINE_CHARS:
            raise _too_big("line")
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
            self._has_event = True
        elif name == "data":
            self._data_chars += len(value) + 1
            if self._data_chars > MAX_EVENT_CHARS:
                raise _too_big("event")
            self._data.append(value)
        return None

    def _dispatch(self) -> SseEvent | None:
        if not self._data and not self._has_event:
            return None
        event = SseEvent(
            event=self._event if self._has_event else "message", data="\n".join(self._data)
        )
        self._event, self._data, self._data_chars, self._has_event = "", [], 0, False
        return event


async def iter_sse_events(source: AsyncIterator[bytes]) -> AsyncIterator[SseEvent]:
    """Yield one :class:`SseEvent` per complete event in ``source``.

    Backpressure is natural (the source is pulled only as events are consumed) and closing this
    iterator closes the source.
    """
    framer = _Framer()
    try:
        async for chunk in source:
            for event in framer.feed(chunk):
                yield event
        for event in framer.feed(b"", final=True):
            yield event
    finally:
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            await aclose()
