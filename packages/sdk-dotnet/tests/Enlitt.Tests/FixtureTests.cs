using System.Text;
using System.Text.Json.Nodes;

namespace Enlitt.Tests;

/// <summary>
/// Runs the shared protocol fixtures (<c>packages/protocol/fixtures</c>) through the .NET readers and writers.
/// The fixture folder is read at run time, so a new fixture is covered, or fails the suite, without a code change.
/// </summary>
public class FixtureTests
{
  private static string Dir(string kind) => Path.Combine(Kit.RepoRoot(), "packages", "protocol", "fixtures", kind);

  private static JsonObject Load(string file) => JsonNode.Parse(File.ReadAllText(file))!.AsObject();

  public static IEnumerable<object[]> Files(string kind) =>
      Directory.GetFiles(Dir(kind), "*.json").OrderBy(f => f, StringComparer.Ordinal).Select(f => new object[] { Path.GetFileName(f) });

  public static IEnumerable<object[]> ErrorFiles() => Files("errors");

  public static IEnumerable<object[]> ResponseFiles() => Files("responses");

  public static IEnumerable<object[]> StreamFiles() => Files("streams");

  public static IEnumerable<object[]> RequestFiles() => Files("requests");

  // ---- errors -------------------------------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(ErrorFiles))]
  public async Task ErrorFixtureMapsToTheExpectedException(string file)
  {
    JsonObject fixture = Load(Path.Combine(Dir("errors"), file));
    JsonObject expected = fixture["expected"]!.AsObject();
    int status = fixture["http_status"]!.GetValue<int>();
    string bodyText = fixture["body"] is JsonValue v && v.TryGetValue(out string? s) ? s : fixture["body"]!.ToJsonString();
    var headers = new List<(string, string)>();
    foreach (var h in fixture["headers"]!.AsObject())
    {
      headers.Add((h.Key, h.Value!.GetValue<string>()));
    }

    // Through the real transport so the headers and the body bound are exercised too (one attempt: no retry wait).
    var handler = StubHandler.Always(status, bodyText, headers.ToArray());
    EnlittOptions options = Kit.Options() with { RateLimit = new EnlittRateLimitRetryOptions { MaxAttempts = 1 } };
    EnlittException ex = await Assert.ThrowsAnyAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(options, Kit.Seams(handler), default));

    Assert.Equal(expected["code"]!.GetValue<string>(), ex.Code);
    Assert.Equal(expected["retryable"]!.GetValue<bool>(), ex.Retryable);
    Assert.Equal(expected["code_recognized"]!.GetValue<bool>(), EnlittContract.ErrorCodes.ContainsKey(ex.Code));
    Assert.Equal(expected["retry_after_ms"]?.GetValue<int>(), ex.RetryAfterMs);

    Type type = expected["class"]!.GetValue<string>() switch
    {
      "authentication" => typeof(EnlittAuthenticationException),
      "authorization" => typeof(EnlittAuthorizationException),
      "login_required" => typeof(EnlittLoginRequiredException),
      "insufficient_credits" => typeof(EnlittInsufficientCreditsException),
      "limit_exceeded" => typeof(EnlittLimitExceededException),
      "subscription_inactive" => typeof(EnlittSubscriptionInactiveException),
      "rate_limit" => typeof(EnlittRateLimitException),
      "generic" => typeof(EnlittException),
      var other => throw new InvalidOperationException($"Fixture class '{other}' has no .NET mapping; add one."),
    };
    Assert.Equal(type, ex.GetType());
  }

  // ---- responses ----------------------------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(ResponseFiles))]
  public void ResponseFixtureReadsToTheExpectedShape(string file)
  {
    JsonObject fixture = Load(Path.Combine(Dir("responses"), file));
    string endpoint = fixture["endpoint"]!.GetValue<string>();
    if (endpoint == "business-info")
    {
      // Business info is a dashboard endpoint the SDK never reads.
      return;
    }

    Shape.ObjectShape shape = endpoint switch
    {
      "create-response" => WireShapes.Response,
      "begin-operation" => WireShapes.BeginOperation,
      "report-terminal" => WireShapes.ReportTerminal,
      "usage" => WireShapes.UsageResponse,
      var other => throw new InvalidOperationException($"Response fixture endpoint '{other}' has no reader; add one."),
    };

    JsonObject read = WireShapes.ReadBody(shape, fixture["body"]!.ToJsonString(), endpoint);
    JsonNode expected = fixture["expected_tolerant"] ?? fixture["body"]!;
    Assert.Equal(Canonical.Serialize(Canonical.Sorted(expected)!), Canonical.Serialize(Canonical.Sorted(read)!));
  }

  // ---- streams ------------------------------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(StreamFiles))]
  public async Task StreamFixtureEndsAsExpectedWhole(string file) => await RunStream(file, chunk: int.MaxValue);

  [Theory]
  [MemberData(nameof(StreamFiles))]
  public async Task StreamFixtureEndsAsExpectedInOneByteChunks(string file) => await RunStream(file, chunk: 1);

  private static async Task RunStream(string file, int chunk)
  {
    JsonObject fixture = Load(Path.Combine(Dir("streams"), file));
    JsonObject expected = fixture["expected"]!.AsObject();
    var text = new StringBuilder();
    foreach (JsonNode? ev in fixture["events"]!.AsArray())
    {
      text.Append("event: ").Append(ev!["event"]!.GetValue<string>()).Append('\n');
      text.Append("data: ").Append(ev["data"]!.ToJsonString()).Append("\n\n");
    }

    using var stream = new ChunkedStream(Encoding.UTF8.GetBytes(text.ToString()), chunk);
    var parts = new List<StdStreamPart>();
    EnlittException? failure = null;
    try
    {
      await foreach (StdStreamPart part in StandardWire.MapStreamAsync(SseReader.ReadAsync(stream)))
      {
        parts.Add(part);
      }
    }
    catch (EnlittException ex)
    {
      failure = ex;
    }

    string outcome = expected["outcome"]!.GetValue<string>();
    if (outcome == "invalid")
    {
      Assert.NotNull(failure);
      Assert.Equal(expected["error_code"]!.GetValue<string>(), failure!.Code);
      return;
    }

    Assert.Null(failure);
    StdFinish finish = Assert.IsType<StdFinish>(Assert.Single(parts.OfType<StdFinish>()));
    Assert.Same(parts[^1], finish);
    Assert.Equal(expected["finish_reason"]!.GetValue<string>(), finish.FinishReason);

    if (expected["output_text"] is { } outputText)
    {
      Assert.Equal(outputText.GetValue<string>(), string.Concat(parts.OfType<StdTextDelta>().Select(p => p.Text)));
    }

    if (expected["function_calls"] is JsonArray calls)
    {
      var actual = parts.OfType<StdToolCallPart>().Select(p => p.Call).ToList();
      Assert.Equal(calls.Count, actual.Count);
      for (int i = 0; i < calls.Count; i++)
      {
        Assert.Equal(calls[i]!["call_id"]!.GetValue<string>(), actual[i].Id);
        Assert.Equal(calls[i]!["name"]!.GetValue<string>(), actual[i].Name);
        Assert.Equal(calls[i]!["arguments"]!.GetValue<string>(), actual[i].Arguments);
      }
    }
  }

  // ---- requests -----------------------------------------------------------------------------------------------

  /// <summary>How to rebuild each valid request fixture through the SDK's own writers. A valid fixture without an entry fails the suite.</summary>
  private static readonly Dictionary<string, Func<JsonObject>> Scenarios = new()
  {
    ["begin-operation--basic.json"] = () => Begin("1000"),
    ["begin-operation--zero-max-charge.json"] = () => Begin("0"),
    ["create-response--text.json"] = () => Create(new StdUser([new StdText("Hello")])),
    ["create-response--image-input.json"] = () => Create(new StdUser([new StdText("Describe this image."), new StdImageUrl("https://example.com/image.png")])),
    ["create-response--tools-and-results.json"] = () => StandardWire.BuildRequest(new StdRequest(
        [
            new StdUser([new StdText("What is the weather?")]),
                new StdAssistant(null, [new StdToolCall("call_weather", "weather", "{\"city\":\"Boston\"}")]),
                new StdToolResult("call_weather", "Sunny"),
            ],
        [new StdTool("weather", "Gets the weather.", new JsonObject { ["type"] = "object" })],
        null,
        false,
        null)),
    ["report-terminal--completed.json"] = () => PremiumLifecycle.BuildReport("report-id-123456", PremiumStatus.Completed, "700", null),
    ["report-terminal--failed-zero.json"] = () => PremiumLifecycle.BuildReport("report-id-123456", PremiumStatus.Failed, "0", null),
  };

  private static JsonObject Begin(string max) =>
      PremiumLifecycle.BuildBegin(new PremiumChargeRequest(max, new PremiumProvider("openai", "gpt-5"), null, null, null));

  private static JsonObject Create(StdMessage message) =>
      StandardWire.BuildRequest(new StdRequest([message], null, null, false, null));

  [Theory]
  [MemberData(nameof(RequestFiles))]
  public void ValidRequestFixtureIsWrittenByTheSdk(string file)
  {
    JsonObject fixture = Load(Path.Combine(Dir("requests"), file));
    if (!fixture["valid"]!.GetValue<bool>())
    {
      // Invalid fixtures describe server refusals of shapes the SDK cannot be asked to write.
      return;
    }

    Assert.True(Scenarios.TryGetValue(file, out Func<JsonObject>? build), $"Valid request fixture {file} has no scenario in FixtureTests.Scenarios.");
    Assert.Equal(Canonical.Serialize(Canonical.Sorted(fixture["body"])!), Canonical.Serialize(Canonical.Sorted(build!())!));
  }

  /// <summary>A readable stream that hands out at most <c>chunk</c> bytes per read, to prove framing across chunk boundaries.</summary>
  private sealed class ChunkedStream(byte[] data, int chunk) : Stream
  {
    private int _position;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => throw new NotSupportedException();

    public override long Position { get => _position; set => throw new NotSupportedException(); }

    public override int Read(byte[] buffer, int offset, int count)
    {
      int n = Math.Min(Math.Min(count, chunk), data.Length - _position);
      Array.Copy(data, _position, buffer, offset, n);
      _position += n;
      return n;
    }

    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
      int n = Math.Min(Math.Min(buffer.Length, chunk), data.Length - _position);
      data.AsMemory(_position, n).CopyTo(buffer);
      _position += n;
      return ValueTask.FromResult(n);
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
  }
}
