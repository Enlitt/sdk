using System.Runtime.ExceptionServices;
using Microsoft.Extensions.AI;

namespace Enlitt.Extensions.AI;

/// <summary>
/// Factory for the premium <see cref="IImageGenerator"/>. There is no standard image client: image generation is always
/// the business's own provider, admitted and reported by Enlitt.
/// </summary>
public static class EnlittImageGenerator
{
  /// <summary>
  /// Transparent premium middleware around <paramref name="inner"/>: <see cref="IImageGenerator.GenerateAsync"/> is one premium
  /// operation, admitted by Enlitt before the inner generator runs and followed by exactly one terminal report.
  /// </summary>
  /// <param name="inner">The business's own image generator. It must report <see cref="ImageGeneratorMetadata"/>.</param>
  /// <param name="options">Client options; the secret falls back to <c>ENLITT_SECRET_KEY</c>.</param>
  /// <returns>A <see cref="DelegatingImageGenerator"/>.</returns>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  public static IImageGenerator Premium(IImageGenerator inner, EnlittOptions? options = null) => Premium(inner, options, null);

  /// <summary>Test seam: replaces the HTTP stack.</summary>
  internal static IImageGenerator Premium(IImageGenerator inner, EnlittOptions? options, TransportSeams? seams)
  {
    ArgumentNullException.ThrowIfNull(inner);
    return new PremiumImageGenerator(inner, InternalClient.Create(options, seams));
  }
}

/// <summary>
/// Factory for the premium <see cref="ITextToSpeechClient"/>. There is no standard speech client: speech is always
/// the business's own provider, admitted and reported by Enlitt.
/// </summary>
public static class EnlittTextToSpeechClient
{
  /// <summary>
  /// Transparent premium middleware around <paramref name="inner"/>: <see cref="ITextToSpeechClient.GetAudioAsync"/> is one premium
  /// operation. Streaming audio is not supported through Enlitt and throws <see cref="EnlittConfigurationException"/>.
  /// </summary>
  /// <param name="inner">The business's own speech client. It must report <see cref="TextToSpeechClientMetadata"/>.</param>
  /// <param name="options">Client options; the secret falls back to <c>ENLITT_SECRET_KEY</c>.</param>
  /// <returns>A <see cref="DelegatingTextToSpeechClient"/>.</returns>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  public static ITextToSpeechClient Premium(ITextToSpeechClient inner, EnlittOptions? options = null) => Premium(inner, options, null);

  /// <summary>Test seam: replaces the HTTP stack.</summary>
  internal static ITextToSpeechClient Premium(ITextToSpeechClient inner, EnlittOptions? options, TransportSeams? seams)
  {
    ArgumentNullException.ThrowIfNull(inner);
    return new PremiumTextToSpeechClient(inner, InternalClient.Create(options, seams));
  }
}

/// <summary>
/// Factory for the premium <see cref="ISpeechToTextClient"/>. There is no standard transcription client: transcription is
/// always the business's own provider, admitted and reported by Enlitt.
/// </summary>
public static class EnlittSpeechToTextClient
{
  /// <summary>
  /// Transparent premium middleware around <paramref name="inner"/>: <see cref="ISpeechToTextClient.GetTextAsync"/> is one premium
  /// operation. Streaming transcription is not supported through Enlitt and throws <see cref="EnlittConfigurationException"/>.
  /// </summary>
  /// <param name="inner">The business's own transcription client. It must report <see cref="SpeechToTextClientMetadata"/>.</param>
  /// <param name="options">Client options; the secret falls back to <c>ENLITT_SECRET_KEY</c>.</param>
  /// <returns>A <see cref="DelegatingSpeechToTextClient"/>.</returns>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  public static ISpeechToTextClient Premium(ISpeechToTextClient inner, EnlittOptions? options = null) => Premium(inner, options, null);

  /// <summary>Test seam: replaces the HTTP stack.</summary>
  internal static ISpeechToTextClient Premium(ISpeechToTextClient inner, EnlittOptions? options, TransportSeams? seams)
  {
    ArgumentNullException.ThrowIfNull(inner);
    return new PremiumSpeechToTextClient(inner, InternalClient.Create(options, seams));
  }
}

/// <summary>The premium image middleware: one <c>GenerateAsync</c> is one operation.</summary>
internal sealed class PremiumImageGenerator(IImageGenerator inner, InternalClient client) : DelegatingImageGenerator(inner)
{
  public override Task<ImageGenerationResponse> GenerateAsync(ImageGenerationRequest request, ImageGenerationOptions? options = null, CancellationToken cancellationToken = default)
  {
    ArgumentNullException.ThrowIfNull(request);
    ImageGeneratorMetadata? metadata = InnerGenerator.GetService<ImageGeneratorMetadata>();
    PremiumMediaCall.Prepared prepared = PremiumMediaCall.Prepare(
        options?.AdditionalProperties, options?.ModelId, metadata?.ProviderName, metadata?.DefaultModelId, nameof(ImageGeneratorMetadata));
    ImageGenerationOptions? innerOptions = PremiumMediaCall.WithoutEnlitt(options, o => o.AdditionalProperties, o => o.Clone());

    return PremiumMediaCall.RunAsync(
        client,
        prepared,
        token => base.GenerateAsync(request, innerOptions, token),
        usageOf: response => response.Usage,
        context: outcome => new PremiumMediaPriceContext
        {
          Kind = PremiumMediaKind.Image,
          Status = outcome.Status,
          StartedAt = outcome.StartedAt,
          EndedAt = outcome.EndedAt,
          EffectiveMaxChargeNanoUsd = outcome.EffectiveMaxChargeNanoUsd,
          ImageOptions = innerOptions,
          ImageResponse = outcome.Response,
        },
        annotate: null,
        cancellationToken);
  }
}

/// <summary>The premium text-to-speech middleware: one <c>GetAudioAsync</c> is one operation; streaming is refused.</summary>
internal sealed class PremiumTextToSpeechClient(ITextToSpeechClient inner, InternalClient client) : DelegatingTextToSpeechClient(inner)
{
  public override Task<TextToSpeechResponse> GetAudioAsync(string text, TextToSpeechOptions? options = null, CancellationToken cancellationToken = default)
  {
    ArgumentNullException.ThrowIfNull(text);
    TextToSpeechClientMetadata? metadata = InnerClient.GetService<TextToSpeechClientMetadata>();
    PremiumMediaCall.Prepared prepared = PremiumMediaCall.Prepare(
        options?.AdditionalProperties, options?.ModelId, metadata?.ProviderName, metadata?.DefaultModelId, nameof(TextToSpeechClientMetadata));
    TextToSpeechOptions? innerOptions = PremiumMediaCall.WithoutEnlitt(options, o => o.AdditionalProperties, o => o.Clone());

    return PremiumMediaCall.RunAsync(
        client,
        prepared,
        token => base.GetAudioAsync(text, innerOptions, token),
        usageOf: null,
        context: outcome => new PremiumMediaPriceContext
        {
          Kind = PremiumMediaKind.Speech,
          Status = outcome.Status,
          StartedAt = outcome.StartedAt,
          EndedAt = outcome.EndedAt,
          EffectiveMaxChargeNanoUsd = outcome.EffectiveMaxChargeNanoUsd,
          SpeechOptions = innerOptions,
          Characters = text.EnumerateRunes().Count(),
          SpeechResponse = outcome.Response,
        },
        annotate: (response, metadataEntry) => (response.AdditionalProperties ??= [])[EnlittMediaProviderOptions.Key] = metadataEntry,
        cancellationToken);
  }

  public override IAsyncEnumerable<TextToSpeechResponseUpdate> GetStreamingAudioAsync(string text, TextToSpeechOptions? options = null, CancellationToken cancellationToken = default) =>
      new PremiumMediaCall.UnsupportedStream<TextToSpeechResponseUpdate>("Streaming audio");
}

/// <summary>The premium speech-to-text middleware: one <c>GetTextAsync</c> is one operation; streaming is refused.</summary>
internal sealed class PremiumSpeechToTextClient(ISpeechToTextClient inner, InternalClient client) : DelegatingSpeechToTextClient(inner)
{
  public override Task<SpeechToTextResponse> GetTextAsync(Stream audioSpeechStream, SpeechToTextOptions? options = null, CancellationToken cancellationToken = default)
  {
    ArgumentNullException.ThrowIfNull(audioSpeechStream);
    SpeechToTextClientMetadata? metadata = InnerClient.GetService<SpeechToTextClientMetadata>();
    PremiumMediaCall.Prepared prepared = PremiumMediaCall.Prepare(
        options?.AdditionalProperties, options?.ModelId, metadata?.ProviderName, metadata?.DefaultModelId, nameof(SpeechToTextClientMetadata));
    SpeechToTextOptions? innerOptions = PremiumMediaCall.WithoutEnlitt(options, o => o.AdditionalProperties, o => o.Clone());

    return PremiumMediaCall.RunAsync(
        client,
        prepared,
        token => base.GetTextAsync(audioSpeechStream, innerOptions, token),
        usageOf: null,
        context: outcome => new PremiumMediaPriceContext
        {
          Kind = PremiumMediaKind.Transcription,
          Status = outcome.Status,
          StartedAt = outcome.StartedAt,
          EndedAt = outcome.EndedAt,
          EffectiveMaxChargeNanoUsd = outcome.EffectiveMaxChargeNanoUsd,
          TranscriptionOptions = innerOptions,
          TranscriptionResponse = outcome.Response,
        },
        annotate: (response, metadataEntry) => (response.AdditionalProperties ??= [])[EnlittMediaProviderOptions.Key] = metadataEntry,
        cancellationToken);
  }

  public override IAsyncEnumerable<SpeechToTextResponseUpdate> GetStreamingTextAsync(Stream audioSpeechStream, SpeechToTextOptions? options = null, CancellationToken cancellationToken = default) =>
      new PremiumMediaCall.UnsupportedStream<SpeechToTextResponseUpdate>("Streaming transcription");
}

/// <summary>
/// The premium lifecycle shared by the three media wrappers. A media call is a single non-streaming inner call, so this is
/// the chat wrapper's non-streaming path with a different price context and result mapping.
/// </summary>
internal static class PremiumMediaCall
{
  /// <summary>Everything resolved and validated before any request is sent.</summary>
  internal sealed record Prepared(EnlittMediaProviderOptions Options, PremiumChargeRequest Request);

  /// <summary>What was observed of one inner call, handed to a kind's price-context builder.</summary>
  internal sealed record Outcome<TResponse>(PremiumPriceStatus Status, TResponse? Response, DateTimeOffset StartedAt, DateTimeOffset EndedAt, string EffectiveMaxChargeNanoUsd)
      where TResponse : class;

  /// <summary>The refusal a streaming media call raises on its first <c>MoveNextAsync</c>, before any request is made.</summary>
  internal sealed class UnsupportedStream<T>(string what) : IAsyncEnumerable<T>
  {
    public IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default) => new Enumerator(what);

    private sealed class Enumerator(string what) : IAsyncEnumerator<T>
    {
      public T Current => default!;

      public ValueTask<bool> MoveNextAsync() =>
          throw new EnlittConfigurationException($"{what} is not supported through Enlitt. Use the non-streaming method.");

      public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
  }

  /// <summary>
  /// Reads and validates the call's Enlitt settings and labels, before any request. The labels are the inner service's metadata
  /// provider name and the options' model id, else the metadata's default model id.
  /// </summary>
  /// <exception cref="EnlittConfigurationException">The settings are invalid, or a label is missing.</exception>
  internal static Prepared Prepare(AdditionalPropertiesDictionary? extra, string? optionsModelId, string? providerName, string? defaultModelId, string metadataTypeName)
  {
    var options = new EnlittMediaProviderOptions();
    if (extra is not null && extra.TryGetValue(EnlittMediaProviderOptions.Key, out object? raw) && raw is not null)
    {
      options = raw as EnlittMediaProviderOptions
          ?? throw new EnlittConfigurationException($"AdditionalProperties[\"{EnlittMediaProviderOptions.Key}\"] must be an {nameof(EnlittMediaProviderOptions)}.");
    }

    if (options.IdempotencyKey is { } key)
    {
      CallValidation.IdempotencyKey(key);
    }

    CallValidation.Metadata(options.Metadata);
    string maxCharge = ChatMapping.ValidatePremium(options.MaxCharge, options.Price?.Constant, options.ReportingDeadlineMs);

    string? model = optionsModelId ?? defaultModelId;
    if (string.IsNullOrWhiteSpace(providerName) || string.IsNullOrWhiteSpace(model))
    {
      throw new EnlittConfigurationException(
          $"The inner client must report {metadataTypeName} with ProviderName and DefaultModelId (or the call options must set ModelId) so the premium call can be labelled.");
    }

    var provider = new PremiumProvider(providerName, model);
    CallValidation.Provider(provider);

    // A media call is one provider invocation: the supplied key is the call identity itself, otherwise a fresh random one.
    string callId = options.IdempotencyKey ?? CallValidation.NewId("enl_");
    return new Prepared(options, new PremiumChargeRequest(maxCharge, provider, callId, options.ReportingDeadlineMs, options.Metadata));
  }

  /// <summary>
  /// The options the inner client receives: the caller's options by identity when they carry no <c>enlitt</c> entry, otherwise a
  /// clone without that entry. Every other option passes through untouched.
  /// </summary>
  internal static TOptions? WithoutEnlitt<TOptions>(TOptions? options, Func<TOptions, AdditionalPropertiesDictionary?> properties, Func<TOptions, TOptions> clone)
      where TOptions : class
  {
    if (options is null || properties(options)?.ContainsKey(EnlittMediaProviderOptions.Key) != true)
    {
      return options;
    }

    TOptions copy = clone(options);
    properties(copy)!.Remove(EnlittMediaProviderOptions.Key);
    return copy;
  }

  /// <summary>Runs one inner call inside the premium lifecycle and returns its response by identity.</summary>
  /// <param name="client">The Enlitt client.</param>
  /// <param name="prepared">The validated settings and request.</param>
  /// <param name="invoke">Calls the inner client with the lifecycle's cancellation token.</param>
  /// <param name="usageOf">Reads reportable token usage from a response, or null when the kind has none.</param>
  /// <param name="context">Builds the kind's price context from what was observed.</param>
  /// <param name="annotate">Adds the <c>enlitt</c> metadata to a response, or null when the response type cannot carry it.</param>
  /// <param name="cancellationToken">The caller's token.</param>
  internal static Task<TResponse> RunAsync<TResponse>(
      InternalClient client,
      Prepared prepared,
      Func<CancellationToken, Task<TResponse>> invoke,
      Func<TResponse, UsageDetails?>? usageOf,
      Func<Outcome<TResponse>, PremiumMediaPriceContext> context,
      Action<TResponse, EnlittPremiumMetadata>? annotate,
      CancellationToken cancellationToken)
      where TResponse : class =>
      PremiumLifecycle.RunAsync(client, prepared.Request, async (charge, handle, token) =>
      {
        var started = DateTimeOffset.UtcNow;
        TResponse response;
        try
        {
          response = await invoke(token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
          bool canceled = ex is OperationCanceledException || token.IsCancellationRequested;
          var ended = DateTimeOffset.UtcNow;
          await SettleAsync(client, prepared, charge, handle, context, null, started, ended, usage: null, canceled ? "canceled" : "provider", failed: !canceled).ConfigureAwait(false);
          ExceptionDispatchInfo.Capture(ex).Throw();
          throw;
        }

        await SettleAsync(client, prepared, charge, handle, context, response, started, DateTimeOffset.UtcNow, usageOf?.Invoke(response), errorCategory: null, failed: false).ConfigureAwait(false);
        annotate?.Invoke(response, new EnlittPremiumMetadata(handle.OperationId, handle.EffectiveMaxChargeNanoUsd));
        return response;
      }, cancellationToken);

  /// <summary>
  /// Records the safe facts and, for a completed or canceled call, evaluates the price and passes it to <paramref name="charge"/>.
  /// A failed call is never priced and reports "0". A bad price charges nothing and surfaces only through the report-error hook.
  /// </summary>
  private static async Task SettleAsync<TResponse>(
      InternalClient client,
      Prepared prepared,
      PremiumChargeFunction charge,
      PremiumChargeHandle handle,
      Func<Outcome<TResponse>, PremiumMediaPriceContext> context,
      TResponse? response,
      DateTimeOffset started,
      DateTimeOffset ended,
      UsageDetails? usage,
      string? errorCategory,
      bool failed)
      where TResponse : class
  {
    static int? Clamp(long? value) => value is null ? null : (int)Math.Min(value.Value, int.MaxValue);

    handle.Describe(new PremiumTerminalFacts
    {
      Usage = usage is null ? null : new PremiumUsage { InputTokens = Clamp(usage.InputTokenCount), OutputTokens = Clamp(usage.OutputTokenCount) },
      Timing = new PremiumTiming(started.UtcDateTime.ToString("O"), ended.UtcDateTime.ToString("O")),
      ErrorCategory = errorCategory,
    });

    if (failed || prepared.Options.Price is not { } price)
    {
      return;
    }

    if (price.Constant is { } constant)
    {
      charge(constant);
      return;
    }

    var outcome = new Outcome<TResponse>(response is null ? PremiumPriceStatus.Canceled : PremiumPriceStatus.Completed, response, started, ended, handle.EffectiveMaxChargeNanoUsd);
    try
    {
      string amount = await price.Function!(context(outcome)).ConfigureAwait(false);
      if (!Nano.IsCanonicalCharge(amount))
      {
        throw new EnlittConfigurationException("The price function must return a canonical nonnegative NANOUSD integer string.");
      }

      charge(amount);
    }
    catch (Exception ex)
    {
      charge("0");
      PremiumLifecycle.Notify(client, ex as EnlittConfigurationException ?? new EnlittConfigurationException($"The price function failed: {ex.GetType().Name}: {ex.Message}"));
    }
  }
}
