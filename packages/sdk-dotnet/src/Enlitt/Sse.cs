using System.Runtime.CompilerServices;
using System.Text;

namespace Enlitt;

/// <summary>One complete server-sent event: its <c>event:</c> name and its joined <c>data:</c> lines.</summary>
/// <param name="Event">The event name; "message" when the event had no <c>event:</c> field.</param>
/// <param name="Data">The data lines joined with a line feed.</param>
internal readonly record struct SseEvent(string Event, string Data);

/// <summary>
/// Incremental server-sent-events framer. It decodes UTF-8 across arbitrary chunk boundaries, accepts CRLF, LF and CR
/// line endings, buffers only the event currently being assembled, and enforces line and event size bounds so an
/// unterminated stream cannot grow without limit. It knows no Enlitt event name, sequence rule or JSON shape.
/// </summary>
internal static class SseReader
{
  /// <summary>Longest accepted single line, in UTF-16 code units.</summary>
  internal const int MaxLineChars = 1 << 20;

  /// <summary>Longest accepted event (all of its lines), in UTF-16 code units.</summary>
  internal const int MaxEventChars = 4 << 20;

  /// <summary>Reads events from <paramref name="source"/> until it ends. A trailing event with no blank line is discarded.</summary>
  /// <exception cref="EnlittException">A line or event exceeded its bound (code <c>malformed_response</c>).</exception>
  internal static async IAsyncEnumerable<SseEvent> ReadAsync(Stream source, [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    Decoder decoder = new UTF8Encoding(false, false).GetDecoder();
    var line = new StringBuilder();
    var data = new StringBuilder();
    string? eventName = null;
    bool hasData = false;
    bool lastWasCr = false;
    int eventChars = 0;

    byte[] bytes = new byte[8192];
    char[] chars = new char[bytes.Length + 1];

    while (true)
    {
      int read;
      try
      {
        read = await source.ReadAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
      }
      catch (Exception ex) when (ex is IOException or HttpRequestException)
      {
        throw EnlittErrors.Transport("The Enlitt stream broke before it ended.", ex);
      }

      if (read == 0)
      {
        yield break;
      }

      int count = decoder.GetChars(bytes, 0, read, chars, 0);
      for (int i = 0; i < count; i++)
      {
        char ch = chars[i];
        if (ch == '\n' && lastWasCr)
        {
          lastWasCr = false; // the LF half of a CRLF pair that was already handled at the CR
          continue;
        }

        if (ch is not ('\r' or '\n'))
        {
          lastWasCr = false;
          line.Append(ch);
          if (line.Length > MaxLineChars)
          {
            throw EnlittErrors.Malformed("An Enlitt stream line exceeded the maximum line size.");
          }

          continue;
        }

        lastWasCr = ch == '\r';
        if (line.Length == 0)
        {
          // A blank line dispatches the event being assembled, if any.
          if (eventName is not null || hasData)
          {
            yield return new SseEvent(eventName ?? "message", data.ToString());
          }

          eventName = null;
          hasData = false;
          data.Clear();
          eventChars = 0;
          continue;
        }

        string text = line.ToString();
        line.Clear();
        eventChars += text.Length;
        if (eventChars > MaxEventChars)
        {
          throw EnlittErrors.Malformed("An Enlitt stream event exceeded the maximum event size.");
        }

        if (text[0] == ':')
        {
          continue; // comment line
        }

        int colon = text.IndexOf(':');
        string field = colon < 0 ? text : text[..colon];
        string value = colon < 0 ? string.Empty : text[(colon + 1)..];
        if (value.StartsWith(' '))
        {
          value = value[1..];
        }

        if (field == "event")
        {
          eventName = value;
        }
        else if (field == "data")
        {
          if (hasData)
          {
            data.Append('\n');
          }

          data.Append(value);
          hasData = true;
        }
      }
    }
  }
}
