// The media interfaces are experimental in Microsoft.Extensions.AI (MEAI001); this file exercises them on purpose.
#pragma warning disable MEAI001
using System.Text.Json.Nodes;
using Enlitt.Extensions.AI;
using Microsoft.Extensions.AI;

namespace Enlitt.Tests;

/// <summary>
/// The premium media wrappers (image, speech, transcription) over fake inner clients and the stub Enlitt handler.
/// Mirrors the media cases of <c>premium-media-model.test.ts</c>.
/// </summary>
public class MediaClientTests
{
  private const string SecretText = "top secret sentence";
  private static readonly ImageGenerationRequest ImageRequest = new("a very private prompt");

  /// <summary>The three kinds, so one test body covers them all.</summary>
  public enum Kind
  {
    Image,
    Speech,
    Transcription,
  }

  public static TheoryData<Kind> Kinds => new() { Kind.Image, Kind.Speech, Kind.Transcription };

  // ---- fake inner clients -------------------------------------------------------------------------------------

  /// <summary>Shared scripted behaviour: how a call ends, what it saw, and the metadata it reports.</summary>
  private abstract class FakeBase
  {
    public Func<CancellationToken, Exception?>? Fail { get; init; }

    public string? Provider { get; init; } = "openai";

    public string? Model { get; init; } = "model-1";

    public int Calls { get; protected set; }

    protected void Enter(CancellationToken token)
    {
      Calls++;
      if (Fail?.Invoke(token) is { } error)
      {
        throw error;
      }
    }
  }

  private sealed class FakeImages : FakeBase, IImageGenerator
  {
    public ImageGenerationResponse Response { get; } = new([new DataContent(new byte[] { 1, 2 }, "image/png")])
    {
      Usage = new UsageDetails { InputTokenCount = 7, OutputTokenCount = 9 },
    };

    public ImageGenerationOptions? LastOptions { get; private set; }

    public Task<ImageGenerationResponse> GenerateAsync(ImageGenerationRequest request, ImageGenerationOptions? options = null, CancellationToken cancellationToken = default)
    {
      LastOptions = options;
      Enter(cancellationToken);
      return Task.FromResult(Response);
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType == typeof(ImageGeneratorMetadata) && Provider is not null ? new ImageGeneratorMetadata(Provider, null, Model) : null;

    public void Dispose()
    {
    }
  }

  private sealed class FakeSpeech : FakeBase, ITextToSpeechClient
  {
    public TextToSpeechResponse Response { get; } = new([new DataContent(new byte[] { 3 }, "audio/mpeg")]);

    public TextToSpeechOptions? LastOptions { get; private set; }

    public Task<TextToSpeechResponse> GetAudioAsync(string text, TextToSpeechOptions? options = null, CancellationToken cancellationToken = default)
    {
      LastOptions = options;
      Enter(cancellationToken);
      return Task.FromResult(Response);
    }

    public IAsyncEnumerable<TextToSpeechResponseUpdate> GetStreamingAudioAsync(string text, TextToSpeechOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new InvalidOperationException("The inner client must not be reached.");

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType == typeof(TextToSpeechClientMetadata) && Provider is not null ? new TextToSpeechClientMetadata(Provider, null, Model) : null;

    public void Dispose()
    {
    }
  }

  private sealed class FakeTranscriber : FakeBase, ISpeechToTextClient
  {
    public SpeechToTextResponse Response { get; } = new(SecretText);

    public SpeechToTextOptions? LastOptions { get; private set; }

    public Task<SpeechToTextResponse> GetTextAsync(Stream audioSpeechStream, SpeechToTextOptions? options = null, CancellationToken cancellationToken = default)
    {
      LastOptions = options;
      Enter(cancellationToken);
      return Task.FromResult(Response);
    }

    public IAsyncEnumerable<SpeechToTextResponseUpdate> GetStreamingTextAsync(Stream audioSpeechStream, SpeechToTextOptions? options = null, CancellationToken cancellationToken = default) =>
        throw new InvalidOperationException("The inner client must not be reached.");

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType == typeof(SpeechToTextClientMetadata) && Provider is not null ? new SpeechToTextClientMetadata(Provider, null, Model) : null;

    public void Dispose()
    {
    }
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  private static AdditionalPropertiesDictionary WithEnlitt(object? value) => new() { [EnlittMediaProviderOptions.Key] = value! };

  private static string ReportedCharge(StubHandler handler) =>
      handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Json()["charge_nano_usd"]!.GetValue<string>();

  private static string? ReportedErrorCategory(StubHandler handler) =>
      handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Json()["error_category"]?.GetValue<string>();

  private static string ReportedStatus(StubHandler handler) =>
      handler.Requests.Last(r => r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Json()["status"]!.GetValue<string>();

  /// <summary>One wrapped call of any kind; <paramref name="fail"/> scripts how the inner call ends.</summary>
  private sealed class Rig
  {
    public required StubHandler Handler { get; init; }

    public required Func<EnlittMediaProviderOptions?, CancellationToken, Task<object>> Call { get; init; }

    public required Func<int> InnerCalls { get; init; }

    public required Func<object?> InnerOptions { get; init; }

    public required object InnerResponse { get; init; }
  }

  private static Rig Build(Kind kind, StubHandler handler, Func<CancellationToken, Exception?>? fail = null, string? provider = "openai", string? model = "model-1")
  {
    EnlittOptions options = Kit.Options();
    TransportSeams seams = Kit.Seams(handler);
    switch (kind)
    {
      case Kind.Image:
        var images = new FakeImages { Fail = fail, Provider = provider, Model = model };
        IImageGenerator generator = EnlittImageGenerator.Premium(images, options, seams);
        return new Rig
        {
          Handler = handler,
          InnerCalls = () => images.Calls,
          InnerOptions = () => images.LastOptions,
          InnerResponse = images.Response,
          Call = async (enlitt, token) => await generator.GenerateAsync(ImageRequest, new ImageGenerationOptions { Count = 2, AdditionalProperties = WithEnlitt(enlitt) }, token),
        };
      case Kind.Speech:
        var speech = new FakeSpeech { Fail = fail, Provider = provider, Model = model };
        ITextToSpeechClient tts = EnlittTextToSpeechClient.Premium(speech, options, seams);
        return new Rig
        {
          Handler = handler,
          InnerCalls = () => speech.Calls,
          InnerOptions = () => speech.LastOptions,
          InnerResponse = speech.Response,
          Call = async (enlitt, token) => await tts.GetAudioAsync(SecretText, new TextToSpeechOptions { VoiceId = "alloy", AdditionalProperties = WithEnlitt(enlitt) }, token),
        };
      default:
        var transcriber = new FakeTranscriber { Fail = fail, Provider = provider, Model = model };
        ISpeechToTextClient stt = EnlittSpeechToTextClient.Premium(transcriber, options, seams);
        return new Rig
        {
          Handler = handler,
          InnerCalls = () => transcriber.Calls,
          InnerOptions = () => transcriber.LastOptions,
          InnerResponse = transcriber.Response,
          Call = async (enlitt, token) => await stt.GetTextAsync(new MemoryStream([9, 9]), new SpeechToTextOptions { SpeechLanguage = "en", AdditionalProperties = WithEnlitt(enlitt) }, token),
        };
    }
  }

  private static AdditionalPropertiesDictionary? PropertiesOf(object? options) => options switch
  {
    ImageGenerationOptions o => o.AdditionalProperties,
    TextToSpeechOptions o => o.AdditionalProperties,
    SpeechToTextOptions o => o.AdditionalProperties,
    _ => null,
  };

  // ---- admission, refusals, bodies ----------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task AdmitsBeforeTheInnerCallAndReportsTheConstantPrice(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium());

    object response = await rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = "400" }, default);

    Assert.Equal(1, rig.InnerCalls());
    Assert.EndsWith("/terminal", rig.Handler.Requests[^1].Path, StringComparison.Ordinal);
    Assert.DoesNotContain("/terminal", rig.Handler.Requests[0].Path, StringComparison.Ordinal);
    Assert.Equal("completed", ReportedStatus(rig.Handler));
    Assert.Equal("400", ReportedCharge(rig.Handler));
    Assert.Same(rig.InnerResponse, response);
  }

  [Fact]
  public async Task AValueOfAnotherTypeUnderTheKeyIsRefused()
  {
    StubHandler handler = Kit.Premium();
    IImageGenerator generator = EnlittImageGenerator.Premium(new FakeImages(), Kit.Options(), Kit.Seams(handler));

    await Assert.ThrowsAsync<EnlittConfigurationException>(() =>
        generator.GenerateAsync(ImageRequest, new ImageGenerationOptions { AdditionalProperties = WithEnlitt(new EnlittProviderOptions { MaxCharge = "100" }) }));

    Assert.Empty(handler.Requests);
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task AMissingLabelMakesNoRequestAndNoInnerCall(Kind kind)
  {
    foreach ((string? provider, string? model) in new (string?, string?)[] { (null, "m"), ("openai", null) })
    {
      Rig rig = Build(kind, Kit.Premium(), provider: provider, model: model);
      await Assert.ThrowsAsync<EnlittConfigurationException>(() => rig.Call(new EnlittMediaProviderOptions { MaxCharge = "100" }, default));
      Assert.Empty(rig.Handler.Requests);
      Assert.Equal(0, rig.InnerCalls());
    }
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task RefusedSettingsMakeNoRequest(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium());

    await Assert.ThrowsAsync<EnlittConfigurationException>(() => rig.Call(null, default));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => rig.Call(new EnlittMediaProviderOptions { MaxCharge = "100", Price = "200" }, default));
    await Assert.ThrowsAsync<EnlittConfigurationException>(() => rig.Call(new EnlittMediaProviderOptions { MaxCharge = "100", IdempotencyKey = "short" }, default));

    Assert.Empty(rig.Handler.Requests);
    Assert.Equal(0, rig.InnerCalls());
  }

  [Fact]
  public async Task StreamingCallsThrowOnTheFirstMoveNextWithoutAnyRequest()
  {
    var handler = Kit.Premium();
    var speech = new FakeSpeech();
    var transcriber = new FakeTranscriber();
    ITextToSpeechClient tts = EnlittTextToSpeechClient.Premium(speech, Kit.Options(), Kit.Seams(handler));
    ISpeechToTextClient stt = EnlittSpeechToTextClient.Premium(transcriber, Kit.Options(), Kit.Seams(handler));

    await using IAsyncEnumerator<TextToSpeechResponseUpdate> audio = tts.GetStreamingAudioAsync("hi").GetAsyncEnumerator();
    await Assert.ThrowsAsync<EnlittConfigurationException>(async () => await audio.MoveNextAsync());
    await using IAsyncEnumerator<SpeechToTextResponseUpdate> text = stt.GetStreamingTextAsync(new MemoryStream()).GetAsyncEnumerator();
    await Assert.ThrowsAsync<EnlittConfigurationException>(async () => await text.MoveNextAsync());

    Assert.Empty(handler.Requests);
    Assert.Equal(0, speech.Calls + transcriber.Calls);
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task AdmissionRefusalNeverReachesTheInnerClient(Kind kind)
  {
    var handler = new StubHandler(_ => StubHandler.Reply(402, """{"error":{"code":"premium_balance_exhausted","message":"no","type":"payment_error"}}"""));
    Rig rig = Build(kind, handler);

    await Assert.ThrowsAnyAsync<EnlittException>(() => rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = "1" }, default));

    Assert.Equal(0, rig.InnerCalls());
    Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("/terminal", StringComparison.Ordinal));
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task BeginAndReportBodiesCarryLabelsAndNoContent(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium());

    await rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = "400" }, default);

    JsonObject begin = rig.Handler.Requests[0].Json();
    Assert.Equal("openai", begin["provider"]!["id"]!.GetValue<string>());
    Assert.Equal("model-1", begin["provider"]!["model"]!.GetValue<string>());
    foreach (RecordedRequest request in rig.Handler.Requests)
    {
      Assert.DoesNotContain("private prompt", request.Body, StringComparison.Ordinal);
      Assert.DoesNotContain(SecretText, request.Body, StringComparison.Ordinal);
      Assert.DoesNotContain("alloy", request.Body, StringComparison.Ordinal);
      Assert.DoesNotContain("AQI", request.Body, StringComparison.Ordinal); // base64 of the image bytes
    }

    Assert.NotNull(rig.Handler.Requests[^1].Json()["timing"]);
  }

  [Fact]
  public async Task AnImageReportCarriesTokenUsageAndModelIdOverridesTheDefault()
  {
    StubHandler handler = Kit.Premium();
    var images = new FakeImages();
    IImageGenerator generator = EnlittImageGenerator.Premium(images, Kit.Options(), Kit.Seams(handler));

    await generator.GenerateAsync(
        ImageRequest,
        new ImageGenerationOptions { ModelId = "other-model", AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions { MaxCharge = "1000" }) });

    Assert.Equal("other-model", handler.Requests[0].Json()["provider"]!["model"]!.GetValue<string>());
    JsonNode report = handler.Requests[^1].Json();
    Assert.Equal(7, report["usage"]!["input_tokens"]!.GetValue<int>());
    Assert.Equal(9, report["usage"]!["output_tokens"]!.GetValue<int>());
  }

  // ---- status and price ---------------------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task CompletedChargesTheFunctionResultLoweredToTheEffectiveMaximum(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium(max: "500"));

    await rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(_ => ValueTask.FromResult("9000")) }, default);

    Assert.Equal("completed", ReportedStatus(rig.Handler));
    Assert.Equal("500", ReportedCharge(rig.Handler));
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task CanceledEvaluatesThePriceWithNoResponseAndRethrows(Kind kind)
  {
    using var cts = new CancellationTokenSource();
    Rig rig = Build(kind, Kit.Premium(), fail: token => { cts.Cancel(); return new OperationCanceledException(token); });
    PremiumMediaPriceContext? seen = null;

    await Assert.ThrowsAnyAsync<OperationCanceledException>(() => rig.Call(
        new EnlittMediaProviderOptions
        {
          MaxCharge = "1000",
          Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(c => { seen = c; return ValueTask.FromResult("123"); }),
        },
        cts.Token));

    Assert.Equal("canceled", ReportedStatus(rig.Handler));
    Assert.Equal("123", ReportedCharge(rig.Handler));
    Assert.Equal(PremiumPriceStatus.Canceled, seen!.Status);
    Assert.Null(seen.ImageResponse);
    Assert.Null(seen.SpeechResponse);
    Assert.Null(seen.TranscriptionResponse);
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task AnyExceptionWhileTheTokenIsCanceledIsCanceled(Kind kind)
  {
    using var cts = new CancellationTokenSource();
    Rig rig = Build(kind, Kit.Premium(), fail: _ => { cts.Cancel(); return new InvalidOperationException("boom"); });

    await Assert.ThrowsAsync<InvalidOperationException>(() => rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = "5" }, cts.Token));

    Assert.Equal("canceled", ReportedStatus(rig.Handler));
  }

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task FailedChargesZeroNeverPricesAndRethrowsTheSameException(Kind kind)
  {
    var error = new HttpRequestException("provider down");
    Rig rig = Build(kind, Kit.Premium(), fail: _ => error);
    bool priced = false;

    HttpRequestException thrown = await Assert.ThrowsAsync<HttpRequestException>(() => rig.Call(
        new EnlittMediaProviderOptions
        {
          MaxCharge = "1000",
          Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(_ => { priced = true; return ValueTask.FromResult("1"); }),
        },
        default));

    Assert.Same(error, thrown);
    Assert.False(priced);
    Assert.Equal("failed", ReportedStatus(rig.Handler));
    Assert.Equal("0", ReportedCharge(rig.Handler));
    // As in TypeScript, a failed media call is always categorized "provider", even for a network error.
    Assert.Equal("provider", ReportedErrorCategory(rig.Handler));
  }

  [Fact]
  public async Task ABadPriceChargesNothingAndDoesNotChangeTheResult()
  {
    var seen = new List<EnlittException>();
    EnlittOptions options = new() { SecretKey = Kit.Secret, BaseUrl = Kit.BaseUrl, Session = new EnlittSession(Kit.SessionToken), OnTerminalReportError = seen.Add };
    StubHandler handler = Kit.Premium();
    var images = new FakeImages();
    IImageGenerator generator = EnlittImageGenerator.Premium(images, options, Kit.Seams(handler));

    ImageGenerationResponse response = await generator.GenerateAsync(
        ImageRequest,
        new ImageGenerationOptions
        {
          AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions
          {
            MaxCharge = "1000",
            Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(_ => ValueTask.FromResult("-1")),
          }),
        });

    Assert.Same(images.Response, response);
    Assert.Equal("0", ReportedCharge(handler));
    Assert.IsType<EnlittConfigurationException>(Assert.Single(seen));
  }

  // ---- price context ------------------------------------------------------------------------------------------

  [Fact]
  public async Task TheImagePriceContextCarriesTheInnerOptionsAndResponse()
  {
    var images = new FakeImages();
    PremiumMediaPriceContext? seen = null;
    IImageGenerator generator = EnlittImageGenerator.Premium(images, Kit.Options(), Kit.Seams(Kit.Premium(max: "800")));

    await generator.GenerateAsync(
        ImageRequest,
        new ImageGenerationOptions
        {
          Count = 3,
          AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions
          {
            MaxCharge = "1000",
            Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(c => { seen = c; return ValueTask.FromResult("1"); }),
          }),
        });

    Assert.Equal(PremiumMediaKind.Image, seen!.Kind);
    Assert.Equal(PremiumPriceStatus.Completed, seen.Status);
    Assert.Same(images.LastOptions, seen.ImageOptions);
    Assert.Equal(3, seen.ImageOptions!.Count);
    Assert.Same(images.Response, seen.ImageResponse);
    Assert.Equal("800", seen.EffectiveMaxChargeNanoUsd);
    Assert.True(seen.EndedAt >= seen.StartedAt);
    Assert.Equal(seen.EndedAt - seen.StartedAt, seen.Duration);
    Assert.Null(seen.SpeechOptions);
    Assert.Null(seen.Characters);
    Assert.Null(seen.TranscriptionOptions);
  }

  [Fact]
  public async Task TheSpeechPriceContextCountsCodePointsNotUtf16Units()
  {
    var speech = new FakeSpeech();
    PremiumMediaPriceContext? seen = null;
    ITextToSpeechClient client = EnlittTextToSpeechClient.Premium(speech, Kit.Options(), Kit.Seams(Kit.Premium()));

    // Two letters and one emoji: three code points, four UTF-16 units.
    await client.GetAudioAsync(
        "a😀b",
        new TextToSpeechOptions
        {
          VoiceId = "alloy",
          AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions
          {
            MaxCharge = "1000",
            Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(c => { seen = c; return ValueTask.FromResult("1"); }),
          }),
        });

    Assert.Equal(PremiumMediaKind.Speech, seen!.Kind);
    Assert.Equal(3, seen.Characters);
    Assert.Equal("alloy", seen.SpeechOptions!.VoiceId);
    Assert.Same(speech.Response, seen.SpeechResponse);
    Assert.Null(seen.ImageOptions);
    Assert.Null(seen.TranscriptionOptions);
  }

  [Fact]
  public async Task TheTranscriptionPriceContextCarriesTheInnerOptionsAndResponse()
  {
    var transcriber = new FakeTranscriber();
    PremiumMediaPriceContext? seen = null;
    ISpeechToTextClient client = EnlittSpeechToTextClient.Premium(transcriber, Kit.Options(), Kit.Seams(Kit.Premium()));

    await client.GetTextAsync(
        new MemoryStream([1]),
        new SpeechToTextOptions
        {
          SpeechLanguage = "fr",
          AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions
          {
            MaxCharge = "1000",
            Price = (Func<PremiumMediaPriceContext, ValueTask<string>>)(c => { seen = c; return ValueTask.FromResult("1"); }),
          }),
        });

    Assert.Equal(PremiumMediaKind.Transcription, seen!.Kind);
    Assert.Equal("fr", seen.TranscriptionOptions!.SpeechLanguage);
    Assert.Same(transcriber.Response, seen.TranscriptionResponse);
    Assert.Null(seen.ImageOptions);
    Assert.Null(seen.Characters);
  }

  // ---- options passed to the inner client ---------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task TheInnerClientGetsACloneWithoutTheEnlittEntryAndEverythingElseUntouched(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium());

    await rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", Price = "1" }, default);

    object? inner = rig.InnerOptions();
    Assert.NotNull(inner);
    Assert.False(PropertiesOf(inner)?.ContainsKey(EnlittMediaProviderOptions.Key) ?? false);
    switch (inner)
    {
      case ImageGenerationOptions image:
        Assert.Equal(2, image.Count);
        break;
      case TextToSpeechOptions speech:
        Assert.Equal("alloy", speech.VoiceId);
        break;
      case SpeechToTextOptions text:
        Assert.Equal("en", text.SpeechLanguage);
        break;
    }
  }

  [Fact]
  public async Task TheCallersOwnOptionsKeepTheirEnlittEntry()
  {
    var images = new FakeImages();
    IImageGenerator generator = EnlittImageGenerator.Premium(images, Kit.Options(), Kit.Seams(Kit.Premium()));
    var options = new ImageGenerationOptions { AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions { MaxCharge = "1000" }) };

    await generator.GenerateAsync(ImageRequest, options);

    Assert.True(options.AdditionalProperties!.ContainsKey(EnlittMediaProviderOptions.Key));
    Assert.NotSame(options, images.LastOptions);
  }

  // ---- call identity ------------------------------------------------------------------------------------------

  [Theory]
  [MemberData(nameof(Kinds))]
  public async Task ASuppliedKeyIsTheCallIdUnchangedAndOtherwiseEachCallGetsAFreshOne(Kind kind)
  {
    Rig rig = Build(kind, Kit.Premium());
    const string key = "media-key-0000001";

    await rig.Call(new EnlittMediaProviderOptions { MaxCharge = "1000", IdempotencyKey = key }, default);
    Assert.Equal(key, rig.Handler.Requests[0].Header("Idempotency-Key"));

    Rig fresh = Build(kind, Kit.Premium());
    await fresh.Call(new EnlittMediaProviderOptions { MaxCharge = "1000" }, default);
    await fresh.Call(new EnlittMediaProviderOptions { MaxCharge = "1000" }, default);
    string?[] ids = [.. fresh.Handler.Requests.Where(r => !r.Path.EndsWith("/terminal", StringComparison.Ordinal)).Select(r => r.Header("Idempotency-Key"))];
    Assert.Equal(2, ids.Length);
    Assert.NotEqual(ids[0], ids[1]);
    Assert.All(ids, id => Assert.True(id!.Length >= 16));
  }

  // ---- result mapping -----------------------------------------------------------------------------------------

  [Fact]
  public async Task AnImageResponseIsReturnedByIdentityWithNothingAdded()
  {
    var images = new FakeImages();
    IImageGenerator generator = EnlittImageGenerator.Premium(images, Kit.Options(), Kit.Seams(Kit.Premium()));

    ImageGenerationResponse response = await generator.GenerateAsync(
        ImageRequest, new ImageGenerationOptions { AdditionalProperties = WithEnlitt(new EnlittMediaProviderOptions { MaxCharge = "1000" }) });

    Assert.Same(images.Response, response);
    Assert.Single(response.Contents);
  }

  [Fact]
  public async Task SpeechAndTranscriptionResponsesGetTheEnlittMetadataEntry()
  {
    var speech = new FakeSpeech();
    var transcriber = new FakeTranscriber();
    var settings = new EnlittMediaProviderOptions { MaxCharge = "1000" };

    TextToSpeechResponse audio = await EnlittTextToSpeechClient.Premium(speech, Kit.Options(), Kit.Seams(Kit.Premium()))
        .GetAudioAsync("hello", new TextToSpeechOptions { AdditionalProperties = WithEnlitt(settings) });
    SpeechToTextResponse text = await EnlittSpeechToTextClient.Premium(transcriber, Kit.Options(), Kit.Seams(Kit.Premium()))
        .GetTextAsync(new MemoryStream([1]), new SpeechToTextOptions { AdditionalProperties = WithEnlitt(settings) });

    Assert.Same(speech.Response, audio);
    Assert.Same(transcriber.Response, text);
    foreach (AdditionalPropertiesDictionary? properties in new[] { audio.AdditionalProperties, text.AdditionalProperties })
    {
      var metadata = Assert.IsType<EnlittPremiumMetadata>(properties![EnlittMediaProviderOptions.Key]);
      Assert.Equal("op_1", metadata.OperationId);
      Assert.Equal("1000", metadata.EffectiveMaxChargeNanoUsd);
    }
  }
}
