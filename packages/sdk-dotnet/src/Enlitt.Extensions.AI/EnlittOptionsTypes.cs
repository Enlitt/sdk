using System.Numerics;
using Microsoft.Extensions.AI;

namespace Enlitt.Extensions.AI;

/// <summary>
/// Per-call Enlitt settings, read from <c>ChatOptions.AdditionalProperties["enlitt"]</c> on every invocation.
/// They govern that invocation only, so a caller can change <see cref="MaxCharge"/> or <see cref="Price"/> step by step.
/// </summary>
public sealed record EnlittProviderOptions
{
  /// <summary>The key under <c>ChatOptions.AdditionalProperties</c> this record is read from.</summary>
  public const string Key = "enlitt";

  /// <summary>
  /// A base for the call identity (16-200 visible ASCII characters), not the identity itself. Supplying it makes a whole model
  /// call replay-safe across the caller's own retries; omitting it gives a fresh identity per invocation.
  /// </summary>
  public string? IdempotencyKey { get; init; }

  /// <summary>Premium only: the NANOUSD maximum the call declares. Required unless <see cref="Price"/> is a constant, which it then defaults to.</summary>
  public string? MaxCharge { get; init; }

  /// <summary>Premium only: what the call costs. Absent means a free call (every status charges "0").</summary>
  public EnlittPrice? Price { get; init; }

  /// <summary>Premium only: how long, in milliseconds, the caller needs before it reports the terminal outcome.</summary>
  public long? ReportingDeadlineMs { get; init; }

  /// <summary>Non-authoritative metadata: at most 16 entries, keys up to 64 characters (none starting with <c>enlitt_</c>), values up to 512.</summary>
  public IReadOnlyDictionary<string, string>? Metadata { get; init; }
}

/// <summary>A premium price: a constant NANOUSD amount, or a function evaluated once when the call ends.</summary>
public sealed class EnlittPrice
{
  private EnlittPrice(string? constant, Func<PremiumPriceContext, ValueTask<string>>? function)
  {
    Constant = constant;
    Function = function;
  }

  /// <summary>The constant amount, or null for a function price.</summary>
  public string? Constant { get; }

  /// <summary>The price function, or null for a constant price.</summary>
  public Func<PremiumPriceContext, ValueTask<string>>? Function { get; }

  /// <summary>A fixed price, charged on both <c>completed</c> and <c>canceled</c>.</summary>
  /// <param name="nanoUsd">A canonical nonnegative NANOUSD integer string.</param>
  public static EnlittPrice FromConstant(string nanoUsd) => new(nanoUsd, null);

  /// <summary>A price computed once per operation, when the call ends completed or canceled; never for a failed call.</summary>
  /// <param name="function">Returns a canonical nonnegative NANOUSD integer string.</param>
  public static EnlittPrice FromFunction(Func<PremiumPriceContext, ValueTask<string>> function) => new(null, function);

  /// <summary>A constant price from a string.</summary>
  public static implicit operator EnlittPrice(string nanoUsd) => FromConstant(nanoUsd);

  /// <summary>A function price from a delegate.</summary>
  public static implicit operator EnlittPrice(Func<PremiumPriceContext, ValueTask<string>> function) => FromFunction(function);
}

/// <summary>How the call ended, as a price function sees it. A failed call is never priced.</summary>
public enum PremiumPriceStatus
{
  /// <summary>The call finished (a length finish included).</summary>
  Completed,

  /// <summary>The call was canceled before it finished.</summary>
  Canceled,
}

/// <summary>Everything the SDK knows when a premium call ends, and nothing it does not. It never leaves the caller's process.</summary>
public sealed record PremiumPriceContext
{
  /// <summary>How the call ended.</summary>
  public required PremiumPriceStatus Status { get; init; }

  /// <summary>The produced content, flattened: the response's content, or every content item the stream emitted. Empty on cancellation before output.</summary>
  public required IReadOnlyList<AIContent> Content { get; init; }

  /// <summary>For a streaming call, every update the inner client emitted in order (collected only because the price is a function); null for a non-streaming call.</summary>
  public IReadOnlyList<ChatResponseUpdate>? Updates { get; init; }

  /// <summary>Token usage; possibly absent on cancellation.</summary>
  public UsageDetails? Usage { get; init; }

  /// <summary>The finish reason; absent on cancellation before a finish.</summary>
  public ChatFinishReason? FinishReason { get; init; }

  /// <summary>When the inner call started.</summary>
  public required DateTimeOffset StartedAt { get; init; }

  /// <summary>When the inner call ended or was canceled.</summary>
  public required DateTimeOffset EndedAt { get; init; }

  /// <summary>The time from start to end.</summary>
  public TimeSpan Duration => EndedAt - StartedAt;

  /// <summary>Present only for a stream that emitted a content item: the time to the first one.</summary>
  public TimeSpan? TimeToFirstToken { get; init; }

  /// <summary>The bound every price is lowered to; it may be below the declared <c>MaxCharge</c>.</summary>
  public required string EffectiveMaxChargeNanoUsd { get; init; }
}

/// <summary>The routing facts a standard call adds to <c>ChatResponse.AdditionalProperties["enlitt"]</c>; nothing else about routing is exposed.</summary>
/// <param name="OperationId">Enlitt's operation id.</param>
/// <param name="RoutedProvider">The provider Enlitt routed to.</param>
/// <param name="RoutedModel">The model Enlitt routed to.</param>
/// <param name="PolicyVersion">The routing policy version.</param>
public sealed record EnlittStandardMetadata(string? OperationId, string? RoutedProvider, string? RoutedModel, string? PolicyVersion);

/// <summary>What a premium call adds to <c>AdditionalProperties["enlitt"]</c>, and nothing else.</summary>
/// <param name="OperationId">Enlitt's operation id.</param>
/// <param name="EffectiveMaxChargeNanoUsd">The bound every price is lowered to.</param>
public sealed record EnlittPremiumMetadata(string OperationId, string EffectiveMaxChargeNanoUsd);

/// <summary>Ready-made price functions.</summary>
public static class EnlittPricing
{
  /// <summary>
  /// A price of <c>input x InputTokenCount + output x OutputTokenCount</c>, both rates in NANOUSD per token, computed without precision loss.
  /// A missing count is zero, so a canceled call with no usage charges nothing for that side. Cached and reasoning tokens are priced as ordinary tokens.
  /// </summary>
  /// <param name="input">NANOUSD per input token, a canonical nonnegative integer string.</param>
  /// <param name="output">NANOUSD per output token, a canonical nonnegative integer string.</param>
  /// <returns>A function to assign to <see cref="EnlittProviderOptions.Price"/>.</returns>
  /// <exception cref="EnlittConfigurationException">A rate is not canonical.</exception>
  public static Func<PremiumPriceContext, ValueTask<string>> PerToken(string input, string output)
  {
    if (!Nano.IsCanonical(input) || !Nano.IsCanonical(output))
    {
      throw new EnlittConfigurationException("PerToken rates must be canonical nonnegative NANOUSD integer strings.");
    }

    BigInteger inputRate = Nano.Parse(input);
    BigInteger outputRate = Nano.Parse(output);
    return context => ValueTask.FromResult(
        (inputRate * (context.Usage?.InputTokenCount ?? 0) + outputRate * (context.Usage?.OutputTokenCount ?? 0)).ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
}
