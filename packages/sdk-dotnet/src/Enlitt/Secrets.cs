namespace Enlitt;

/// <summary>
/// Resolves the business secret. Exactly one function formats the authorization header, it is internal, and the
/// raw secret is never returned, logged or placed in an error.
/// </summary>
internal static class Secrets
{
  private const string EnvironmentVariable = "ENLITT_SECRET_KEY";

  /// <summary>
  /// Resolves the explicit key ahead of <c>ENLITT_SECRET_KEY</c> and returns exactly one <c>Bearer &lt;secret&gt;</c> header value.
  /// </summary>
  /// <exception cref="EnlittConfigurationException">No usable secret is configured.</exception>
  internal static string ResolveBusinessAuthorizationHeader(string? secretKey)
  {
    string? secret = !string.IsNullOrWhiteSpace(secretKey) ? secretKey : Environment.GetEnvironmentVariable(EnvironmentVariable);
    secret = secret?.Trim();

    if (string.IsNullOrEmpty(secret))
    {
      throw new EnlittConfigurationException("No Enlitt business secret: pass SecretKey or set the ENLITT_SECRET_KEY environment variable.");
    }

    // A secret with whitespace or control characters can never be valid and would break the header.
    if (secret.Any(ch => ch <= ' ' || ch > '~'))
    {
      throw new EnlittConfigurationException("The Enlitt business secret contains characters that cannot be part of a key.");
    }

    return "Bearer " + secret;
  }
}
