namespace Enlitt;

/// <summary>What a user can still spend on one credit type, as coarse advisory figures.</summary>
/// <param name="RemainingPercent">The floor of 100 x remaining / total, clamped to 0..100.</param>
/// <param name="LimitCapNanoUsd">The largest single call in canonical NANOUSD, bounded by every applicable limit.</param>
public sealed record UsageAvailability(int RemainingPercent, string LimitCapNanoUsd);

/// <summary>The result of <see cref="EnlittSdk.UsageAsync"/>. Advisory only: a concurrent call can consume capacity before the caller acts.</summary>
/// <param name="Standard">Standard availability.</param>
/// <param name="Premium">Premium availability.</param>
public sealed record EnlittUsage(UsageAvailability Standard, UsageAvailability Premium);

/// <summary>Reads <c>GET /v1/enlitt/usage</c>.</summary>
internal static class UsageReader
{
  /// <summary>Performs one usage read through the managed transport and tolerant-parses the answer.</summary>
  internal static async Task<EnlittUsage> ReadAsync(InternalClient client, CancellationToken cancellationToken)
  {
    using HttpResponseMessage response = await client
        .SendAsync(new EnlittRequest(HttpMethod.Get, "/v1/enlitt/usage", null, null, "application/json"), cancellationToken)
        .ConfigureAwait(false);
    string text = await InternalClient.ReadSuccessBodyAsync(response, cancellationToken).ConfigureAwait(false);
    System.Text.Json.Nodes.JsonObject body = WireShapes.ReadBody(WireShapes.UsageResponse, text, "usage response");
    return new EnlittUsage(Read(body, "standard"), Read(body, "premium"));
  }

  private static UsageAvailability Read(System.Text.Json.Nodes.JsonObject body, string key) =>
      new((int)body[key]!["remaining_percent"]!.GetValue<long>(), body[key]!["limit_cap_nano_usd"]!.GetValue<string>());
}
