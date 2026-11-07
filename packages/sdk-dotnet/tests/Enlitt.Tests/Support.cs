using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Enlitt.Tests;

/// <summary>One request a <see cref="StubHandler"/> saw, with the body already read into a string.</summary>
internal sealed record RecordedRequest(HttpMethod Method, Uri Uri, IReadOnlyDictionary<string, string> Headers, string Body)
{
  /// <summary>The path and query, for brief assertions.</summary>
  public string Path => Uri.AbsolutePath;

  /// <summary>The request header value, or null when the header was not sent.</summary>
  public string? Header(string name) => Headers.TryGetValue(name, out string? value) ? value : null;

  /// <summary>The body parsed as a JSON object.</summary>
  public JsonObject Json() => JsonNode.Parse(Body)!.AsObject();
}

/// <summary>A scripted <see cref="HttpMessageHandler"/>: records every request and answers from a responder. No network is touched.</summary>
internal sealed class StubHandler(Func<RecordedRequest, HttpResponseMessage> responder) : HttpMessageHandler
{
  private readonly List<RecordedRequest> _requests = [];

  /// <summary>Every request seen so far, oldest first.</summary>
  public IReadOnlyList<RecordedRequest> Requests
  {
    get
    {
      lock (_requests)
      {
        return _requests.ToList();
      }
    }
  }

  /// <summary>A handler that answers every request with the same JSON body.</summary>
  public static StubHandler Always(int status, string body, params (string Name, string Value)[] headers) =>
      new(_ => Reply(status, body, "application/json", headers));

  /// <summary>A handler that answers from a queue of responses, one per request; the last one repeats.</summary>
  public static StubHandler Sequence(params Func<HttpResponseMessage>[] responses)
  {
    int index = 0;
    return new StubHandler(_ => responses[Math.Min(Interlocked.Increment(ref index) - 1, responses.Length - 1)]());
  }

  /// <summary>Builds a response with a text body.</summary>
  public static HttpResponseMessage Reply(int status, string body, string contentType = "application/json", params (string Name, string Value)[] headers)
  {
    var response = new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, contentType) };
    foreach ((string name, string value) in headers)
    {
      response.Headers.TryAddWithoutValidation(name, value);
    }

    return response;
  }

  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
  {
    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var h in request.Headers)
    {
      headers[h.Key] = string.Join(", ", h.Value);
    }

    string body = string.Empty;
    if (request.Content is not null)
    {
      foreach (var h in request.Content.Headers)
      {
        headers[h.Key] = string.Join(", ", h.Value);
      }

      body = await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
    }

    var recorded = new RecordedRequest(request.Method, request.RequestUri!, headers, body);
    lock (_requests)
    {
      _requests.Add(recorded);
    }

    return responder(recorded);
  }
}

/// <summary>Shared builders for options, seams and canned wire bodies.</summary>
internal static class Kit
{
  public const string Secret = "sk_test_secret";
  public const string SessionToken = "sess_token_value";
  public const string BaseUrl = "https://api.test";

  /// <summary>Seams that never sleep: delays are recorded, the clock is a settable counter, jitter is fixed.</summary>
  public sealed class FakeTime
  {
    public long Now;
    public List<int> Delays { get; } = [];
    public double Jitter = 0;

    public TransportSeams Seams(HttpMessageHandler handler) => new()
    {
      Handler = handler,
      Clock = () => Now,
      Random = () => Jitter,
      Delay = (span, _) =>
      {
        Delays.Add((int)span.TotalMilliseconds);
        Now += (long)span.TotalMilliseconds;
        return Task.CompletedTask;
      },
    };
  }

  /// <summary>Options that point at the stub and carry an explicit session.</summary>
  public static EnlittOptions Options() =>
      new() { SecretKey = Secret, BaseUrl = BaseUrl, Session = new EnlittSession(SessionToken) };

  public static TransportSeams Seams(HttpMessageHandler handler) => new() { Handler = handler };

  public static string Begin(string operationId = "op_1", string max = "1000") =>
      $$"""{"operation_id":"{{operationId}}","billing":"managed","report_terminal":true,"effective_max_charge_nano_usd":"{{max}}","reserved_nano_usd":"{{max}}","terminal_deadline":"2030-01-01T00:00:00Z"}""";

  public static string Settled(string status = "completed", string charge = "700") =>
      $$$"""{"operation_id":"op_1","status":"{{{status}}}","idempotent_replay":false,"settlement":{"captured_nano_usd":"{{{charge}}}","released_nano_usd":"0","business_earnings_nano_usd":"{{{charge}}}"}}""";

  /// <summary>A handler that serves begin then terminal-report, recording both.</summary>
  public static StubHandler Premium(string max = "1000", Func<RecordedRequest, HttpResponseMessage?>? onReport = null) =>
      new(request => request.Path.EndsWith("/terminal", StringComparison.Ordinal)
          ? onReport?.Invoke(request) ?? StubHandler.Reply(200, Settled())
          : StubHandler.Reply(200, Begin(max: max)));

  public static WithPremiumChargeOptions PremiumOptions(string maxCharge = "1000", Action<EnlittException>? onReportError = null) =>
      new()
      {
        SecretKey = Secret,
        BaseUrl = BaseUrl,
        Session = new EnlittSession(SessionToken),
        MaxCharge = maxCharge,
        Provider = new PremiumProvider("openai", "gpt-5"),
        OnTerminalReportError = onReportError,
      };

  /// <summary>The repository root, found by walking up to the folder that holds <c>packages/protocol/fixtures</c>.</summary>
  public static string RepoRoot()
  {
    string? dir = AppContext.BaseDirectory;
    while (dir is not null && !Directory.Exists(Path.Combine(dir, "packages", "protocol", "fixtures")))
    {
      dir = Path.GetDirectoryName(dir);
    }

    return dir ?? throw new InvalidOperationException("packages/protocol/fixtures was not found above the test binaries.");
  }

  public static string PackageRoot() => Path.Combine(RepoRoot(), "packages", "sdk-dotnet");
}

/// <summary>A clock tests move by hand; the stores and handlers read time only through it.</summary>
internal sealed class ManualTime : TimeProvider
{
  private DateTimeOffset _now = new(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);

  public override DateTimeOffset GetUtcNow() => _now;

  public void Advance(TimeSpan span) => _now += span;
}
