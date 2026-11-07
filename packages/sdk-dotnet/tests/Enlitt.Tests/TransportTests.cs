namespace Enlitt.Tests;

/// <summary>Headers, rate-limit waiting, redirects and the URL rules of the managed transport.</summary>
public class TransportTests
{
  private const string UsageBody = """{"standard":{"remaining_percent":50,"limit_cap_nano_usd":"100"},"premium":{"remaining_percent":0,"limit_cap_nano_usd":"0"}}""";

  private static StubHandler RateLimited(int refusals, string retryAfter = "1") =>
      StubHandler.Sequence(
          Enumerable.Repeat<Func<HttpResponseMessage>>(
                  () => StubHandler.Reply(429, """{"error":{"message":"slow","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}""", "application/json", ("retry-after", retryAfter)),
                  refusals)
              .Append(() => StubHandler.Reply(200, UsageBody))
              .ToArray());

  [Fact]
  public async Task EveryRequestCarriesTheFullHeaderSet()
  {
    var handler = StubHandler.Always(200, UsageBody);
    await EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default);

    RecordedRequest request = Assert.Single(handler.Requests);
    Assert.Equal(HttpMethod.Get, request.Method);
    Assert.Equal("https://api.test/v1/enlitt/usage", request.Uri.ToString());
    Assert.Equal("Bearer " + Kit.Secret, request.Header("Authorization"));
    Assert.Equal("Bearer " + Kit.SessionToken, request.Header("X-Enlitt-User-Authorization"));
    Assert.Equal("application/json", request.Header("Accept"));
    Assert.Equal(EnlittContract.ApiVersion, request.Header(EnlittContract.VersionHeader));
    Assert.Equal("enlitt-dotnet/" + SdkVersion.Value, request.Header("X-Enlitt-SDK-Version"));
    Assert.StartsWith("req_", request.Header("X-Request-Id"));
    Assert.Null(request.Header("Idempotency-Key"));
  }

  [Fact]
  public async Task RateLimitWaitsFloorPlusJitterThenSucceeds()
  {
    var time = new Kit.FakeTime { Jitter = 0.5 };
    var attempts = new List<(int Attempt, int Delay)>();
    EnlittOptions options = Kit.Options() with
    {
      RateLimit = new EnlittRateLimitRetryOptions { OnRateLimit = (a, d) => attempts.Add((a, d)) },
    };
    var handler = RateLimited(2, "2");

    EnlittUsage usage = await EnlittSdk.UsageCoreAsync(options, time.Seams(handler), default);

    Assert.Equal(50, usage.Standard.RemainingPercent);
    Assert.Equal(3, handler.Requests.Count);
    // Floor 2000 plus half of the uniform jitter range [0, floor / 2): 2000 + 0.5 * 1000.
    Assert.Equal([2500, 2500], time.Delays);
    Assert.Equal([(1, 2500), (2, 2500)], attempts);
  }

  [Fact]
  public async Task RateLimitWithoutAHeaderUsesAOneSecondFloor()
  {
    var time = new Kit.FakeTime();
    var handler = StubHandler.Sequence(
        () => StubHandler.Reply(429, """{"error":{"message":"slow","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}"""),
        () => StubHandler.Reply(200, UsageBody));
    await EnlittSdk.UsageCoreAsync(Kit.Options(), time.Seams(handler), default);
    Assert.Equal([1000], time.Delays);
  }

  [Fact]
  public async Task RateLimitStopsAtMaxAttemptsAndThrowsTheRefusal()
  {
    var time = new Kit.FakeTime();
    EnlittOptions options = Kit.Options() with { RateLimit = new EnlittRateLimitRetryOptions { MaxAttempts = 2 } };
    var handler = RateLimited(5);
    EnlittRateLimitException ex = await Assert.ThrowsAsync<EnlittRateLimitException>(() => EnlittSdk.UsageCoreAsync(options, time.Seams(handler), default));
    Assert.Equal(1000, ex.RetryAfterMs);
    Assert.Equal(2, handler.Requests.Count);
    Assert.Single(time.Delays);
  }

  [Fact]
  public async Task RateLimitStopsWhenTheNextWaitWouldPassTheBudget()
  {
    var time = new Kit.FakeTime();
    EnlittOptions options = Kit.Options() with { RateLimit = new EnlittRateLimitRetryOptions { MaxAttempts = 10, MaxTotalWaitMs = 1500 } };
    var handler = RateLimited(10);
    await Assert.ThrowsAsync<EnlittRateLimitException>(() => EnlittSdk.UsageCoreAsync(options, time.Seams(handler), default));
    // The first 1000 ms wait fits; the second would end at 2000 ms, past the 1500 ms budget.
    Assert.Equal([1000], time.Delays);
    Assert.Equal(2, handler.Requests.Count);
  }

  [Fact]
  public async Task MaxAttemptsOfOneNeverWaits()
  {
    var time = new Kit.FakeTime();
    EnlittOptions options = Kit.Options() with { RateLimit = new EnlittRateLimitRetryOptions { MaxAttempts = 1 } };
    var handler = RateLimited(3);
    await Assert.ThrowsAsync<EnlittRateLimitException>(() => EnlittSdk.UsageCoreAsync(options, time.Seams(handler), default));
    Assert.Single(handler.Requests);
    Assert.Empty(time.Delays);
  }

  [Theory]
  [InlineData(500)]
  [InlineData(502)]
  [InlineData(503)]
  [InlineData(409)]
  public async Task NoOtherStatusIsRetried(int status)
  {
    var handler = StubHandler.Always(status, """{"error":{"message":"x","type":"server_error","param":null,"code":"server_error"}}""");
    await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), new Kit.FakeTime().Seams(handler), default));
    Assert.Single(handler.Requests);
  }

  [Fact]
  public async Task ARedirectIsNeverFollowedAndItsBodyIsNotRead()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(302, "secret-body", "text/plain", ("location", "https://evil.test/")));
    EnlittException ex = await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal(EnlittException.TransportFailed, ex.Code);
    Assert.DoesNotContain("secret-body", ex.Message);
    Assert.Single(handler.Requests);
  }

  [Fact]
  public async Task ANetworkFailureIsATransportFailure()
  {
    var handler = new StubHandler(_ => throw new HttpRequestException("boom"));
    EnlittException ex = await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal(EnlittException.TransportFailed, ex.Code);
    Assert.IsType<HttpRequestException>(ex.InnerException);
  }

  [Fact]
  public async Task ACancelledTokenThrowsOperationCanceled()
  {
    using var cts = new CancellationTokenSource();
    await cts.CancelAsync();
    var handler = new StubHandler(_ => StubHandler.Reply(200, UsageBody));
    await Assert.ThrowsAnyAsync<OperationCanceledException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), cts.Token));
  }

  [Theory]
  [InlineData("https://api.enlitt.com")]
  [InlineData("https://api.test/")]
  [InlineData("http://localhost:8787")]
  [InlineData("http://127.0.0.1:8787")]
  [InlineData("http://[::1]:8787")]
  public void AcceptsHttpsAndLoopbackHttp(string url)
  {
    Assert.StartsWith("http", InternalClient.ResolveBaseUrl(url));
    Assert.False(InternalClient.ResolveBaseUrl(url).EndsWith('/'));
  }

  [Theory]
  [InlineData("http://api.test")]
  [InlineData("ftp://api.test")]
  [InlineData("https://user:pw@api.test")]
  [InlineData("https://api.test?x=1")]
  [InlineData("not a url")]
  public void RefusesOtherBaseUrls(string url)
  {
    Assert.Throws<EnlittConfigurationException>(() => InternalClient.ResolveBaseUrl(url));
  }

  [Fact]
  public async Task MissingSecretIsAConfigurationFailureBeforeAnyRequest()
  {
    var handler = StubHandler.Always(200, UsageBody);
    EnlittOptions options = Kit.Options() with { SecretKey = "bad key with spaces" };
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => EnlittSdk.UsageCoreAsync(options, Kit.Seams(handler), default));
    Assert.Empty(handler.Requests);
  }

  [Fact]
  public async Task ASuccessBodyThatIsNotJsonIsMalformed()
  {
    var handler = StubHandler.Always(200, "<html>nope</html>");
    EnlittException ex = await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal(EnlittException.MalformedResponse, ex.Code);
  }
}
