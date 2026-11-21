using Microsoft.Extensions.AI;

namespace Enlitt.Extensions.AI;

/// <summary>
/// Per-call Enlitt settings for a premium media call, read from <c>AdditionalProperties["enlitt"]</c> on the call's
/// <see cref="ImageGenerationOptions"/>, <see cref="TextToSpeechOptions"/>, or <see cref="SpeechToTextOptions"/>.
/// The members are those of <see cref="EnlittProviderOptions"/>, except that <see cref="Price"/> sees a media price context.
/// </summary>
public sealed record EnlittMediaProviderOptions
{
  /// <summary>The key under the call options' <c>AdditionalProperties</c> this record is read from.</summary>
  public const string Key = EnlittProviderOptions.Key;

  /// <summary>
  /// The call identity itself (16-200 visible ASCII characters), unlike chat where it is only a base. A media call is one
  /// provider invocation, so a supplied key makes the call replay-safe; omitting it gives a fresh identity per call.
  /// </summary>
  public string? IdempotencyKey { get; init; }

  /// <summary>The NANOUSD maximum the call declares. Required unless <see cref="Price"/> is a constant, which it then defaults to.</summary>
  public string? MaxCharge { get; init; }

  /// <summary>What the call costs. Absent means a free call (every status charges "0").</summary>
  public EnlittMediaPrice? Price { get; init; }

  /// <summary>How long, in milliseconds, the caller needs before it reports the terminal outcome.</summary>
  public long? ReportingDeadlineMs { get; init; }

  /// <summary>Non-authoritative metadata: at most 16 entries, keys up to 64 characters (none starting with <c>enlitt_</c>), values up to 512.</summary>
  public IReadOnlyDictionary<string, string>? Metadata { get; init; }
}

/// <summary>A premium media price: a constant NANOUSD amount, or a function evaluated once when the call ends.</summary>
public sealed class EnlittMediaPrice
{
  private EnlittMediaPrice(string? constant, Func<PremiumMediaPriceContext, ValueTask<string>>? function)
  {
    Constant = constant;
    Function = function;
  }

  /// <summary>The constant amount, or null for a function price.</summary>
  public string? Constant { get; }

  /// <summary>The price function, or null for a constant price.</summary>
  public Func<PremiumMediaPriceContext, ValueTask<string>>? Function { get; }

  /// <summary>A fixed price, charged on both <c>completed</c> and <c>canceled</c>.</summary>
  /// <param name="nanoUsd">A canonical nonnegative NANOUSD integer string.</param>
  public static EnlittMediaPrice FromConstant(string nanoUsd) => new(nanoUsd, null);

  /// <summary>A price computed once per call, when it ends completed or canceled; never for a failed call.</summary>
  /// <param name="function">Returns a canonical nonnegative NANOUSD integer string.</param>
  public static EnlittMediaPrice FromFunction(Func<PremiumMediaPriceContext, ValueTask<string>> function) => new(null, function);

  /// <summary>A constant price from a string.</summary>
  public static implicit operator EnlittMediaPrice(string nanoUsd) => FromConstant(nanoUsd);

  /// <summary>A function price from a delegate.</summary>
  public static implicit operator EnlittMediaPrice(Func<PremiumMediaPriceContext, ValueTask<string>> function) => FromFunction(function);
}

/// <summary>Which kind of media call a <see cref="PremiumMediaPriceContext"/> describes.</summary>
public enum PremiumMediaKind
{
  /// <summary>An <see cref="IImageGenerator"/> call.</summary>
  Image,

  /// <summary>An <see cref="ITextToSpeechClient"/> call.</summary>
  Speech,

  /// <summary>An <see cref="ISpeechToTextClient"/> call.</summary>
  Transcription,
}

/// <summary>
/// Everything the SDK knows when a premium media call ends, and nothing it does not. It never leaves the caller's process.
/// Only the members of the call's <see cref="Kind"/> are set; every other member is null.
/// </summary>
public sealed record PremiumMediaPriceContext
{
  /// <summary>Which kind of call this was.</summary>
  public required PremiumMediaKind Kind { get; init; }

  /// <summary>How the call ended. A failed call is never priced.</summary>
  public required PremiumPriceStatus Status { get; init; }

  /// <summary>When the inner call started.</summary>
  public required DateTimeOffset StartedAt { get; init; }

  /// <summary>When the inner call ended or was canceled.</summary>
  public required DateTimeOffset EndedAt { get; init; }

  /// <summary>The time from start to end.</summary>
  public TimeSpan Duration => EndedAt - StartedAt;

  /// <summary>The bound every price is lowered to; it may be below the declared <c>MaxCharge</c>.</summary>
  public required string EffectiveMaxChargeNanoUsd { get; init; }

  /// <summary>Image calls: the options the inner generator received (without the <c>enlitt</c> entry).</summary>
  public ImageGenerationOptions? ImageOptions { get; init; }

  /// <summary>Image calls that completed: the inner generator's response.</summary>
  public ImageGenerationResponse? ImageResponse { get; init; }

  /// <summary>Speech calls: the options the inner client received (without the <c>enlitt</c> entry).</summary>
  public TextToSpeechOptions? SpeechOptions { get; init; }

  /// <summary>Speech calls: the Unicode code-point count of the text, so an emoji counts as one.</summary>
  public int? Characters { get; init; }

  /// <summary>Speech calls that completed: the inner client's response.</summary>
  public TextToSpeechResponse? SpeechResponse { get; init; }

  /// <summary>Transcription calls: the options the inner client received (without the <c>enlitt</c> entry).</summary>
  public SpeechToTextOptions? TranscriptionOptions { get; init; }

  /// <summary>Transcription calls that completed: the inner client's response.</summary>
  public SpeechToTextResponse? TranscriptionResponse { get; init; }
}
