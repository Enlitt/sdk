using System.Reflection;
using System.Text.Json.Nodes;

namespace Enlitt;

/// <summary>One row of the vendored error-code record (<c>contract.json</c> <c>error_codes</c>).</summary>
/// <param name="Type">The OpenAI-shaped error type of the code.</param>
/// <param name="HttpStatus">The HTTP status the server sends with the code.</param>
/// <param name="Retryable">Whether the code is retryable.</param>
/// <param name="RetryAfter">"required" or "forbidden": whether the code carries Retry-After.</param>
/// <param name="AuthorizeUrl">"allowed" or "forbidden": whether the code may carry an authorize URL.</param>
/// <param name="AdmissibleMaxCharge">"allowed" or "forbidden": whether the code may carry an admissible maximum charge.</param>
/// <param name="LimitRule">"required" or "forbidden": whether the code must carry a limit rule.</param>
internal sealed record ErrorCodeInfo(
    string Type,
    int HttpStatus,
    bool Retryable,
    string RetryAfter,
    string AuthorizeUrl,
    string AdmissibleMaxCharge,
    string LimitRule);

/// <summary>
/// The vendored <c>packages/protocol/generated/contract.json</c>, embedded as the resource
/// <c>Enlitt.contract.json</c>. Every wire fact the SDK shares with the protocol package (API version, closed sets,
/// the error-code record, idempotency bounds) is read from here and never restated as a literal.
/// </summary>
internal static class EnlittContract
{
  private const string ResourceName = "Enlitt.contract.json";

  /// <summary>The raw bytes of the embedded contract, for the byte-for-byte staleness test.</summary>
  internal static byte[] RawBytes { get; }

  /// <summary>The wire API version this build was written against (<c>Enlitt-Version</c> header value).</summary>
  internal static string ApiVersion { get; }

  /// <summary>The name of the version header.</summary>
  internal static string VersionHeader { get; }

  /// <summary>The reserved value an unknown closed-set member reads as.</summary>
  internal static string UnknownEnumValue { get; }

  /// <summary>The reserved code used when an error envelope carries no usable code.</summary>
  internal static string UnrecognizedErrorCode { get; }

  /// <summary>Minimum length of an <c>Idempotency-Key</c>.</summary>
  internal static int IdempotencyKeyMin { get; }

  /// <summary>Maximum length of an <c>Idempotency-Key</c>.</summary>
  internal static int IdempotencyKeyMax { get; }

  /// <summary>The frozen error-code record keyed by stable code.</summary>
  internal static IReadOnlyDictionary<string, ErrorCodeInfo> ErrorCodes { get; }

  /// <summary>Every closed string set a response can carry, keyed by <c>&lt;object&gt;.&lt;field&gt;</c>.</summary>
  internal static IReadOnlyDictionary<string, IReadOnlySet<string>> ClosedSets { get; }

  static EnlittContract()
  {
    using Stream stream = typeof(EnlittContract).Assembly.GetManifestResourceStream(ResourceName)
        ?? throw new InvalidOperationException($"The embedded resource {ResourceName} is missing.");
    using var buffer = new MemoryStream();
    stream.CopyTo(buffer);
    RawBytes = buffer.ToArray();

    JsonObject root = JsonNode.Parse(RawBytes)!.AsObject();
    ApiVersion = root["api_version"]!.GetValue<string>();
    VersionHeader = root["version_header"]!.GetValue<string>();
    UnknownEnumValue = root["unknown_enum_value"]!.GetValue<string>();
    UnrecognizedErrorCode = root["unrecognized_error_code"]!.GetValue<string>();
    IdempotencyKeyMin = root["idempotency_key"]!["min_length"]!.GetValue<int>();
    IdempotencyKeyMax = root["idempotency_key"]!["max_length"]!.GetValue<int>();

    var codes = new Dictionary<string, ErrorCodeInfo>(StringComparer.Ordinal);
    foreach (KeyValuePair<string, JsonNode?> entry in root["error_codes"]!.AsObject())
    {
      JsonObject row = entry.Value!.AsObject();
      codes[entry.Key] = new ErrorCodeInfo(
          row["type"]!.GetValue<string>(),
          row["http_status"]!.GetValue<int>(),
          row["retryable"]!.GetValue<bool>(),
          row["retry_after"]!.GetValue<string>(),
          row["authorize_url"]!.GetValue<string>(),
          row["admissible_max_charge"]!.GetValue<string>(),
          row["limit_rule"]!.GetValue<string>());
    }
    ErrorCodes = codes;

    var sets = new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal);
    foreach (KeyValuePair<string, JsonNode?> entry in root["closed_sets"]!.AsObject())
    {
      sets[entry.Key] = entry.Value!.AsArray().Select(n => n!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
    }
    ClosedSets = sets;
  }

  /// <summary>Reads <paramref name="value"/> against the closed set <paramref name="setKey"/>, returning "other" for an unknown member.</summary>
  internal static string ReadMember(string setKey, string value) =>
      ClosedSets[setKey].Contains(value) ? value : UnknownEnumValue;
}
