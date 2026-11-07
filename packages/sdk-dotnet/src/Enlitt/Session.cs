namespace Enlitt;

/// <summary>Well-known names and values shared by the SDK, the session middleware and the login handlers.</summary>
public static class EnlittConstants
{
  /// <summary>The canonical session cookie name and the default of <c>CookieName</c> everywhere a cookie is read or written.</summary>
  public const string SessionCookieName = "enlitt_session";

  /// <summary>The request header that carries a session token from a client with no cookie jar.</summary>
  public const string SessionHeaderName = "Enlitt-Session";

  /// <summary>The only standard model string.</summary>
  public const string StandardModel = "enlitt-standard";

  /// <summary>The wire API version this build was written against.</summary>
  public static string ApiVersion => EnlittContract.ApiVersion;
}

/// <summary>
/// An opaque handle around Enlitt's session token. The token is never parsed, decoded or inspected by the SDK,
/// and <see cref="ToString"/> never reveals it.
/// </summary>
public sealed class EnlittSession
{
  /// <summary>The longest token the SDK accepts.</summary>
  internal const int MaxTokenLength = 4096;

  private readonly string _token;

  /// <summary>Wraps a token Enlitt issued (or one the business stored itself).</summary>
  /// <param name="token">The opaque session token; must be non-empty, at most 4096 characters, and free of control characters.</param>
  /// <exception cref="EnlittConfigurationException">The token is empty, too long or contains control characters.</exception>
  public EnlittSession(string token)
  {
    if (!IsValidToken(token))
    {
      throw new EnlittConfigurationException("An Enlitt session token must be a non-empty string of at most 4096 characters with no control characters.");
    }

    _token = token;
  }

  /// <summary>The raw token, for the transport only. Not public: nothing outside the SDK may need it.</summary>
  internal string Token => _token;

  /// <summary>True when <paramref name="token"/> passes the bound check the constructor applies.</summary>
  internal static bool IsValidToken(string? token) =>
      !string.IsNullOrEmpty(token) && token.Length <= MaxTokenLength && !token.Any(char.IsControl);

  /// <summary>Returns <c>EnlittSession(&lt;redacted&gt;)</c>; the token is never printed.</summary>
  public override string ToString() => "EnlittSession(<redacted>)";
}

/// <summary>
/// The ambient session context. It has three distinct states: no context at all (a deployment bug), a context holding
/// null (a signed-out visitor) and a context holding a session.
/// </summary>
internal static class SessionContext
{
  private sealed class Holder(EnlittSession? session)
  {
    internal EnlittSession? Session { get; } = session;
  }

  private static readonly AsyncLocal<Holder?> Current = new();

  /// <summary>Runs <paramref name="fn"/> with <paramref name="session"/> as the ambient session and restores the previous state afterwards.</summary>
  internal static Task<T> RunAsync<T>(EnlittSession? session, Func<Task<T>> fn)
  {
    Holder? previous = Current.Value;
    Current.Value = new Holder(session);
    try
    {
      return fn();
    }
    finally
    {
      // The async callee captured its own execution context at its first await, so restoring here
      // only affects the caller; the callee keeps seeing the session for its whole lifetime.
      Current.Value = previous;
    }
  }

  /// <summary>Reads the ambient session; throws when there is no context at all.</summary>
  internal static EnlittSession? Get() =>
      Current.Value is { } holder
          ? holder.Session
          : throw new EnlittConfigurationException(
              "No Enlitt session context: install the session middleware (UseEnlittSession) on this path, or pass a session explicitly.");

  /// <summary>
  /// Resolves the session for one request: the explicit session when given, else the ambient one.
  /// No context throws a configuration failure; a context holding null throws login-required.
  /// </summary>
  internal static EnlittSession Resolve(EnlittSession? explicitSession)
  {
    if (explicitSession is not null)
    {
      return explicitSession;
    }

    return Get() ?? throw new EnlittLoginRequiredException("No signed-in Enlitt user for this request. Send the user through Enlitt login.");
  }
}
