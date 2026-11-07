using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace Enlitt;

/// <summary>
/// Test seams for the transport: a replacement message handler, delay, clock and random source.
/// Internal on purpose: no public option replaces the HTTP stack, adds headers or changes retries.
/// </summary>
internal sealed class TransportSeams
{
  /// <summary>Replaces the shared <c>SocketsHttpHandler</c>.</summary>
  internal HttpMessageHandler? Handler { get; init; }

  /// <summary>Replaces <c>Task.Delay</c> for rate-limit waits and terminal-report retries.</summary>
  internal Func<TimeSpan, CancellationToken, Task>? Delay { get; init; }

  /// <summary>Replaces the monotonic millisecond clock.</summary>
  internal Func<long>? Clock { get; init; }

  /// <summary>Replaces the uniform [0,1) random source used for jitter.</summary>
  internal Func<double>? Random { get; init; }
}

/// <summary>The rate-limit wait settings after the caller's options were folded over the SDK defaults.</summary>
internal sealed record RateLimitSettings(int MaxAttempts, long MaxTotalWaitMs, Action<int, int>? OnRateLimit);

/// <summary>One request to Enlitt.</summary>
/// <param name="Method">GET or POST.</param>
/// <param name="Path">The path, starting with a slash.</param>
/// <param name="Body">The JSON body, or null for a GET.</param>
/// <param name="CallId">The call identity sent as <c>Idempotency-Key</c>; null for a GET.</param>
/// <param name="Accept">The media type the caller wants.</param>
internal sealed record EnlittRequest(HttpMethod Method, string Path, string? Body, string? CallId, string Accept);

/// <summary>
/// The one internal client built per SDK entry call. Holding one is what makes a call managed: there is no client that
/// represents a missing personal user, and no code path holds a nullable client.
/// </summary>
internal sealed class InternalClient
{
  /// <summary>The documented default origin of Enlitt's API.</summary>
  internal const string DefaultBaseUrl = "https://api.enlitt.com";

  private const int MaxResponseBodyBytes = 16 << 20;
  private const int MaxErrorBodyBytes = 64 << 10;
  private const int DefaultMaxAttempts = 3;
  private const long DefaultMaxTotalWaitMs = 30_000;
  private const int DefaultRetryFloorMs = 1000;

  private static readonly Lazy<HttpClient> SharedHttp = new(CreateSharedHttp);

  private readonly HttpClient _http;
  private readonly Func<TimeSpan, CancellationToken, Task> _delay;
  private readonly Func<long> _clock;
  private readonly Func<double> _random;
  private readonly Func<EnlittSession> _resolveSession;

  private InternalClient(
      string baseUrl,
      string businessAuthorization,
      Func<EnlittSession> resolveSession,
      RateLimitSettings rateLimit,
      Action<EnlittException>? onTerminalReportError,
      TransportSeams? seams)
  {
    BaseUrl = baseUrl;
    BusinessAuthorization = businessAuthorization;
    _resolveSession = resolveSession;
    RateLimit = rateLimit;
    OnTerminalReportError = onTerminalReportError;
    _http = seams?.Handler is { } handler ? new HttpClient(handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan } : SharedHttp.Value;
    _delay = seams?.Delay ?? ((span, token) => Task.Delay(span, token));
    _clock = seams?.Clock ?? (() => Environment.TickCount64);
    _random = seams?.Random ?? (() => Random.Shared.NextDouble());
  }

  /// <summary>The validated base URL without a trailing slash.</summary>
  internal string BaseUrl { get; }

  /// <summary>The single <c>Bearer &lt;secret&gt;</c> value; never logged.</summary>
  internal string BusinessAuthorization { get; }

  /// <summary>The rate-limit wait settings.</summary>
  internal RateLimitSettings RateLimit { get; }

  /// <summary>Observer of undeliverable premium terminal reports.</summary>
  internal Action<EnlittException>? OnTerminalReportError { get; }

  /// <summary>Waits through the (possibly injected) delay seam.</summary>
  internal Task DelayAsync(TimeSpan span, CancellationToken cancellationToken) => _delay(span, cancellationToken);

  /// <summary>
  /// Builds the client: resolves the secret and the base URL, and folds the rate-limit options over the defaults.
  /// </summary>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  internal static InternalClient Create(EnlittOptions? options, TransportSeams? seams = null)
  {
    options ??= new EnlittOptions();
    string authorization = Secrets.ResolveBusinessAuthorizationHeader(options.SecretKey);
    string baseUrl = ResolveBaseUrl(options.BaseUrl);
    EnlittSession? explicitSession = options.Session;

    var rateLimit = new RateLimitSettings(
        Math.Max(1, options.RateLimit?.MaxAttempts ?? DefaultMaxAttempts),
        options.RateLimit?.MaxTotalWaitMs ?? DefaultMaxTotalWaitMs,
        options.RateLimit?.OnRateLimit);

    return new InternalClient(baseUrl, authorization, () => SessionContext.Resolve(explicitSession), rateLimit, options.OnTerminalReportError, seams);
  }

  /// <summary>Resolves the base URL: the option, then <c>ENLITT_BASE_URL</c>, then the deployed origin; https only, plus loopback http.</summary>
  internal static string ResolveBaseUrl(string? option)
  {
    string raw = !string.IsNullOrWhiteSpace(option) ? option : Environment.GetEnvironmentVariable("ENLITT_BASE_URL") is { Length: > 0 } env ? env : DefaultBaseUrl;
    if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out Uri? uri)
        || !(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && TransportRules.IsLoopbackHost(uri.Host)))
        || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
    {
      throw new EnlittConfigurationException("The Enlitt base URL must be an absolute https URL (http is accepted only for localhost, 127.0.0.1 and [::1]).");
    }

    return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
  }

  private static HttpClient CreateSharedHttp()
  {
    var handler = new SocketsHttpHandler
    {
      AllowAutoRedirect = false,
      UseProxy = true,
      Proxy = HttpClient.DefaultProxy,
      PooledConnectionLifetime = TimeSpan.FromMinutes(5),
      MaxResponseHeadersLength = 64, // KiB; bounds the header block
    };
    return new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
  }

  /// <summary>
  /// Sends one request and returns the successful response with its headers read (the body may still be streaming).
  /// Every non-success response is turned into the matching <see cref="EnlittException"/>; a rate-limit refusal waits and retries.
  /// </summary>
  /// <exception cref="OperationCanceledException">The caller's token was cancelled.</exception>
  internal async Task<HttpResponseMessage> SendAsync(EnlittRequest request, CancellationToken cancellationToken)
  {
    int attempt = 0;
    long? firstRefusalAt = null;
    while (true)
    {
      attempt++;
      try
      {
        return await SendOnceAsync(request, cancellationToken).ConfigureAwait(false);
      }
      catch (EnlittRateLimitException refusal)
      {
        firstRefusalAt ??= _clock();
        if (attempt >= RateLimit.MaxAttempts)
        {
          throw;
        }

        // The jittered wait: floor + uniform(0, floor / 2), never exactly the advertised instant.
        int floor = refusal.RetryAfterMs ?? DefaultRetryFloorMs;
        int delayMs = floor + (int)(_random() * (floor / 2.0));
        if (_clock() - firstRefusalAt.Value + delayMs > RateLimit.MaxTotalWaitMs)
        {
          throw;
        }

        RateLimit.OnRateLimit?.Invoke(attempt, delayMs);
        await _delay(TimeSpan.FromMilliseconds(delayMs), cancellationToken).ConfigureAwait(false);
      }
    }
  }

  private async Task<HttpResponseMessage> SendOnceAsync(EnlittRequest request, CancellationToken cancellationToken)
  {
    // The session is resolved before the wrapped provider (or any request) is touched.
    EnlittSession session = _resolveSession();

    using var message = new HttpRequestMessage(request.Method, BaseUrl + request.Path);
    message.Headers.TryAddWithoutValidation("Authorization", BusinessAuthorization);
    message.Headers.TryAddWithoutValidation("X-Enlitt-User-Authorization", "Bearer " + session.Token);
    message.Headers.TryAddWithoutValidation("Accept", request.Accept);
    message.Headers.TryAddWithoutValidation("X-Request-Id", "req_" + Guid.NewGuid().ToString("N"));
    message.Headers.TryAddWithoutValidation(EnlittContract.VersionHeader, EnlittContract.ApiVersion);
    message.Headers.TryAddWithoutValidation("X-Enlitt-SDK-Version", "enlitt-dotnet/" + SdkVersion.Value);
    if (request.CallId is not null)
    {
      message.Headers.TryAddWithoutValidation("Idempotency-Key", request.CallId);
    }

    if (request.Body is not null)
    {
      message.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(request.Body));
      message.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
    }

    HttpResponseMessage response;
    try
    {
      response = await _http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or FormatException)
    {
      throw EnlittErrors.Transport("The request to Enlitt failed before any response arrived.", ex);
    }

    int status = (int)response.StatusCode;
    if (status is >= 200 and <= 299)
    {
      return response;
    }

    try
    {
      if (status is >= 300 and <= 399)
      {
        // Never read a redirect's body and never follow it: it would resend two principals' credentials elsewhere.
        throw EnlittErrors.Transport("Enlitt answered with a redirect, which the SDK never follows.");
      }

      string body = await ReadTextAsync(response, MaxErrorBodyBytes, cancellationToken).ConfigureAwait(false);
      response.Headers.TryGetValues("x-request-id", out IEnumerable<string>? ids);
      response.Headers.TryGetValues("retry-after", out IEnumerable<string>? retry);
      throw EnlittErrors.FromResponse(status, ids?.FirstOrDefault(), retry?.FirstOrDefault(), body);
    }
    finally
    {
      response.Dispose();
    }
  }

  /// <summary>Reads at most <paramref name="maxBytes"/> of the body as UTF-8 text; a longer body is cut (and so fails parsing).</summary>
  internal static async Task<string> ReadTextAsync(HttpResponseMessage response, int maxBytes, CancellationToken cancellationToken)
  {
    try
    {
      await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
      using var buffer = new MemoryStream();
      byte[] chunk = new byte[8192];
      while (buffer.Length < maxBytes)
      {
        int read = await stream.ReadAsync(chunk.AsMemory(0, (int)Math.Min(chunk.Length, maxBytes - buffer.Length)), cancellationToken).ConfigureAwait(false);
        if (read == 0)
        {
          break;
        }

        buffer.Write(chunk, 0, read);
      }

      return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }
    catch (Exception ex) when (ex is HttpRequestException or IOException)
    {
      throw EnlittErrors.Transport("The Enlitt response body could not be read.", ex);
    }
  }

  /// <summary>Reads a successful non-streaming body with the deployed size bound.</summary>
  internal static Task<string> ReadSuccessBodyAsync(HttpResponseMessage response, CancellationToken cancellationToken) =>
      ReadTextAsync(response, MaxResponseBodyBytes, cancellationToken);

  /// <summary>Opens the body of a streaming response.</summary>
  internal static async Task<Stream> OpenStreamAsync(HttpResponseMessage response, CancellationToken cancellationToken)
  {
    try
    {
      return await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is HttpRequestException or IOException)
    {
      throw EnlittErrors.Transport("The Enlitt response stream could not be opened.", ex);
    }
  }

  /// <summary>The shared (or seam-provided) HTTP client, for the Account exchange and revocation requests.</summary>
  internal static HttpClient HttpFor(TransportSeams? seams) =>
      seams?.Handler is { } handler ? new HttpClient(handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan } : SharedHttp.Value;
}

/// <summary>Small transport helpers shared with the error classifier and the handlers.</summary>
internal static class TransportRules
{
  /// <summary>True for the loopback hosts the SDK accepts over plain http.</summary>
  internal static bool IsLoopbackHost(string host) =>
      host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || host == "127.0.0.1" || host == "[::1]" || host == "::1";

  /// <summary>True when an <see cref="HttpStatusCode"/> value is a redirect.</summary>
  internal static bool IsRedirect(HttpStatusCode status) => (int)status is >= 300 and <= 399;
}
