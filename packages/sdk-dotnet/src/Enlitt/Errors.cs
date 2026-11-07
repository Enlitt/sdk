using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Enlitt;

/// <summary>
/// The base class for every Enlitt-originated failure and the only carrier of Enlitt's stable wire codes
/// into a caller's code. Business code must <c>switch</c> over <see cref="Code"/> with a default branch,
/// because a newer server can send a code this SDK version does not know.
/// </summary>
public class EnlittException : Exception
{
  /// <summary>Code for missing or invalid SDK configuration.</summary>
  public const string ConfigurationInvalid = "configuration_invalid";

  /// <summary>Code for a request that never got an HTTP response.</summary>
  public const string TransportFailed = "transport_failed";

  /// <summary>Code for a response that did not parse.</summary>
  public const string MalformedResponse = "malformed_response";

  /// <summary>Code for a caller-initiated abort.</summary>
  public const string RequestCanceled = "request_canceled";

  /// <summary>Creates an Enlitt failure.</summary>
  /// <param name="code">A wire code from the record, a local code, a raw unknown code, or "unrecognized".</param>
  /// <param name="message">A safe, human-readable message that never contains a credential or prompt content.</param>
  /// <param name="retryable">Whether retrying the same call can succeed; read from the code record, never decided per instance.</param>
  /// <param name="retryAfterMs">The advertised wait in milliseconds, present only for the stable rate-limit code.</param>
  /// <param name="requestId">The <c>x-request-id</c> response header, when present.</param>
  /// <param name="authorizeUrl">A safe navigation target to Enlitt's dashboard, when the response carried one.</param>
  /// <param name="innerException">The underlying failure, for transport errors.</param>
  public EnlittException(
      string code,
      string message,
      bool retryable = false,
      int? retryAfterMs = null,
      string? requestId = null,
      string? authorizeUrl = null,
      Exception? innerException = null)
      : base(message, innerException)
  {
    Code = code;
    Retryable = retryable;
    RetryAfterMs = retryAfterMs;
    RequestId = requestId;
    AuthorizeUrl = authorizeUrl;
  }

  /// <summary>The stable code: a record code, a local code, the raw code a newer server sent, or "unrecognized".</summary>
  public string Code { get; }

  /// <summary>Always false: Enlitt refuses before the provider is reached.</summary>
  public bool ProviderInvoked { get; init; }

  /// <summary>True only for the rate-limit code and the retryable 5xx codes.</summary>
  public bool Retryable { get; }

  /// <summary>The advertised retry floor in milliseconds; null unless this is a rate-limit refusal that carried a parseable header.</summary>
  public int? RetryAfterMs { get; }

  /// <summary>The server's request identifier, for support.</summary>
  public string? RequestId { get; }

  /// <summary>Where to send the user to resolve a credit refusal; present only when the response carried a safe URL.</summary>
  public string? AuthorizeUrl { get; }
}

/// <summary>Missing or invalid SDK configuration (code <c>configuration_invalid</c>). Thrown locally before any network call.</summary>
public sealed class EnlittConfigurationException : EnlittException
{
  /// <summary>Creates a configuration failure.</summary>
  /// <param name="message">What is misconfigured.</param>
  public EnlittConfigurationException(string message)
      : base(ConfigurationInvalid, message)
  {
  }
}

/// <summary>No usable personal session resolves for this application (code <c>personal_login_required</c>).</summary>
public sealed class EnlittLoginRequiredException : EnlittException
{
  /// <summary>Creates a login-required failure.</summary>
  /// <param name="message">The message.</param>
  /// <param name="requestId">The server request identifier, if the server answered.</param>
  public EnlittLoginRequiredException(string message, string? requestId = null)
      : base("personal_login_required", message, requestId: requestId)
  {
  }
}

/// <summary>An authorization spending rule refused the call (code <c>spending_limit_exceeded</c>).</summary>
public sealed class EnlittLimitExceededException : EnlittException
{
  /// <summary>Creates a limit failure.</summary>
  public EnlittLimitExceededException(string message, string limitRule, string? requestId = null, string? authorizeUrl = null)
      : base("spending_limit_exceeded", message, requestId: requestId, authorizeUrl: authorizeUrl)
  {
    LimitRule = limitRule;
  }

  /// <summary>The rule that refused (for example <c>standard_per_call</c> or <c>rate.premium</c>); an unknown future rule stays a string.</summary>
  public string LimitRule { get; }
}

/// <summary>The plan allowance plus eligible bundles cannot cover the call, or an unknown credit refusal arrived.</summary>
public sealed class EnlittInsufficientCreditsException : EnlittException
{
  /// <summary>Creates a credit-refusal failure.</summary>
  public EnlittInsufficientCreditsException(
      string code,
      string message,
      string? requestId = null,
      string? authorizeUrl = null,
      string? admissibleMaxChargeNanoUsd = null)
      : base(code, message, requestId: requestId, authorizeUrl: authorizeUrl)
  {
    AdmissibleMaxChargeNanoUsd = admissibleMaxChargeNanoUsd;
  }

  /// <summary>
  /// The largest <c>MaxCharge</c> the user's remaining credits admit now (canonical NANOUSD string);
  /// present only on <c>premium_balance_exhausted</c>. The SDK never retries with it on its own.
  /// </summary>
  public string? AdmissibleMaxChargeNanoUsd { get; }
}

/// <summary>No subscription period covers the current instant (code <c>subscription_inactive</c>).</summary>
public sealed class EnlittSubscriptionInactiveException : EnlittException
{
  /// <summary>Creates a subscription failure.</summary>
  public EnlittSubscriptionInactiveException(string message, string? requestId = null, string? authorizeUrl = null)
      : base("subscription_inactive", message, requestId: requestId, authorizeUrl: authorizeUrl)
  {
  }
}

/// <summary>The user started as many standard calls as the plan allows this minute (code <c>rate_limit_exceeded</c>).</summary>
public sealed class EnlittRateLimitException : EnlittException
{
  /// <summary>Creates a rate-limit failure.</summary>
  public EnlittRateLimitException(string message, int? retryAfterMs, string? requestId = null)
      : base("rate_limit_exceeded", message, retryable: true, retryAfterMs: retryAfterMs, requestId: requestId)
  {
  }
}

/// <summary>A missing, invalid or revoked business key (code <c>invalid_api_key</c>).</summary>
public sealed class EnlittAuthenticationException : EnlittException
{
  /// <summary>Creates an authentication failure.</summary>
  public EnlittAuthenticationException(string message, string? requestId = null)
      : base("invalid_api_key", message, requestId: requestId)
  {
  }
}

/// <summary>A credential used outside its application or scope, or premium switched off (codes <c>insufficient_permissions</c>, <c>premium_not_enabled</c>).</summary>
public sealed class EnlittAuthorizationException : EnlittException
{
  /// <summary>Creates an authorization failure.</summary>
  public EnlittAuthorizationException(string code, string message, string? requestId = null)
      : base(code, message, requestId: requestId)
  {
  }
}

/// <summary>The result of classifying one error response body; a port of <c>classifyEnlittErrorResponse</c>.</summary>
/// <param name="Code">The record code, the raw unrecognized code, or "unrecognized".</param>
/// <param name="Recognized">True exactly when <paramref name="Code"/> is a key of the record.</param>
/// <param name="Status">The HTTP status as received.</param>
/// <param name="Type"><c>error.type</c> as received; null on the dashboard envelope.</param>
/// <param name="Retryable">The record's value, else the unrecognized-code rules.</param>
/// <param name="CreditRefusal">True when the code (or an unrecognized envelope type) is a credit refusal.</param>
/// <param name="Message"><c>error.message</c> truncated to 512 characters.</param>
/// <param name="AuthorizeUrl">A safe authorize URL, or null.</param>
/// <param name="AdmissibleMaxChargeNanoUsd">The admissible maximum charge, or null.</param>
/// <param name="LimitRule">The limit rule, or null.</param>
internal sealed record ClassifiedError(
    string Code,
    bool Recognized,
    int Status,
    string? Type,
    bool Retryable,
    bool CreditRefusal,
    string? Message,
    string? AuthorizeUrl,
    string? AdmissibleMaxChargeNanoUsd,
    string? LimitRule);

/// <summary>
/// Classifies error responses and turns them into exceptions. The class mapping is driven by the vendored
/// error-code record; the only per-code knowledge here is which exception subclass carries a code's extra field.
/// </summary>
internal static partial class EnlittErrors
{
  private const int MaxMessageLength = 512;
  private const int MaxLimitRuleLength = 64;

  [GeneratedRegex("^[a-z][a-z0-9_]{0,63}$")]
  private static partial Regex CodePattern();

  /// <summary>Builds the exception for a non-success HTTP response. Never throws.</summary>
  /// <param name="status">The HTTP status.</param>
  /// <param name="requestId">The <c>x-request-id</c> header, or null.</param>
  /// <param name="retryAfterHeader">The <c>Retry-After</c> header, or null.</param>
  /// <param name="bodyText">The (bounded) response body.</param>
  internal static EnlittException FromResponse(int status, string? requestId, string? retryAfterHeader, string bodyText)
  {
    JsonNode? body;
    try
    {
      body = JsonNode.Parse(bodyText);
    }
    catch (JsonException)
    {
      body = JsonValue.Create(bodyText);
    }

    return FromBody(status, requestId, retryAfterHeader, body);
  }

  /// <summary>Builds the exception for an already parsed body (the classifier works on JSON values, as in the protocol).</summary>
  internal static EnlittException FromBody(int status, string? requestId, string? retryAfterHeader, JsonNode? body)
  {
    ClassifiedError? c = Classify(status, body);
    if (c is null)
    {
      return new EnlittException(
          EnlittException.MalformedResponse,
          $"Enlitt answered HTTP {status.ToString(CultureInfo.InvariantCulture)} with a body that is not an error envelope.",
          requestId: requestId);
    }

    string message = c.Message ?? $"Enlitt refused the call with code \"{c.Code}\" (HTTP {status.ToString(CultureInfo.InvariantCulture)}).";

    if (!c.Recognized)
    {
      string prefix = $"Enlitt returned error code \"{c.Code}\" (HTTP {status.ToString(CultureInfo.InvariantCulture)}, type \"{c.Type ?? "none"}\"), which this version of @enlitt/sdk does not recognize. Upgrade @enlitt/sdk to handle it.";
      string full = c.Message is null ? prefix : prefix + " " + c.Message;
      // Rule 1 of the unrecognized-code rules: a credit refusal stays a credit refusal.
      return c.CreditRefusal
          ? new EnlittInsufficientCreditsException(c.Code, full, requestId, c.AuthorizeUrl)
          : new EnlittException(c.Code, full, retryable: c.Retryable, requestId: requestId);
    }

    // Only a code the record marks retry_after "required" is known to mean "wait and repeat".
    int? retryAfterMs = EnlittContract.ErrorCodes[c.Code].RetryAfter == "required" ? ParseRetryAfter(retryAfterHeader) : null;

    return c.Code switch
    {
      "personal_login_required" => new EnlittLoginRequiredException(message, requestId),
      "spending_limit_exceeded" => new EnlittLimitExceededException(message, c.LimitRule ?? string.Empty, requestId, c.AuthorizeUrl),
      "premium_balance_exhausted" or "standard_balance_exhausted" =>
          new EnlittInsufficientCreditsException(c.Code, message, requestId, c.AuthorizeUrl, c.AdmissibleMaxChargeNanoUsd),
      "subscription_inactive" => new EnlittSubscriptionInactiveException(message, requestId, c.AuthorizeUrl),
      "rate_limit_exceeded" => new EnlittRateLimitException(message, retryAfterMs, requestId),
      "invalid_api_key" => new EnlittAuthenticationException(message, requestId),
      "insufficient_permissions" or "premium_not_enabled" => new EnlittAuthorizationException(c.Code, message, requestId),
      _ => new EnlittException(c.Code, message, c.Retryable, retryAfterMs, requestId, c.AuthorizeUrl),
    };
  }

  /// <summary>A transport failure: the request never produced an HTTP response.</summary>
  internal static EnlittException Transport(string message, Exception? inner = null) =>
      new(EnlittException.TransportFailed, message, innerException: inner);

  /// <summary>A response that did not parse or had a wrongly typed known field.</summary>
  internal static EnlittException Malformed(string message, Exception? inner = null) =>
      new(EnlittException.MalformedResponse, message, innerException: inner);

  /// <summary>
  /// Port of <c>classifyEnlittErrorResponse(status, body)</c>: reads the OpenAI-shaped envelope, else the dashboard
  /// envelope, and returns null when the body is neither.
  /// </summary>
  internal static ClassifiedError? Classify(int status, JsonNode? body)
  {
    if (body is not JsonObject root || root["error"] is not JsonObject error)
    {
      return null;
    }

    if (error["message"] is not JsonValue messageValue || !messageValue.TryGetValue(out string? rawMessage))
    {
      return null;
    }

    string? type = null;
    if (error.ContainsKey("type"))
    {
      // OpenAI-shaped envelope: the type must be a string.
      if (error["type"] is not JsonValue typeValue || !typeValue.TryGetValue(out type))
      {
        return null;
      }
    }
    else if (error["code"] is not JsonValue dashboardCode || !dashboardCode.TryGetValue<string>(out _))
    {
      // Dashboard envelope: `{ error: { code, message }, request_id }` requires a string code.
      return null;
    }

    string? rawCode = error["code"] is JsonValue codeValue && codeValue.TryGetValue(out string? c) ? c : null;
    string code = rawCode is not null && CodePattern().IsMatch(rawCode) ? rawCode : EnlittContract.UnrecognizedErrorCode;
    bool recognized = EnlittContract.ErrorCodes.TryGetValue(code, out ErrorCodeInfo? info);

    bool creditRefusal;
    bool retryable;
    bool mayCarryUrl;
    if (recognized)
    {
      creditRefusal = info!.Type == "insufficient_credits_error";
      retryable = info.Retryable;
      mayCarryUrl = info.AuthorizeUrl == "allowed";
    }
    else
    {
      creditRefusal = type == "insufficient_credits_error"; // rule 1
      retryable = !creditRefusal && status is >= 500 and <= 599; // rules 2 and 3
      mayCarryUrl = creditRefusal;
    }

    JsonObject? enlitt = error["enlitt"] as JsonObject;

    string? authorizeUrl = null;
    if (mayCarryUrl && enlitt?["authorize_url"] is JsonValue urlValue && urlValue.TryGetValue(out string? url) && IsSafeNavigationUrl(url))
    {
      authorizeUrl = url;
    }

    string? admissible = null;
    if (recognized && info!.AdmissibleMaxCharge == "allowed"
        && enlitt?["admissible_max_charge_nano_usd"] is JsonValue admissibleValue
        && admissibleValue.TryGetValue(out string? admissibleText) && Nano.IsCanonical(admissibleText))
    {
      admissible = admissibleText;
    }

    string? limitRule = null;
    if (recognized && info!.LimitRule == "required")
    {
      if (enlitt?["limit_rule"] is JsonValue ruleValue && ruleValue.TryGetValue(out string? rule)
          && rule.Length is >= 1 and <= MaxLimitRuleLength)
      {
        limitRule = rule;
      }
      else
      {
        return null; // a missing or malformed required rule makes the envelope invalid
      }
    }

    string message = rawMessage.Length > MaxMessageLength ? rawMessage[..MaxMessageLength] : rawMessage;
    return new ClassifiedError(code, recognized, status, type, retryable, creditRefusal, message, authorizeUrl, admissible, limitRule);
  }

  /// <summary>True for an absolute https URL, or an http URL whose host is loopback.</summary>
  internal static bool IsSafeNavigationUrl(string value)
  {
    if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
    {
      return false;
    }

    return uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && TransportRules.IsLoopbackHost(uri.Host));
  }

  /// <summary>Converts a <c>Retry-After</c> header in whole seconds to milliseconds; an unparseable value is null, never zero.</summary>
  internal static int? ParseRetryAfter(string? header)
  {
    if (header is null || !long.TryParse(header.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out long seconds))
    {
      return null;
    }

    long ms = seconds * 1000;
    return ms > int.MaxValue ? int.MaxValue : (int)ms;
  }
}
