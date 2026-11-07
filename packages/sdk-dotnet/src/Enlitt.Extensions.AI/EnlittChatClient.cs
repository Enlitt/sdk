using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using Microsoft.Extensions.AI;

namespace Enlitt.Extensions.AI;

/// <summary>Factory for the Enlitt <see cref="IChatClient"/> adapters.</summary>
public static class EnlittChatClient
{
  /// <summary>Enlitt's own standard model (<c>enlitt-standard</c>). Both the business secret and a personal session are required for every call.</summary>
  /// <param name="options">Client options; the secret falls back to <c>ENLITT_SECRET_KEY</c>.</param>
  /// <returns>The chat client.</returns>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  public static IChatClient Standard(EnlittOptions? options = null) => Standard(options, null);

  /// <summary>
  /// Transparent premium middleware around <paramref name="inner"/>: every call is admitted by Enlitt before the inner client runs,
  /// and exactly one terminal report follows. There is no path that invokes <paramref name="inner"/> without admission.
  /// </summary>
  /// <param name="inner">The business's own provider client.</param>
  /// <param name="options">Client options; the secret falls back to <c>ENLITT_SECRET_KEY</c>.</param>
  /// <returns>A <see cref="DelegatingChatClient"/>.</returns>
  /// <exception cref="EnlittConfigurationException">The secret or base URL is missing or invalid.</exception>
  public static IChatClient Premium(IChatClient inner, EnlittOptions? options = null) => Premium(inner, options, null);

  /// <summary>Test seam: replaces the HTTP stack.</summary>
  internal static IChatClient Standard(EnlittOptions? options, TransportSeams? seams) =>
      new StandardChatClient(InternalClient.Create(options, seams));

  /// <summary>Test seam: replaces the HTTP stack.</summary>
  internal static IChatClient Premium(IChatClient inner, EnlittOptions? options, TransportSeams? seams)
  {
    ArgumentNullException.ThrowIfNull(inner);
    return new PremiumChatClient(inner, InternalClient.Create(options, seams));
  }
}

/// <summary>The standard-route chat client.</summary>
internal sealed class StandardChatClient(InternalClient client) : IChatClient
{
  private static readonly ChatClientMetadata Metadata = new("enlitt", null, EnlittConstants.StandardModel);

  public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
  {
    (StdRequest request, string callId) = Prepare(messages, options, stream: false);
    StdResult result = await StandardClient.GenerateAsync(client, request, callId, cancellationToken).ConfigureAwait(false);
    return ChatMapping.ToResponse(result);
  }

  public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
      IEnumerable<ChatMessage> messages,
      ChatOptions? options = null,
      [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    (StdRequest request, string callId) = Prepare(messages, options, stream: true);
    await foreach (StdStreamPart part in StandardClient.StreamAsync(client, request, callId, cancellationToken).WithCancellation(cancellationToken).ConfigureAwait(false))
    {
      yield return ChatMapping.ToUpdate(part);
    }
  }

  public object? GetService(Type serviceType, object? serviceKey = null)
  {
    ArgumentNullException.ThrowIfNull(serviceType);
    return serviceKey is null && serviceType.IsInstanceOfType(Metadata) ? Metadata
        : serviceKey is null && serviceType.IsInstanceOfType(this) ? this
        : null;
  }

  public void Dispose()
  {
  }

  private static (StdRequest Request, string CallId) Prepare(IEnumerable<ChatMessage> messages, ChatOptions? options, bool stream)
  {
    ArgumentNullException.ThrowIfNull(messages);
    List<ChatMessage> list = [.. messages];
    (EnlittProviderOptions providerOptions, _) = ChatMapping.ReadProviderOptions(options, premium: false);
    return (ChatMapping.ToRequest(list, options, providerOptions, stream), ChatMapping.CallId(providerOptions, list.Count));
  }
}

/// <summary>What was observed of one inner call; shared between the iterator and the price evaluation.</summary>
internal sealed class CallTrace
{
  internal DateTimeOffset StartedAt { get; init; }

  internal DateTimeOffset EndedAt { get; set; }

  internal DateTimeOffset? FirstContentAt { get; set; }

  internal List<AIContent> Content { get; } = [];

  internal List<ChatResponseUpdate>? Updates { get; init; }

  internal UsageDetails? Usage { get; set; }

  internal ChatFinishReason? Finish { get; set; }

  internal string? ResponseId { get; set; }

  internal bool SawError { get; set; }

  internal bool Completed { get; set; }

  internal Exception? Failure { get; set; }
}

/// <summary>The premium middleware: one inner call is one operation.</summary>
internal sealed class PremiumChatClient(IChatClient inner, InternalClient client) : DelegatingChatClient(inner)
{
  /// <summary>Everything resolved and validated before any request is sent.</summary>
  private sealed record Prepared(List<ChatMessage> Messages, ChatOptions? InnerOptions, EnlittProviderOptions Options, PremiumChargeRequest Request, bool PriceIsFunction);

  public override async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
  {
    Prepared p = Prepare(messages, options);
    return await PremiumLifecycle.RunAsync(client, p.Request, async (charge, handle, token) =>
    {
      var started = DateTimeOffset.UtcNow;
      ChatResponse response;
      try
      {
        response = await base.GetResponseAsync(p.Messages, p.InnerOptions, token).ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        var trace = new CallTrace { StartedAt = started, EndedAt = DateTimeOffset.UtcNow, Failure = ex };
        await SettleAsync(p, charge, handle, trace, canceled: ex is OperationCanceledException || token.IsCancellationRequested).ConfigureAwait(false);
        ExceptionDispatchInfo.Capture(ex).Throw();
        throw;
      }

      var done = new CallTrace { StartedAt = started, EndedAt = DateTimeOffset.UtcNow, Usage = response.Usage, Finish = response.FinishReason, ResponseId = response.ResponseId, Completed = true };
      done.Content.AddRange(response.Messages.SelectMany(m => m.Contents));
      done.SawError = false;
      await SettleAsync(p, charge, handle, done, canceled: false).ConfigureAwait(false);

      (response.AdditionalProperties ??= [])[EnlittProviderOptions.Key] = new EnlittPremiumMetadata(handle.OperationId, handle.EffectiveMaxChargeNanoUsd);
      return response;
    }, cancellationToken).ConfigureAwait(false);
  }

  public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
      IEnumerable<ChatMessage> messages,
      ChatOptions? options = null,
      [EnumeratorCancellation] CancellationToken cancellationToken = default)
  {
    Prepared p = Prepare(messages, options);

    // The lifecycle runs as a task: its run delegate signals admission, then waits for the stream to end.
    var admitted = new TaskCompletionSource<PremiumChargeHandle>(TaskCreationOptions.RunContinuationsAsynchronously);
    var ended = new TaskCompletionSource<(CallTrace Trace, bool Canceled)>(TaskCreationOptions.RunContinuationsAsynchronously);
    Task lifecycle = PremiumLifecycle.RunAsync<object?>(client, p.Request, async (charge, handle, token) =>
    {
      admitted.TrySetResult(handle);
      (CallTrace trace, bool canceled) = await ended.Task.ConfigureAwait(false);
      await SettleAsync(p, charge, handle, trace, canceled).ConfigureAwait(false);
      if (canceled)
      {
        throw new OperationCanceledException(token);
      }

      return trace.Failure is null && !trace.SawError ? null : throw new StreamFailedException();
    }, cancellationToken);

    // A begin refusal rejects the first MoveNext, before the inner client is invoked.
    if (await Task.WhenAny(admitted.Task, lifecycle).ConfigureAwait(false) != admitted.Task)
    {
      await lifecycle.ConfigureAwait(false);
    }

    PremiumChargeHandle operation = await admitted.Task.ConfigureAwait(false);
    var trace = new CallTrace { StartedAt = DateTimeOffset.UtcNow, Updates = p.PriceIsFunction ? [] : null };
    bool finished = false;
    Exception? error = null;
    IAsyncEnumerator<ChatResponseUpdate>? source = null;
    try
    {
      try
      {
        source = base.GetStreamingResponseAsync(p.Messages, p.InnerOptions, cancellationToken).GetAsyncEnumerator(cancellationToken);
      }
      catch (Exception ex)
      {
        error = ex;
        trace.Failure = ex;
        finished = true;
      }

      bool first = true;
      while (source is not null)
      {
        ChatResponseUpdate update;
        try
        {
          if (!await source.MoveNextAsync().ConfigureAwait(false))
          {
            trace.Completed = true;
            finished = true;
            break;
          }

          update = source.Current;
        }
        catch (Exception ex)
        {
          error = ex;
          trace.Failure = ex;
          finished = true;
          break;
        }

        Observe(trace, update, p.PriceIsFunction);
        if (first)
        {
          (update.AdditionalProperties ??= [])[EnlittProviderOptions.Key] = new EnlittPremiumMetadata(operation.OperationId, operation.EffectiveMaxChargeNanoUsd);
          first = false;
        }

        yield return update;
      }
    }
    finally
    {
      // Reached on a natural end, a source error, and a consumer that stops early (then finished is false).
      trace.EndedAt = DateTimeOffset.UtcNow;
      if (source is not null)
      {
        await source.DisposeAsync().ConfigureAwait(false);
      }

      bool canceled = !finished || error is OperationCanceledException || (error is not null && cancellationToken.IsCancellationRequested);
      ended.TrySetResult((trace, canceled));
      try
      {
        await lifecycle.ConfigureAwait(false);
      }
      catch (Exception)
      {
        // The lifecycle rethrows what the run delegate threw; the stream's own outcome was already delivered to the consumer.
      }
    }

    if (error is not null)
    {
      ExceptionDispatchInfo.Capture(error).Throw();
    }
  }

  /// <summary>Marks a failed stream (an error was delivered or thrown) so the lifecycle reports <c>failed</c>.</summary>
  private sealed class StreamFailedException : Exception;

  private static void Observe(CallTrace trace, ChatResponseUpdate update, bool collect)
  {
    trace.Updates?.Add(update);
    trace.ResponseId ??= update.ResponseId;
    if (update.FinishReason is { } finish)
    {
      trace.Finish = finish;
    }

    foreach (AIContent content in update.Contents)
    {
      switch (content)
      {
        case UsageContent usage:
          trace.Usage = usage.Details;
          break;
        case ErrorContent:
          trace.SawError = true;
          break;
        default:
          trace.FirstContentAt ??= DateTimeOffset.UtcNow;
          break;
      }

      if (collect)
      {
        trace.Content.Add(content);
      }
    }
  }

  private Prepared Prepare(IEnumerable<ChatMessage> messages, ChatOptions? options)
  {
    ArgumentNullException.ThrowIfNull(messages);
    List<ChatMessage> list = [.. messages];
    (EnlittProviderOptions providerOptions, string? maxCharge) = ChatMapping.ReadProviderOptions(options, premium: true);

    ChatClientMetadata? metadata = InnerClient.GetService<ChatClientMetadata>();
    string? model = options?.ModelId ?? metadata?.DefaultModelId;
    if (string.IsNullOrWhiteSpace(metadata?.ProviderName) || string.IsNullOrWhiteSpace(model))
    {
      throw new EnlittConfigurationException(
          "The inner chat client must report ChatClientMetadata with ProviderName and DefaultModelId (or ChatOptions.ModelId must be set) so the premium call can be labelled.");
    }

    var provider = new PremiumProvider(metadata.ProviderName, model);
    CallValidation.Provider(provider);

    // The inner client never sees the Enlitt settings; every other option passes through untouched.
    ChatOptions? innerOptions = options;
    if (options?.AdditionalProperties?.ContainsKey(EnlittProviderOptions.Key) == true)
    {
      innerOptions = options.Clone();
      innerOptions.AdditionalProperties!.Remove(EnlittProviderOptions.Key);
    }

    var request = new PremiumChargeRequest(maxCharge!, provider, ChatMapping.CallId(providerOptions, list.Count), providerOptions.ReportingDeadlineMs, providerOptions.Metadata);
    return new Prepared(list, innerOptions, providerOptions, request, providerOptions.Price?.Function is not null);
  }

  /// <summary>
  /// Records the safe facts and, for a completed or canceled call, evaluates the price and passes it to <paramref name="charge"/>.
  /// A failed call is never priced and reports "0".
  /// </summary>
  private async Task SettleAsync(Prepared p, PremiumChargeFunction charge, PremiumChargeHandle handle, CallTrace trace, bool canceled)
  {
    bool failed = !canceled && (trace.Failure is not null || trace.SawError);
    handle.Describe(Facts(trace, canceled, failed));
    if (failed || p.Options.Price is not { } price)
    {
      return;
    }

    if (price.Constant is { } constant)
    {
      charge(constant);
      return;
    }

    var context = new PremiumPriceContext
    {
      Status = canceled ? PremiumPriceStatus.Canceled : PremiumPriceStatus.Completed,
      Content = trace.Content,
      Updates = trace.Updates,
      Usage = trace.Usage,
      FinishReason = trace.Finish,
      StartedAt = trace.StartedAt,
      EndedAt = trace.EndedAt,
      TimeToFirstToken = trace.FirstContentAt is { } first ? first - trace.StartedAt : null,
      EffectiveMaxChargeNanoUsd = handle.EffectiveMaxChargeNanoUsd,
    };

    try
    {
      string amount = await price.Function!(context).ConfigureAwait(false);
      if (!Nano.IsCanonicalCharge(amount))
      {
        throw new EnlittConfigurationException("The price function must return a canonical nonnegative NANOUSD integer string.");
      }

      charge(amount);
    }
    catch (Exception ex)
    {
      // A bad price charges nothing and is visible only through the hook; the call's own result is unaffected.
      charge("0");
      PremiumLifecycle.Notify(client, ex as EnlittConfigurationException ?? new EnlittConfigurationException($"The price function failed: {ex.GetType().Name}: {ex.Message}"));
    }
  }

  private static PremiumTerminalFacts Facts(CallTrace trace, bool canceled, bool failed)
  {
    static int? Clamp(long? value) => value is null ? null : (int)Math.Min(value.Value, int.MaxValue);

    return new PremiumTerminalFacts
    {
      Usage = trace.Usage is { } u
            ? new PremiumUsage
            {
              InputTokens = Clamp(u.InputTokenCount),
              OutputTokens = Clamp(u.OutputTokenCount),
              CachedInputTokens = Clamp(ChatMapping.Count(u, ChatMapping.CachedInputKey)),
              ReasoningTokens = Clamp(ChatMapping.Count(u, ChatMapping.ReasoningKey)),
            }
            : null,
      FinishReason = trace.Finish?.Value,
      ProviderResponseId = trace.ResponseId,
      Delivery = new PremiumDelivery(trace.FirstContentAt is not null || (trace.Completed && trace.Content.Count > 0), trace.Completed && !failed),
      Timing = new PremiumTiming(trace.StartedAt.UtcDateTime.ToString("O"), trace.EndedAt.UtcDateTime.ToString("O")),
      ErrorCategory = canceled ? "canceled" : failed ? Category(trace.Failure) : null,
    };
  }

  private static string Category(Exception? ex) => ex switch
  {
    TimeoutException => "timeout",
    HttpRequestException => "network",
    _ => "unknown",
  };
}
