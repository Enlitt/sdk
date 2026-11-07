using System.Text;
using System.Text.Json.Nodes;
using Enlitt.Extensions.AI;
using Microsoft.Extensions.AI;

namespace Enlitt.Tests;

/// <summary>The Microsoft.Extensions.AI adapters: mapping, refusals, premium pass-through and pricing.</summary>
public class ChatClientTests
{
  private static readonly ChatMessage[] Hello = [new(ChatRole.User, "Hi")];

  private static string Fixture(string folder, string name) =>
      File.ReadAllText(Path.Combine(Kit.RepoRoot(), "packages", "protocol", "fixtures", folder, name));

  /// <summary>The "completed" create-response fixture body.</summary>
  private static string CompletedBody() => Fixture("responses", "create-response--completed.json") is { } text
      ? JsonNode.Parse(text)!["body"]!.ToJsonString()
      : string.Empty;

  private static string SseBody(string fixture)
  {
    var text = new StringBuilder();
    foreach (JsonNode? ev in JsonNode.Parse(Fixture("streams", fixture))!["events"]!.AsArray())
    {
      text.Append("event: ").Append(ev!["event"]!.GetValue<string>()).Append('\n');
      text.Append("data: ").Append(ev["data"]!.ToJsonString()).Append("\n\n");
    }

    return text.ToString();
  }

  /// <summary>An inner provider client whose behaviour the test scripts.</summary>
  private sealed class FakeInner(
      Func<IEnumerable<ChatMessage>, ChatOptions?, ChatResponse>? respond = null,
      Func<ChatOptions?, IAsyncEnumerable<ChatResponseUpdate>>? stream = null) : IChatClient
  {
    public int Calls { get; private set; }

    public ChatOptions? LastOptions { get; private set; }

    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
      Calls++;
      LastOptions = options;
      return Task.FromResult(respond?.Invoke(messages, options) ?? new ChatResponse(new ChatMessage(ChatRole.Assistant, "ok")));
    }

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
      Calls++;
      LastOptions = options;
      return stream?.Invoke(options) ?? Updates();
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType == typeof(ChatClientMetadata) ? new ChatClientMetadata("openai", null, "gpt-5") : null;

    public void Dispose()
    {
    }

    public static async IAsyncEnumerable<ChatResponseUpdate> Updates(bool fail = false)
    {
      yield return new ChatResponseUpdate(ChatRole.Assistant, "Hel");
      await Task.Yield();
      if (fail)
      {
        throw new HttpRequestException("provider down");
      }

      yield return new ChatResponseUpdate(ChatRole.Assistant, "lo") { FinishReason = ChatFinishReason.Stop };
      yield return new ChatResponseUpdate { Contents = [new UsageContent(new UsageDetails { InputTokenCount = 10, OutputTokenCount = 20 })] };
    }
  }

  private static ChatOptions WithEnlitt(EnlittProviderOptions options) =>
      new() { AdditionalProperties = new AdditionalPropertiesDictionary { [EnlittProviderOptions.Key] = options } };

  private static string ReportedCharge(StubHandler handler) =>
      handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Json()["charge_nano_usd"]!.GetValue<string>();

  private static string ReportedStatus(StubHandler handler) =>
      handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Json()["status"]!.GetValue<string>();

  // ---- standard -----------------------------------------------------------------------------------------------

  [Fact]
  public async Task StandardMapsAMessageToTheRequestAndTheBodyToTheResponse()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(200, CompletedBody()));
    using IChatClient client = EnlittChatClient.Standard(Kit.Options(), Kit.Seams(handler));

    ChatResponse response = await client.GetResponseAsync(Hello, new ChatOptions { Instructions = "Be brief." });

    Assert.Equal("Hello", response.Text);
    RecordedRequest request = Assert.Single(handler.Requests);
    Assert.Equal("/v1/responses", request.Path);
    JsonObject body = request.Json();
    Assert.Equal("enlitt-standard", body["model"]!.GetValue<string>());
    Assert.Equal(2, body["messages"]!.AsArray().Count);
    Assert.Equal("Bearer " + Kit.Secret, request.Header("Authorization"));
    Assert.Equal("Bearer " + Kit.SessionToken, request.Header("X-Enlitt-User-Authorization"));
  }

  [Fact]
  public async Task StandardStreamsTextDeltas()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(200, SseBody("create-response--text-deltas.json"), "text/event-stream"));
    using IChatClient client = EnlittChatClient.Standard(Kit.Options(), Kit.Seams(handler));

    var text = new StringBuilder();
    await foreach (ChatResponseUpdate update in client.GetStreamingResponseAsync(Hello))
    {
      text.Append(update.Text);
    }

    Assert.Equal("Hello", text.ToString());
    Assert.True(Assert.Single(handler.Requests).Json()["stream"]!.GetValue<bool>());
  }

  [Fact]
  public async Task StandardGeneratesADistinctCallIdPerInvocationFromAnExplicitBase()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(200, CompletedBody()));
    using IChatClient client = EnlittChatClient.Standard(Kit.Options(), Kit.Seams(handler));
    ChatOptions options = WithEnlitt(new EnlittProviderOptions { IdempotencyKey = "base-key-0000001" });

    await client.GetResponseAsync(Hello, options);
    await client.GetResponseAsync(Hello, options);

    Assert.Equal(2, handler.Requests.Count);
    Assert.All(handler.Requests, r => Assert.StartsWith("base-key-0000001", r.Header("Idempotency-Key"), StringComparison.Ordinal));
  }

  [Fact]
  public async Task StandardRefusesBadInputBeforeAnyRequest()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(200, CompletedBody()));
    using IChatClient client = EnlittChatClient.Standard(Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, new ChatOptions { ModelId = "gpt-5" }));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, new ChatOptions { ConversationId = "c1" }));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "10" })));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { Price = "5" })));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { IdempotencyKey = "short" })));
    Assert.Empty(handler.Requests);
  }

  [Fact]
  public void StandardReportsItsMetadata()
  {
    using IChatClient client = EnlittChatClient.Standard(Kit.Options(), Kit.Seams(new StubHandler(_ => StubHandler.Reply(200, "{}"))));
    ChatClientMetadata? metadata = client.GetService<ChatClientMetadata>();
    Assert.Equal("enlitt-standard", metadata?.DefaultModelId);
  }

  // ---- premium ------------------------------------------------------------------------------------------------

  [Fact]
  public async Task PremiumAdmitsRunsTheInnerClientAndReportsTheConstantPrice()
  {
    StubHandler handler = Kit.Premium();
    var inner = new FakeInner();
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    ChatResponse response = await client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = "400" }));

    Assert.Equal("ok", response.Text);
    Assert.Equal(1, inner.Calls);
    Assert.Equal("400", ReportedCharge(handler));
    Assert.Equal("completed", ReportedStatus(handler));
    var metadata = Assert.IsType<EnlittPremiumMetadata>(response.AdditionalProperties![EnlittProviderOptions.Key]);
    Assert.Equal("op_1", metadata.OperationId);

    // The inner client never sees the Enlitt settings.
    Assert.False(inner.LastOptions?.AdditionalProperties?.ContainsKey(EnlittProviderOptions.Key) ?? false);

    // The begin request names the inner client's provider and model.
    JsonObject begin = handler.Requests[0].Json();
    Assert.Equal("openai", begin["provider"]!["id"]!.GetValue<string>());
  }

  [Fact]
  public async Task PremiumRefusesWithoutAMaxChargeBeforeAnyRequest()
  {
    StubHandler handler = Kit.Premium();
    var inner = new FakeInner();
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "100", Price = "200" })));
    Assert.Empty(handler.Requests);
    Assert.Equal(0, inner.Calls);
  }

  [Fact]
  public async Task PremiumNeverCallsTheInnerClientWhenAdmissionIsRefused()
  {
    var handler = new StubHandler(_ => StubHandler.Reply(402, Fixture("errors", "code-premium-balance-exhausted.json") is { } f ? JsonNode.Parse(f)!["body"]!.ToJsonString() : "{}"));
    var inner = new FakeInner();
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAnyAsync<EnlittException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = "1" })));
    Assert.Equal(0, inner.Calls);
    Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("/terminal", StringComparison.Ordinal));
  }

  [Fact]
  public async Task PremiumPerTokenPricingUsesTheInnerUsage()
  {
    StubHandler handler = Kit.Premium(max: "100000");
    var inner = new FakeInner(respond: (_, _) => new ChatResponse(new ChatMessage(ChatRole.Assistant, "ok")) { Usage = new UsageDetails { InputTokenCount = 10, OutputTokenCount = 20 } });
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "100000", Price = EnlittPricing.PerToken("3", "5") }));

    Assert.Equal("130", ReportedCharge(handler));
  }

  [Fact]
  public async Task PremiumAPriceAboveTheEffectiveMaxIsLoweredToIt()
  {
    StubHandler handler = Kit.Premium(max: "50");
    var inner = new FakeInner(respond: (_, _) => new ChatResponse(new ChatMessage(ChatRole.Assistant, "ok")) { Usage = new UsageDetails { InputTokenCount = 1000, OutputTokenCount = 1000 } });
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = EnlittPricing.PerToken("3", "5") }));

    Assert.Equal("50", ReportedCharge(handler));
  }

  [Fact]
  public async Task PremiumABadPriceChargesZeroAndGoesToTheErrorHook()
  {
    StubHandler handler = Kit.Premium();
    var hook = new List<EnlittException>();
    var inner = new FakeInner();
    EnlittOptions options = Kit.PremiumOptions(onReportError: hook.Add) with { Session = new EnlittSession(Kit.SessionToken) };
    using IChatClient client = EnlittChatClient.Premium(inner, options, Kit.Seams(handler));

    ChatResponse response = await client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions
    {
      MaxCharge = "1000",
      Price = EnlittPrice.FromFunction(_ => ValueTask.FromResult("-5")),
    }));

    Assert.Equal("ok", response.Text);
    Assert.Equal("0", ReportedCharge(handler));
    Assert.Single(hook);
  }

  [Fact]
  public async Task PremiumAThrowingInnerClientIsReportedFailedWithZeroAndTheErrorPropagates()
  {
    StubHandler handler = Kit.Premium();
    var inner = new FakeInner(respond: (_, _) => throw new HttpRequestException("provider down"));
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAsync<HttpRequestException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = "400" })));

    Assert.Equal("failed", ReportedStatus(handler));
    Assert.Equal("0", ReportedCharge(handler));
  }

  [Fact]
  public async Task PremiumStreamPassesUpdatesThroughAndReportsOnceWhenItEnds()
  {
    StubHandler handler = Kit.Premium(max: "100000");
    var inner = new FakeInner();
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    var text = new StringBuilder();
    var seen = new List<ChatResponseUpdate>();
    await foreach (ChatResponseUpdate update in client.GetStreamingResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "100000", Price = EnlittPricing.PerToken("3", "5") })))
    {
      seen.Add(update);
      text.Append(update.Text);
    }

    Assert.Equal("Hello", text.ToString());
    Assert.Equal(1, handler.Requests.Count(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)));
    Assert.Equal("completed", ReportedStatus(handler));
    Assert.Equal("130", ReportedCharge(handler));
    Assert.IsType<EnlittPremiumMetadata>(seen[0].AdditionalProperties![EnlittProviderOptions.Key]);
  }

  [Fact]
  public async Task PremiumStreamThatFailsMidwayIsReportedFailedWithZero()
  {
    StubHandler handler = Kit.Premium();
    var inner = new FakeInner(stream: _ => FakeInner.Updates(fail: true));
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAsync<HttpRequestException>(async () =>
    {
      await foreach (ChatResponseUpdate unused in client.GetStreamingResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = "400" })))
      {
        _ = unused;
      }
    });

    Assert.Equal("failed", ReportedStatus(handler));
    Assert.Equal("0", ReportedCharge(handler));
  }

  [Fact]
  public async Task PremiumStreamAbandonedEarlyIsReportedCanceled()
  {
    StubHandler handler = Kit.Premium();
    var inner = new FakeInner();
    using IChatClient client = EnlittChatClient.Premium(inner, Kit.Options(), Kit.Seams(handler));

    await foreach (ChatResponseUpdate unused in client.GetStreamingResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000", Price = "400" })))
    {
      _ = unused;
      break;
    }

    Assert.Equal("canceled", ReportedStatus(handler));
    Assert.Equal(1, handler.Requests.Count(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)));
  }

  [Fact]
  public async Task PremiumNeedsInnerMetadata()
  {
    StubHandler handler = Kit.Premium();
    using IChatClient client = EnlittChatClient.Premium(new NoMetadata(), Kit.Options(), Kit.Seams(handler));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => client.GetResponseAsync(Hello, WithEnlitt(new EnlittProviderOptions { MaxCharge = "1000" })));
    Assert.Empty(handler.Requests);
  }

  private sealed class NoMetadata : IChatClient
  {
    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new InvalidOperationException("must not be called");

    public IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new InvalidOperationException("must not be called");

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }
  }

  [Fact]
  public void PerTokenRejectsNonCanonicalRates()
  {
    Assert.Throws<EnlittConfigurationException>(() => EnlittPricing.PerToken("01", "5"));
    Assert.Throws<EnlittConfigurationException>(() => EnlittPricing.PerToken("1", "-5"));
  }
}
