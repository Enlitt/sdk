namespace Enlitt;

/// <summary>Tunes the transport's wait on a <c>rate_limit_exceeded</c> refusal. It cannot disable the jitter or make any other error retryable.</summary>
public sealed record EnlittRateLimitRetryOptions
{
  /// <summary>The most attempts including the first; default 3, minimum 1. One means "never wait".</summary>
  public int? MaxAttempts { get; init; }

  /// <summary>The wall-clock budget for all waits, measured from the first refusal; default 30000.</summary>
  public long? MaxTotalWaitMs { get; init; }

  /// <summary>Called before each wait with the refused attempt number (1-based) and the delay in milliseconds about to be slept.</summary>
  public Action<int, int>? OnRateLimit { get; init; }
}

/// <summary>Options shared by every SDK entry point. All members are optional.</summary>
public record EnlittOptions
{
  /// <summary>The business secret; falls back to the <c>ENLITT_SECRET_KEY</c> environment variable.</summary>
  public string? SecretKey { get; init; }

  /// <summary>The Enlitt API origin; falls back to <c>ENLITT_BASE_URL</c>, then to <c>https://api.enlitt.com</c>.</summary>
  public string? BaseUrl { get; init; }

  /// <summary>An explicit session for background jobs and queue workers; otherwise the ambient session is used.</summary>
  public EnlittSession? Session { get; init; }

  /// <summary>Tunes the rate-limit wait.</summary>
  public EnlittRateLimitRetryOptions? RateLimit { get; init; }

  /// <summary>Observes a premium terminal report that could not be delivered. It is the only place that failure is visible.</summary>
  public Action<EnlittException>? OnTerminalReportError { get; init; }
}
