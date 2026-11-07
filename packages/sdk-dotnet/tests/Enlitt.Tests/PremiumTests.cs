using System.Text.Json.Nodes;

namespace Enlitt.Tests;

/// <summary>The premium lifecycle: begin, run, exactly one terminal report.</summary>
public class PremiumTests
{
  private static TransportSeams Fast(HttpMessageHandler handler) => new Kit.FakeTime().Seams(handler);

  private static RecordedRequest Report(StubHandler handler) => handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal));

  private static int Reports(StubHandler handler) => handler.Requests.Count(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal));

  [Fact]
  public async Task CompletedCallChargesTheLastAmountAndReportsOnce()
  {
    StubHandler handler = Kit.Premium();
    string result = await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (charge, handle, _) =>
    {
      Assert.Equal("op_1", handle.OperationId);
      Assert.Equal("1000", handle.EffectiveMaxChargeNanoUsd);
      charge("100");
      charge("700");
      return Task.FromResult("answer");
    }, Fast(handler), default);

    Assert.Equal("answer", result);
    Assert.Equal(2, handler.Requests.Count);
    JsonObject body = Report(handler).Json();
    Assert.Equal("completed", body["status"]!.GetValue<string>());
    Assert.Equal("700", body["charge_nano_usd"]!.GetValue<string>());
    Assert.Equal("/v1/enlitt/operations/op_1/terminal", Report(handler).Path);
    Assert.Equal(body["report_id"]!.GetValue<string>(), Report(handler).Header("Idempotency-Key"));
  }

  [Fact]
  public async Task BeginCarriesTheCallIdentityAndFixtureBody()
  {
    StubHandler handler = Kit.Premium();
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions() with { IdempotencyKey = "my-call-key-0001" }, (_, _, _) => Task.FromResult(0), Fast(handler), default);
    RecordedRequest begin = handler.Requests[0];
    Assert.Equal("/v1/enlitt/operations", begin.Path);
    Assert.Equal("my-call-key-0001", begin.Header("Idempotency-Key"));
    Assert.Equal("premium", begin.Json()["mode"]!.GetValue<string>());
  }

  [Fact]
  public async Task NoChargeCallMeansZero()
  {
    StubHandler handler = Kit.Premium();
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (_, _, _) => Task.FromResult(0), Fast(handler), default);
    Assert.Equal("0", Report(handler).Json()["charge_nano_usd"]!.GetValue<string>());
  }

  [Fact]
  public async Task ChargeAboveTheEffectiveMaxIsClamped()
  {
    StubHandler handler = Kit.Premium(max: "500");
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (charge, _, _) =>
    {
      charge("999");
      return Task.FromResult(0);
    }, Fast(handler), default);
    Assert.Equal("500", Report(handler).Json()["charge_nano_usd"]!.GetValue<string>());
  }

  [Fact]
  public async Task AmountsBeyondInt64AreExact()
  {
    const string big = "9223372036854775808123"; // > 2^63, 22 digits
    StubHandler handler = Kit.Premium(max: big);
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(maxCharge: big), (charge, _, _) =>
    {
      charge(big);
      return Task.FromResult(0);
    }, Fast(handler), default);
    Assert.Equal(big, Report(handler).Json()["charge_nano_usd"]!.GetValue<string>());
  }

  [Theory]
  [InlineData("-1")]
  [InlineData("01")]
  [InlineData("1.5")]
  [InlineData("")]
  [InlineData("abc")]
  public async Task ABadChargeAmountIsAConfigurationErrorInsideRun(string amount)
  {
    StubHandler handler = Kit.Premium();
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (charge, _, _) =>
    {
      charge(amount);
      return Task.FromResult(0);
    }, Fast(handler), default));

    // The thrown error fails the call, and a failed call still reports exactly once, at zero.
    Assert.Equal(1, Reports(handler));
    Assert.Equal("failed", Report(handler).Json()["status"]!.GetValue<string>());
  }

  [Fact]
  public async Task AThrowingRunReportsFailedWithZeroAndRethrowsUnchanged()
  {
    StubHandler handler = Kit.Premium();
    var boom = new InvalidOperationException("provider exploded");
    InvalidOperationException caught = await Assert.ThrowsAsync<InvalidOperationException>(() =>
        EnlittSdk.WithPremiumChargeCoreAsync<int>(Kit.PremiumOptions(), (charge, _, _) =>
        {
          charge("900");
          throw boom;
        }, Fast(handler), default));

    Assert.Same(boom, caught);
    JsonObject body = Report(handler).Json();
    Assert.Equal("failed", body["status"]!.GetValue<string>());
    Assert.Equal("0", body["charge_nano_usd"]!.GetValue<string>());
    Assert.Equal(1, Reports(handler));
  }

  [Fact]
  public async Task ACanceledCallStillReportsAndKeepsItsCharge()
  {
    StubHandler handler = Kit.Premium();
    using var cts = new CancellationTokenSource();
    await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
        EnlittSdk.WithPremiumChargeCoreAsync<int>(Kit.PremiumOptions(), async (charge, _, token) =>
        {
          charge("300");
          await cts.CancelAsync();
          token.ThrowIfCancellationRequested();
          return 0;
        }, Fast(handler), cts.Token));

    JsonObject body = Report(handler).Json();
    Assert.Equal("canceled", body["status"]!.GetValue<string>());
    Assert.Equal("300", body["charge_nano_usd"]!.GetValue<string>());
    Assert.Equal(1, Reports(handler));
  }

  [Fact]
  public async Task AnyThrowAfterCancellationCountsAsCanceled()
  {
    StubHandler handler = Kit.Premium();
    using var cts = new CancellationTokenSource();
    await Assert.ThrowsAsync<InvalidOperationException>(() =>
        EnlittSdk.WithPremiumChargeCoreAsync<int>(Kit.PremiumOptions(), async (_, _, _) =>
        {
          await cts.CancelAsync();
          throw new InvalidOperationException("wrapped");
        }, Fast(handler), cts.Token));
    Assert.Equal("canceled", Report(handler).Json()["status"]!.GetValue<string>());
  }

  [Fact]
  public async Task ChargeAfterTheReportIsRefused()
  {
    StubHandler handler = Kit.Premium();
    PremiumChargeFunction? saved = null;
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (charge, _, _) =>
    {
      saved = charge;
      return Task.FromResult(0);
    }, Fast(handler), default);
    Assert.Throws<EnlittConfigurationException>(() => saved!("5"));
  }

  [Fact]
  public async Task DescribedFactsReachTheReport()
  {
    StubHandler handler = Kit.Premium();
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (_, handle, _) =>
    {
      handle.Describe(new PremiumTerminalFacts
      {
        Usage = new PremiumUsage { InputTokens = 10, OutputTokens = 20, CachedInputTokens = 3, ReasoningTokens = 4 },
        FinishReason = "stop",
        ProviderResponseId = "resp_1",
        Delivery = new PremiumDelivery(true, true),
        Timing = new PremiumTiming("2030-01-01T00:00:00Z", "2030-01-01T00:00:01Z"),
      });
      return Task.FromResult(0);
    }, Fast(handler), default);

    JsonObject body = Report(handler).Json();
    Assert.Equal(10, body["usage"]!["input_tokens"]!.GetValue<int>());
    Assert.Equal(4, body["usage"]!["reasoning_tokens"]!.GetValue<int>());
    Assert.Equal("stop", body["finish_reason"]!.GetValue<string>());
    Assert.True(body["delivery"]!["output_completed"]!.GetValue<bool>());
  }

  [Fact]
  public async Task ARefusedBeginNeverRunsTheModelCall()
  {
    var handler = StubHandler.Always(403, """{"error":{"message":"no","type":"insufficient_credits_error","param":null,"code":"premium_balance_exhausted"}}""");
    bool ran = false;
    await Assert.ThrowsAsync<EnlittInsufficientCreditsException>(() =>
        EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(), (_, _, _) =>
        {
          ran = true;
          return Task.FromResult(0);
        }, Fast(handler), default));
    Assert.False(ran);
    Assert.Single(handler.Requests);
  }

  [Fact]
  public async Task ReportIsRetriedThreeTimesThenGoesToTheHook()
  {
    EnlittException? hooked = null;
    StubHandler handler = Kit.Premium(onReport: _ => StubHandler.Reply(503, """{"error":{"message":"down","type":"server_error","param":null,"code":"server_error"}}"""));
    var time = new Kit.FakeTime();
    string result = await EnlittSdk.WithPremiumChargeCoreAsync(
        Kit.PremiumOptions(onReportError: e => hooked = e),
        (_, _, _) => Task.FromResult("ok"),
        time.Seams(handler),
        default);

    Assert.Equal("ok", result);
    Assert.Equal(3, Reports(handler));
    Assert.NotNull(hooked);
    Assert.Equal("server_error", hooked!.Code);
    Assert.Equal([200, 400], time.Delays);

    // One report id across every attempt.
    string?[] ids = handler.Requests.Where(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Select(r => r.Json()["report_id"]!.GetValue<string>()).Distinct().ToArray();
    Assert.Single(ids);
  }

  [Fact]
  public async Task ARecoveringReportStopsRetryingAndNeverCallsTheHook()
  {
    int calls = 0;
    EnlittException? hooked = null;
    StubHandler handler = Kit.Premium(onReport: _ => ++calls == 1
        ? StubHandler.Reply(503, """{"error":{"message":"down","type":"server_error","param":null,"code":"server_error"}}""")
        : StubHandler.Reply(200, Kit.Settled()));
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(onReportError: e => hooked = e), (_, _, _) => Task.FromResult(0), Fast(handler), default);
    Assert.Equal(2, Reports(handler));
    Assert.Null(hooked);
  }

  [Fact]
  public async Task AConflictOnReportGoesToTheHookWithoutFailingTheCall()
  {
    EnlittException? hooked = null;
    StubHandler handler = Kit.Premium(onReport: _ => StubHandler.Reply(409, """{"error":{"message":"busy","type":"invalid_request_error","param":null,"code":"conflict_error"}}"""));
    int result = await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(onReportError: e => hooked = e), (_, _, _) => Task.FromResult(42), Fast(handler), default);
    Assert.Equal(42, result);
    Assert.Equal("conflict_error", hooked!.Code);
    Assert.Equal(1, Reports(handler));
  }

  [Fact]
  public async Task AFutureReportStatusIsDeliveredNotAnError()
  {
    EnlittException? hooked = null;
    StubHandler handler = Kit.Premium(onReport: _ => StubHandler.Reply(200, Kit.Settled(status: "quantum")));
    await EnlittSdk.WithPremiumChargeCoreAsync(Kit.PremiumOptions(onReportError: e => hooked = e), (_, _, _) => Task.FromResult(0), Fast(handler), default);
    Assert.Null(hooked);
    Assert.Equal(1, Reports(handler));
  }

  [Fact]
  public async Task AFailingHookNeverBreaksTheCall()
  {
    StubHandler handler = Kit.Premium(onReport: _ => StubHandler.Reply(400, """{"error":{"message":"bad","type":"invalid_request_error","param":null,"code":"invalid_value"}}"""));
    int result = await EnlittSdk.WithPremiumChargeCoreAsync(
        Kit.PremiumOptions(onReportError: _ => throw new InvalidOperationException("hook bug")),
        (_, _, _) => Task.FromResult(7),
        Fast(handler),
        default);
    Assert.Equal(7, result);
  }

  public static IEnumerable<object[]> BadSettings() =>
  [
      [Kit.PremiumOptions("-5")],
        [Kit.PremiumOptions("007")],
        [Kit.PremiumOptions() with { IdempotencyKey = "short" }],
        [Kit.PremiumOptions() with { IdempotencyKey = "has space in it 000" }],
        [Kit.PremiumOptions() with { ReportingDeadlineMs = -1 }],
        [Kit.PremiumOptions() with { Metadata = new Dictionary<string, string> { ["enlitt_x"] = "v" } }],
        [Kit.PremiumOptions() with { Metadata = Enumerable.Range(0, 17).ToDictionary(i => "k" + i, _ => "v") }],
        [Kit.PremiumOptions() with { Provider = new PremiumProvider("", "m") }],
    ];

  [Theory]
  [MemberData(nameof(BadSettings))]
  public async Task InvalidSettingsFailBeforeAnyRequest(WithPremiumChargeOptions options)
  {
    StubHandler handler = Kit.Premium();
    await Assert.ThrowsAsync<EnlittConfigurationException>(() =>
        EnlittSdk.WithPremiumChargeCoreAsync(options, (_, _, _) => Task.FromResult(0), Fast(handler), default));
    Assert.Empty(handler.Requests);
  }
}
