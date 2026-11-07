namespace Enlitt.Tests;

/// <summary>The ambient session has three states and never leaks between concurrent flows.</summary>
public class SessionTests
{
  [Fact]
  public void NoContextIsAConfigurationFailure()
  {
    Assert.Throws<EnlittConfigurationException>(() => EnlittSdk.GetEnlittSession());
  }

  [Fact]
  public async Task ContextHoldingNullReadsAsSignedOut()
  {
    EnlittSession? seen = new("placeholder");
    await EnlittSdk.RunWithEnlittSessionAsync(null, () =>
    {
      seen = EnlittSdk.GetEnlittSession();
      return Task.CompletedTask;
    });
    Assert.Null(seen);
  }

  [Fact]
  public async Task ContextHoldingASessionReadsThatSession()
  {
    var session = new EnlittSession("abc");
    EnlittSession? seen = null;
    await EnlittSdk.RunWithEnlittSessionAsync(session, async () =>
    {
      await Task.Yield();
      seen = EnlittSdk.GetEnlittSession();
    });
    Assert.Same(session, seen);

    // The context is gone again afterwards.
    Assert.Throws<EnlittConfigurationException>(() => EnlittSdk.GetEnlittSession());
  }

  [Fact]
  public async Task SignedOutContextMakesACallThrowLoginRequiredBeforeAnyRequest()
  {
    var handler = StubHandler.Always(200, "{}");
    EnlittOptions options = Kit.Options() with { Session = null };
    await EnlittSdk.RunWithEnlittSessionAsync(null, async () =>
    {
      await Assert.ThrowsAsync<EnlittLoginRequiredException>(() => EnlittSdk.UsageCoreAsync(options, Kit.Seams(handler), default));
    });
    Assert.Empty(handler.Requests);
  }

  [Fact]
  public async Task MissingContextMakesACallThrowConfigurationBeforeAnyRequest()
  {
    var handler = StubHandler.Always(200, "{}");
    EnlittOptions options = Kit.Options() with { Session = null };
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => EnlittSdk.UsageCoreAsync(options, Kit.Seams(handler), default));
    Assert.Empty(handler.Requests);
  }

  [Fact]
  public async Task ParallelFlowsEachSeeOnlyTheirOwnSession()
  {
    Task<string>[] flows = Enumerable.Range(0, 20).Select(i => Task.Run(() =>
        EnlittSdk.RunWithEnlittSessionAsync(new EnlittSession("tok" + i), async () =>
        {
          await Task.Delay(5);
          await Task.Yield();
          return EnlittSdk.GetEnlittSession()!.ToString() + i;
        }))).ToArray();
    string[] results = await Task.WhenAll(flows);
    Assert.All(results, r => Assert.StartsWith("EnlittSession(<redacted>)", r));
    Assert.Throws<EnlittConfigurationException>(() => EnlittSdk.GetEnlittSession());
  }

  [Fact]
  public async Task ParallelFlowsSendTheirOwnToken()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(200, """{"standard":{"remaining_percent":1,"limit_cap_nano_usd":"1"},"premium":{"remaining_percent":2,"limit_cap_nano_usd":"2"}}"""));
    EnlittOptions options = Kit.Options() with { Session = null };
    await Task.WhenAll(Enumerable.Range(0, 10).Select(i => Task.Run(() =>
        EnlittSdk.RunWithEnlittSessionAsync(new EnlittSession("tok" + i), async () =>
        {
          await Task.Yield();
          await EnlittSdk.UsageCoreAsync(options, Kit.Seams(handler), default);
        }))));
    string[] tokens = handler.Requests.Select(r => r.Header("X-Enlitt-User-Authorization")!).Order().ToArray();
    Assert.Equal(Enumerable.Range(0, 10).Select(i => "Bearer tok" + i).Order().ToArray(), tokens);
  }

  [Fact]
  public void SessionNeverRevealsItsToken()
  {
    var session = new EnlittSession("super-secret-token");
    Assert.DoesNotContain("super-secret-token", session.ToString());
    Assert.DoesNotContain("super-secret-token", $"{session}");
  }

  [Theory]
  [InlineData("")]
  [InlineData("has\nnewline")]
  [InlineData("has\0nul")]
  public void SessionRefusesUnusableTokens(string token)
  {
    Assert.Throws<EnlittConfigurationException>(() => new EnlittSession(token));
  }

  [Fact]
  public void SessionRefusesATokenOver4096Characters()
  {
    Assert.Throws<EnlittConfigurationException>(() => new EnlittSession(new string('a', 4097)));
    _ = new EnlittSession(new string('a', 4096));
  }
}
