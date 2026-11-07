using System.Numerics;
using System.Text.Json.Nodes;

namespace Enlitt;

/// <summary>Records the amount (canonical NANOUSD) the business charges for the call; the last call wins.</summary>
/// <param name="amountNanoUsd">A canonical nonnegative base-10 integer string of at most 30 digits.</param>
/// <exception cref="EnlittConfigurationException">The amount is not canonical, or the report was already sent.</exception>
public delegate void PremiumChargeFunction(string amountNanoUsd);

/// <summary>The bounded labels naming the provider and model the business runs for a premium call. Disclosure only, not proof.</summary>
/// <param name="Id">The provider label, such as "openai".</param>
/// <param name="Model">The model label, such as "gpt-5".</param>
public sealed record PremiumProvider(string Id, string Model);

/// <summary>Token counts a business may attach to a terminal report. Operational history only; no financial effect.</summary>
public sealed record PremiumUsage
{
  /// <summary>Input tokens.</summary>
  public int? InputTokens { get; init; }

  /// <summary>Output tokens.</summary>
  public int? OutputTokens { get; init; }

  /// <summary>Cached input tokens.</summary>
  public int? CachedInputTokens { get; init; }

  /// <summary>Reasoning tokens.</summary>
  public int? ReasoningTokens { get; init; }
}

/// <summary>Whether output reached the caller.</summary>
/// <param name="OutputStarted">True once any output was produced.</param>
/// <param name="OutputCompleted">True once the output finished.</param>
public sealed record PremiumDelivery(bool OutputStarted, bool OutputCompleted);

/// <summary>The call's start and end instants as RFC 3339 strings.</summary>
/// <param name="StartedAt">The start instant.</param>
/// <param name="EndedAt">The end instant.</param>
public sealed record PremiumTiming(string StartedAt, string EndedAt);

/// <summary>Safe, content-free facts recorded with <see cref="PremiumChargeHandle.Describe"/>. Every member is optional.</summary>
public sealed record PremiumTerminalFacts
{
  /// <summary>Token counts.</summary>
  public PremiumUsage? Usage { get; init; }

  /// <summary>The provider's finish reason, bounded and safe.</summary>
  public string? FinishReason { get; init; }

  /// <summary>The provider's response identifier, bounded and safe.</summary>
  public string? ProviderResponseId { get; init; }

  /// <summary>Delivery facts.</summary>
  public PremiumDelivery? Delivery { get; init; }

  /// <summary>Timing facts.</summary>
  public PremiumTiming? Timing { get; init; }

  /// <summary>One of provider, timeout, network, invalid_request, canceled, unknown.</summary>
  public string? ErrorCategory { get; init; }
}

/// <summary>The admitted operation as Enlitt returned it, handed to the business's <c>run</c> delegate.</summary>
public sealed class PremiumChargeHandle
{
  private readonly Action<PremiumTerminalFacts> _describe;

  internal PremiumChargeHandle(string operationId, string effectiveMaxChargeNanoUsd, string terminalDeadline, Action<PremiumTerminalFacts> describe)
  {
    OperationId = operationId;
    EffectiveMaxChargeNanoUsd = effectiveMaxChargeNanoUsd;
    TerminalDeadline = terminalDeadline;
    _describe = describe;
  }

  /// <summary>Enlitt's identifier for this operation.</summary>
  public string OperationId { get; }

  /// <summary>The most this operation can charge: the declared maximum, lowered to the user's per-call limit.</summary>
  public string EffectiveMaxChargeNanoUsd { get; }

  /// <summary>The RFC 3339 instant after which a report is refused and the operation expires uncharged.</summary>
  public string TerminalDeadline { get; }

  /// <summary>Records safe facts for the terminal report; the last call wins. Nothing here is required.</summary>
  /// <param name="facts">The facts.</param>
  public void Describe(PremiumTerminalFacts facts) => _describe(facts);
}

/// <summary>Options for <see cref="EnlittSdk.WithPremiumChargeAsync{T}"/>: the shared Enlitt options plus the call's own settings.</summary>
public sealed record WithPremiumChargeOptions : EnlittOptions
{
  /// <summary>The most the call may charge, in NANOUSD, declared before it runs.</summary>
  public required string MaxCharge { get; init; }

  /// <summary>The provider and model labels.</summary>
  public required PremiumProvider Provider { get; init; }

  /// <summary>The call identity; a fresh random one by default. Retrying with the same key replays the operation.</summary>
  public string? IdempotencyKey { get; init; }

  /// <summary>How long the business needs before it will report the outcome; the server bounds it.</summary>
  public long? ReportingDeadlineMs { get; init; }

  /// <summary>Non-authoritative metadata: at most 16 entries, keys at most 64 characters, values at most 512, no <c>enlitt_</c> prefix.</summary>
  public IReadOnlyDictionary<string, string>? Metadata { get; init; }
}

/// <summary>One premium call as the lifecycle sees it (internal; the public type is <see cref="WithPremiumChargeOptions"/>).</summary>
internal sealed record PremiumChargeRequest(
    string MaxCharge,
    PremiumProvider Provider,
    string? CallId,
    long? ReportingDeadlineMs,
    IReadOnlyDictionary<string, string>? Metadata);

/// <summary>The status a premium call reports.</summary>
internal enum PremiumStatus
{
  /// <summary>The provider returned an answer, including a truncated one.</summary>
  Completed,

  /// <summary>The provider call errored.</summary>
  Failed,

  /// <summary>The caller stopped the call.</summary>
  Canceled,
}

/// <summary>The validation rules for caller-supplied call settings; the one validator behind both premium entry points.</summary>
internal static class CallValidation
{
  private const int MaxIdempotencyKeyLength = 200;
  private const long MaxSafeInteger = 9_007_199_254_740_991;

  /// <summary>A fresh random identity of 36 visible ASCII characters.</summary>
  internal static string NewId(string prefix) => prefix + Guid.NewGuid().ToString("N");

  /// <summary>Validates an idempotency key base: 16 to 200 visible ASCII characters.</summary>
  internal static string IdempotencyKey(string key)
  {
    if (key.Length < EnlittContract.IdempotencyKeyMin || key.Length > MaxIdempotencyKeyLength || !key.All(c => c is >= '!' and <= '~'))
    {
      throw new EnlittConfigurationException(
          $"idempotencyKey must be {EnlittContract.IdempotencyKeyMin} to {MaxIdempotencyKeyLength} visible ASCII characters.");
    }

    return key;
  }

  /// <summary>
  /// Validates a full call identity (a base plus an appended suffix): the protocol's own bounds, so a base that passed
  /// <see cref="IdempotencyKey"/> always yields an accepted identity.
  /// </summary>
  internal static string CallId(string callId)
  {
    if (callId.Length < EnlittContract.IdempotencyKeyMin || callId.Length > EnlittContract.IdempotencyKeyMax || !callId.All(c => c is >= '!' and <= '~'))
    {
      throw new EnlittConfigurationException(
          $"The call identity must be {EnlittContract.IdempotencyKeyMin} to {EnlittContract.IdempotencyKeyMax} visible ASCII characters.");
    }

    return callId;
  }

  /// <summary>Validates a NANOUSD amount.</summary>
  internal static string Nanousd(string? value, string name)
  {
    if (!Nano.IsCanonicalCharge(value))
    {
      throw new EnlittConfigurationException($"{name} must be a canonical nonnegative NANOUSD integer string of at most 30 digits.");
    }

    return value!;
  }

  /// <summary>Validates a reporting deadline: a positive safe integer.</summary>
  internal static long ReportingDeadline(long value)
  {
    if (value < 1 || value > MaxSafeInteger)
    {
      throw new EnlittConfigurationException("reportingDeadlineMs must be a positive safe integer.");
    }

    return value;
  }

  /// <summary>Validates metadata under the <c>/v1/responses</c> bounds.</summary>
  internal static void Metadata(IReadOnlyDictionary<string, string>? metadata)
  {
    if (metadata is null)
    {
      return;
    }

    if (metadata.Count > 16)
    {
      throw new EnlittConfigurationException("metadata may have at most 16 entries.");
    }

    foreach ((string key, string value) in metadata)
    {
      if (key.Length is 0 or > 64 || key.StartsWith("enlitt_", StringComparison.Ordinal))
      {
        throw new EnlittConfigurationException("metadata keys must be 1 to 64 characters and must not start with \"enlitt_\".");
      }

      if (value is null || value.Length > 512)
      {
        throw new EnlittConfigurationException("metadata values must be strings of at most 512 characters.");
      }
    }
  }

  /// <summary>Validates a provider label pair: non-empty, bounded.</summary>
  internal static void Provider(PremiumProvider? provider)
  {
    if (provider is null || string.IsNullOrWhiteSpace(provider.Id) || string.IsNullOrWhiteSpace(provider.Model)
        || provider.Id.Length > 128 || provider.Model.Length > 256)
    {
      throw new EnlittConfigurationException("provider.id and provider.model must be non-empty bounded strings.");
    }
  }
}

/// <summary>The one premium lifecycle: begin, run, then exactly one terminal report.</summary>
internal static class PremiumLifecycle
{
  private const int ReportAttempts = 3;
  private const int ReportBackoffBaseMs = 200;
  private static readonly TimeSpan ReportAttemptTimeout = TimeSpan.FromSeconds(30);

  /// <summary>
  /// Wraps exactly one model call. <paramref name="run"/> is invoked only after admission. Its outcome decides the status,
  /// the last <c>charge()</c> amount decides the charge, and the report is awaited before this method settles.
  /// <paramref name="run"/>'s value or exception passes through unchanged.
  /// </summary>
  internal static async Task<T> RunAsync<T>(
      InternalClient client,
      PremiumChargeRequest request,
      Func<PremiumChargeFunction, PremiumChargeHandle, CancellationToken, Task<T>> run,
      CancellationToken cancellationToken)
  {
    string callId = request.CallId ?? CallValidation.NewId("enl_");
    JsonObject beginBody = BuildBegin(request);
    JsonObject begun = await BeginAsync(client, beginBody, callId, cancellationToken).ConfigureAwait(false);

    string operationId = begun["operation_id"]!.GetValue<string>();
    string effectiveMax = begun["effective_max_charge_nano_usd"]!.GetValue<string>();
    string deadline = begun["terminal_deadline"]!.GetValue<string>();

    string? chargeAmount = null;
    bool reported = false;
    PremiumTerminalFacts? facts = null;
    var handle = new PremiumChargeHandle(operationId, effectiveMax, deadline, f => facts = f);

    void Charge(string amount)
    {
      if (reported)
      {
        throw new EnlittConfigurationException("charge() was called after the terminal report was sent.");
      }

      chargeAmount = CallValidation.Nanousd(amount, "The charge amount");
    }

    async Task ReportAsync(PremiumStatus status)
    {
      reported = true;
      string charge = status == PremiumStatus.Failed ? "0" : Nano.Min(chargeAmount ?? "0", effectiveMax);
      await ReportTerminalAsync(client, operationId, BuildReport(CallValidation.NewId("rep_"), status, charge, facts), cancellationToken: default)
          .ConfigureAwait(false);
    }

    T result;
    try
    {
      result = await run(Charge, handle, cancellationToken).ConfigureAwait(false);
    }
    catch (OperationCanceledException)
    {
      await ReportAsync(PremiumStatus.Canceled).ConfigureAwait(false);
      throw;
    }
    catch (Exception) when (cancellationToken.IsCancellationRequested)
    {
      await ReportAsync(PremiumStatus.Canceled).ConfigureAwait(false);
      throw;
    }
    catch (Exception)
    {
      await ReportAsync(PremiumStatus.Failed).ConfigureAwait(false);
      throw;
    }

    await ReportAsync(PremiumStatus.Completed).ConfigureAwait(false);
    return result;
  }

  /// <summary>Builds the begin body: only the content-free fields PROTOCOLS allows.</summary>
  internal static JsonObject BuildBegin(PremiumChargeRequest request)
  {
    var body = new JsonObject
    {
      ["mode"] = "premium",
      ["max_charge_nano_usd"] = request.MaxCharge,
    };
    if (request.ReportingDeadlineMs is { } deadline)
    {
      body["reporting_deadline_ms"] = deadline;
    }

    body["provider"] = new JsonObject { ["id"] = request.Provider.Id, ["model"] = request.Provider.Model };
    if (request.Metadata is { Count: > 0 } metadata)
    {
      var map = new JsonObject();
      foreach ((string key, string value) in metadata)
      {
        map[key] = value;
      }

      body["metadata"] = map;
    }

    return body;
  }

  /// <summary>Builds the terminal-report body.</summary>
  internal static JsonObject BuildReport(string reportId, PremiumStatus status, string charge, PremiumTerminalFacts? facts)
  {
    var body = new JsonObject
    {
      ["report_id"] = reportId,
      ["status"] = status switch
      {
        PremiumStatus.Completed => "completed",
        PremiumStatus.Failed => "failed",
        _ => "canceled",
      },
      ["charge_nano_usd"] = charge,
    };

    if (facts is null)
    {
      return body;
    }

    if (facts.Usage is { } usage)
    {
      var u = new JsonObject();
      if (usage.InputTokens is { } i)
      {
        u["input_tokens"] = i;
      }

      if (usage.OutputTokens is { } o)
      {
        u["output_tokens"] = o;
      }

      if (usage.CachedInputTokens is { } c)
      {
        u["cached_input_tokens"] = c;
      }

      if (usage.ReasoningTokens is { } r)
      {
        u["reasoning_tokens"] = r;
      }

      body["usage"] = u;
    }

    if (facts.FinishReason is { } finish)
    {
      body["finish_reason"] = finish;
    }

    if (facts.ProviderResponseId is { } responseId)
    {
      body["provider_response_id"] = responseId;
    }

    if (facts.Delivery is { } delivery)
    {
      body["delivery"] = new JsonObject { ["output_started"] = delivery.OutputStarted, ["output_completed"] = delivery.OutputCompleted };
    }

    if (facts.Timing is { } timing)
    {
      body["timing"] = new JsonObject { ["started_at"] = timing.StartedAt, ["ended_at"] = timing.EndedAt };
    }

    if (facts.ErrorCategory is { } category)
    {
      body["error_category"] = category;
    }

    return body;
  }

  private static async Task<JsonObject> BeginAsync(InternalClient client, JsonObject body, string callId, CancellationToken cancellationToken)
  {
    CallValidation.CallId(callId);
    using HttpResponseMessage response = await client
        .SendAsync(new EnlittRequest(HttpMethod.Post, "/v1/enlitt/operations", Canonical.Serialize(body), callId, "application/json"), cancellationToken)
        .ConfigureAwait(false);
    string text = await InternalClient.ReadSuccessBodyAsync(response, cancellationToken).ConfigureAwait(false);
    return WireShapes.ReadBody(WireShapes.BeginOperation, text, "begin-operation response");
  }

  /// <summary>
  /// Sends one terminal report with bounded transient retries under one unchanged report id. A report that cannot be
  /// delivered goes to <c>OnTerminalReportError</c> and is otherwise dropped; this method never throws.
  /// </summary>
  private static async Task ReportTerminalAsync(InternalClient client, string operationId, JsonObject body, CancellationToken cancellationToken)
  {
    string reportId = body["report_id"]!.GetValue<string>();
    string path = $"/v1/enlitt/operations/{Uri.EscapeDataString(operationId)}/terminal";
    string json = Canonical.Serialize(body);
    EnlittException? last = null;

    for (int attempt = 1; attempt <= ReportAttempts; attempt++)
    {
      using var timeout = new CancellationTokenSource(ReportAttemptTimeout);
      try
      {
        using HttpResponseMessage response = await client
            .SendAsync(new EnlittRequest(HttpMethod.Post, path, json, reportId, "application/json"), timeout.Token)
            .ConfigureAwait(false);
        string text = await InternalClient.ReadSuccessBodyAsync(response, timeout.Token).ConfigureAwait(false);

        // A parsed body is a delivered report, even when its status reads as "other".
        WireShapes.ReadBody(WireShapes.ReportTerminal, text, "terminal-report response");
        return;
      }
      catch (EnlittException ex)
      {
        last = ex;
        if (!(ex.Retryable || ex.Code == EnlittException.TransportFailed))
        {
          break;
        }
      }
      catch (OperationCanceledException ex)
      {
        last = EnlittErrors.Transport("The terminal report attempt timed out.", ex);
      }

      if (attempt < ReportAttempts)
      {
        await client.DelayAsync(TimeSpan.FromMilliseconds(ReportBackoffBaseMs * (1 << (attempt - 1))), cancellationToken).ConfigureAwait(false);
      }
    }

    Notify(client, last!);
  }

  /// <summary>Delivers an undeliverable-report error to the business's hook; a throwing hook is swallowed.</summary>
  internal static void Notify(InternalClient client, EnlittException error)
  {
    try
    {
      client.OnTerminalReportError?.Invoke(error);
    }
    catch (Exception)
    {
      // The hook is an observer; it must never change how the call settles.
    }
  }
}

/// <summary>Canonical (sorted-key, whitespace-free) JSON, so request bodies are comparable byte for byte.</summary>
internal static class Canonical
{
  /// <summary>Serializes <paramref name="node"/> compactly. Key order is preserved as built (builders add keys in wire order).</summary>
  internal static string Serialize(JsonNode node) => node.ToJsonString(new System.Text.Json.JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

  /// <summary>Returns a copy of <paramref name="node"/> with every object's keys sorted ordinally (for fixture comparison).</summary>
  internal static JsonNode? Sorted(JsonNode? node) => node switch
  {
    JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, Sorted(p.Value)))),
    JsonArray array => new JsonArray(array.Select(Sorted).ToArray()),
    null => null,
    _ => node.DeepClone(),
  };
}
