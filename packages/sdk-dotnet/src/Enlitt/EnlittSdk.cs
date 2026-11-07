namespace Enlitt;

/// <summary>The SDK's free functions. Every call is managed: it needs the business secret and a personal session.</summary>
public static class EnlittSdk
{
  /// <summary>
  /// Accounts one premium model call made by code outside this SDK. Begins one operation, runs <paramref name="run"/> only
  /// after admission, and sends exactly one terminal report whose status follows how <paramref name="run"/> settled.
  /// </summary>
  /// <typeparam name="T">The value <paramref name="run"/> produces.</typeparam>
  /// <param name="options">The call's settings and the shared Enlitt options.</param>
  /// <param name="run">The business's own model call; it receives the charge function and the admitted operation.</param>
  /// <param name="cancellationToken">Cancels the call; it is passed on to <paramref name="run"/>.</param>
  /// <returns>Whatever <paramref name="run"/> returns; its exceptions pass through unchanged.</returns>
  /// <exception cref="EnlittConfigurationException">A setting is invalid; raised before any request.</exception>
  /// <exception cref="EnlittException">Enlitt refused the call; <c>run</c> was not invoked.</exception>
  public static Task<T> WithPremiumChargeAsync<T>(
      WithPremiumChargeOptions options,
      Func<PremiumChargeFunction, PremiumChargeHandle, CancellationToken, Task<T>> run,
      CancellationToken cancellationToken = default) =>
      WithPremiumChargeCoreAsync(options, run, null, cancellationToken);

  /// <summary>Reads what the current user can still spend. Advisory only.</summary>
  /// <param name="options">The shared Enlitt options.</param>
  /// <param name="cancellationToken">Cancels the request.</param>
  /// <returns>The standard and premium availability.</returns>
  public static Task<EnlittUsage> UsageAsync(EnlittOptions? options = null, CancellationToken cancellationToken = default) =>
      UsageCoreAsync(options, null, cancellationToken);

  /// <summary>Runs <paramref name="fn"/> with <paramref name="session"/> (null for a signed-out visitor) as the ambient session.</summary>
  /// <typeparam name="T">The result type.</typeparam>
  /// <param name="session">The session, or null.</param>
  /// <param name="fn">The work to run inside the context.</param>
  /// <returns>The work's result.</returns>
  public static Task<T> RunWithEnlittSessionAsync<T>(EnlittSession? session, Func<Task<T>> fn) => SessionContext.RunAsync(session, fn);

  /// <summary>Runs <paramref name="fn"/> with <paramref name="session"/> (null for a signed-out visitor) as the ambient session.</summary>
  /// <param name="session">The session, or null.</param>
  /// <param name="fn">The work to run inside the context.</param>
  /// <returns>A task that completes with the work.</returns>
  public static Task RunWithEnlittSessionAsync(EnlittSession? session, Func<Task> fn) =>
      SessionContext.RunAsync<bool>(session, async () =>
      {
        await fn().ConfigureAwait(false);
        return true;
      });

  /// <summary>Returns the ambient session, or null for a signed-out visitor. A local read; no network call.</summary>
  /// <returns>The session or null.</returns>
  /// <exception cref="EnlittConfigurationException">There is no session context at all (the middleware is not installed on this path).</exception>
  public static EnlittSession? GetEnlittSession() => SessionContext.Get();

  /// <summary>Test seam overload.</summary>
  internal static async Task<T> WithPremiumChargeCoreAsync<T>(
      WithPremiumChargeOptions options,
      Func<PremiumChargeFunction, PremiumChargeHandle, CancellationToken, Task<T>> run,
      TransportSeams? seams,
      CancellationToken cancellationToken)
  {
    ArgumentNullException.ThrowIfNull(options);
    ArgumentNullException.ThrowIfNull(run);
    CallValidation.Nanousd(options.MaxCharge, "maxCharge");
    CallValidation.Provider(options.Provider);
    if (options.IdempotencyKey is { } key)
    {
      CallValidation.IdempotencyKey(key);
    }

    if (options.ReportingDeadlineMs is { } deadline)
    {
      CallValidation.ReportingDeadline(deadline);
    }

    CallValidation.Metadata(options.Metadata);

    InternalClient client = InternalClient.Create(options, seams);
    var request = new PremiumChargeRequest(options.MaxCharge, options.Provider, options.IdempotencyKey, options.ReportingDeadlineMs, options.Metadata);
    return await PremiumLifecycle.RunAsync(client, request, run, cancellationToken).ConfigureAwait(false);
  }

  /// <summary>Test seam overload.</summary>
  internal static Task<EnlittUsage> UsageCoreAsync(EnlittOptions? options, TransportSeams? seams, CancellationToken cancellationToken) =>
      UsageReader.ReadAsync(InternalClient.Create(options, seams), cancellationToken);
}
