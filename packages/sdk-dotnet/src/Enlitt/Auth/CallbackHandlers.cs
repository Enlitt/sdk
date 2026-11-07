using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Enlitt.Auth;

/// <summary>A framework-neutral HTTP request, as the handlers read it.</summary>
public sealed class HandlerRequest
{
  private readonly Dictionary<string, string> _headers;

  /// <summary>Creates a request.</summary>
  /// <param name="method">The HTTP method.</param>
  /// <param name="url">The absolute request URL (path and query are read).</param>
  /// <param name="headers">The request headers; names are matched case-insensitively. Multiple values should be comma-joined, cookies "; "-joined.</param>
  /// <param name="body">The request body bytes, or null.</param>
  public HandlerRequest(string method, Uri url, IEnumerable<KeyValuePair<string, string>>? headers = null, byte[]? body = null)
  {
    Method = method.ToUpperInvariant();
    Url = url;
    _headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (KeyValuePair<string, string> header in headers ?? [])
    {
      _headers[header.Key] = header.Value;
    }

    Body = body ?? [];
  }

  /// <summary>The upper-case HTTP method.</summary>
  public string Method { get; }

  /// <summary>The absolute URL.</summary>
  public Uri Url { get; }

  /// <summary>The body bytes (empty when there was none).</summary>
  public byte[] Body { get; }

  /// <summary>Cancels in-flight work when the client disconnects.</summary>
  public CancellationToken CancellationToken { get; init; }

  /// <summary>Returns a header value, or null.</summary>
  /// <param name="name">The case-insensitive header name.</param>
  public string? Header(string name) => _headers.TryGetValue(name, out string? value) ? value : null;

  /// <summary>Returns a query parameter (the first when repeated), or null.</summary>
  /// <param name="name">The parameter name.</param>
  public string? Query(string name) => QueryString.Parse(Url.Query).TryGetValue(name, out List<string>? values) ? values[0] : null;

  /// <summary>All query parameters.</summary>
  internal IReadOnlyDictionary<string, List<string>> QueryAll => QueryString.Parse(Url.Query);
}

/// <summary>A framework-neutral HTTP response the handlers build; a hook may append headers before it is sent.</summary>
public sealed class HandlerResponse
{
  private readonly List<KeyValuePair<string, string>> _headers = [];

  /// <summary>The HTTP status.</summary>
  public int Status { get; set; }

  /// <summary>The response headers, repeatable (several <c>Set-Cookie</c> lines are separate entries).</summary>
  public IReadOnlyList<KeyValuePair<string, string>> Headers => _headers;

  /// <summary>The body bytes.</summary>
  public byte[] Body { get; set; } = [];

  /// <summary>Appends a header line; an existing header of the same name is kept.</summary>
  /// <param name="name">The header name.</param>
  /// <param name="value">The header value.</param>
  public void Append(string name, string value) => _headers.Add(new KeyValuePair<string, string>(name, value));

  /// <summary>Returns the first header value of that name (case-insensitive), or null.</summary>
  /// <param name="name">The header name.</param>
  public string? Get(string name) => _headers.FirstOrDefault(h => h.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Value;

  /// <summary>Returns every header value of that name (case-insensitive).</summary>
  /// <param name="name">The header name.</param>
  public IReadOnlyList<string> GetAll(string name) => _headers.Where(h => h.Key.Equals(name, StringComparison.OrdinalIgnoreCase)).Select(h => h.Value).ToList();

  /// <summary>The body as UTF-8 text.</summary>
  public string BodyText => Encoding.UTF8.GetString(Body);
}

/// <summary>A request handler: the neutral request in, the neutral response out.</summary>
/// <param name="request">The request.</param>
/// <returns>The response.</returns>
public delegate Task<HandlerResponse> EnlittHandler(HandlerRequest request);

/// <summary>The server-side login state: written at login-start, consumed exactly once at the callback.</summary>
/// <param name="ReturnTo">The validated onward path, if the login-start request named one.</param>
/// <param name="CreatedAt">Unix milliseconds.</param>
/// <param name="ExpiresAt">Unix milliseconds.</param>
public sealed record StateRecord(string? ReturnTo, long CreatedAt, long ExpiresAt);

/// <summary>The application-provided server-side login-state store. Multi-process deployments share it.</summary>
public interface IStateStore
{
  /// <summary>Stores <paramref name="record"/> under <paramref name="state"/> for <paramref name="ttl"/>.</summary>
  /// <param name="state">The state value.</param>
  /// <param name="record">The record.</param>
  /// <param name="ttl">How long the store keeps it.</param>
  Task SetAsync(string state, StateRecord record, TimeSpan ttl);

  /// <summary>Reads a record without removing it.</summary>
  /// <param name="state">The state value.</param>
  /// <returns>The record, or null.</returns>
  Task<StateRecord?> GetAsync(string state);

  /// <summary>Atomically reads and removes a record.</summary>
  /// <param name="state">The state value.</param>
  /// <returns>The record, or null when it is unknown, consumed or expired.</returns>
  Task<StateRecord?> ConsumeAsync(string state);
}

/// <summary>A single-process in-memory <see cref="IStateStore"/> for development and tests. It does not work across processes.</summary>
/// <param name="timeProvider">The clock; the system clock by default.</param>
public sealed class MemoryStateStore(TimeProvider? timeProvider = null) : IStateStore
{
  private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
  private readonly Dictionary<string, (StateRecord Record, DateTimeOffset Expires)> _items = [];
  private readonly object _gate = new();

  /// <inheritdoc />
  public Task SetAsync(string state, StateRecord record, TimeSpan ttl)
  {
    lock (_gate)
    {
      _items[state] = (record, _time.GetUtcNow() + ttl);
    }

    return Task.CompletedTask;
  }

  /// <inheritdoc />
  public Task<StateRecord?> GetAsync(string state)
  {
    lock (_gate)
    {
      return Task.FromResult(Live(state));
    }
  }

  /// <inheritdoc />
  public Task<StateRecord?> ConsumeAsync(string state)
  {
    lock (_gate)
    {
      StateRecord? record = Live(state);
      _items.Remove(state);
      return Task.FromResult(record);
    }
  }

  private StateRecord? Live(string state) =>
      _items.TryGetValue(state, out var entry) && entry.Expires > _time.GetUtcNow() ? entry.Record : null;
}

/// <summary>The verified identity passed to <see cref="CallbackConfig.OnSignIn"/>: only the application-scoped subject.</summary>
/// <param name="Subject">The application-scoped subject Enlitt returned from the exchange.</param>
public sealed record SignInIdentity(string Subject);

/// <summary>Configuration shared by the login-start, callback and logout handlers.</summary>
public sealed record CallbackConfig
{
  /// <summary>The application's public OAuth client ID.</summary>
  public required string ClientId { get; init; }

  /// <summary>The business secret; falls back to <c>ENLITT_SECRET_KEY</c>.</summary>
  public string? SecretKey { get; init; }

  /// <summary>The registered redirect URI, exactly.</summary>
  public required string RedirectUri { get; init; }

  /// <summary>The Enlitt dashboard origin the browser is sent to; defaults to <c>https://enlitt.com</c>.</summary>
  public string? EnlittOrigin { get; init; }

  /// <summary>The origin of the server-to-server exchange and revocation; defaults to <see cref="EnlittOrigin"/>.</summary>
  public string? EnlittApiOrigin { get; init; }

  /// <summary>The business's own origin; it bounds every redirect.</summary>
  public required string AppOrigin { get; init; }

  /// <summary>A path on <see cref="AppOrigin"/> used when no valid target is supplied.</summary>
  public required string DefaultReturnTo { get; init; }

  /// <summary>The session cookie name; defaults to <see cref="EnlittConstants.SessionCookieName"/>. Must equal the middleware's.</summary>
  public string? CookieName { get; init; }

  /// <summary>The server-side login-state store.</summary>
  public required IStateStore StateStore { get; init; }

  /// <summary>
  /// Runs once after a verified exchange and before the Enlitt cookie is appended. It may append its own cookie to the response.
  /// An exception propagates to the host unchanged.
  /// </summary>
  public Func<SignInIdentity, HandlerResponse, Task>? OnSignIn { get; init; }

  /// <summary>The clock for state timestamps; the system clock by default.</summary>
  public TimeProvider? TimeProvider { get; init; }

  /// <summary>Test seam: replaces the HTTP stack of the exchange and the revocation.</summary>
  internal TransportSeams? Seams { get; init; }
}

/// <summary>The three consumer-login handlers.</summary>
public static class CallbackHandlers
{
  private const string DefaultEnlittOrigin = "https://enlitt.com";
  private static readonly TimeSpan StateTtl = TimeSpan.FromMinutes(10);
  private const string StateAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  private static readonly Regex SubjectPattern = new("^[A-Za-z0-9_-]{1,255}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

  /// <summary>Creates the login-start handler: stores a fresh <c>state</c> and redirects to Enlitt's authorization endpoint.</summary>
  /// <param name="config">The configuration.</param>
  /// <returns>The handler.</returns>
  /// <exception cref="EnlittConfigurationException">The configuration is invalid.</exception>
  public static EnlittHandler CreateLoginStartHandler(CallbackConfig config)
  {
    Resolved c = Resolve(config);
    return async request =>
    {
      string? returnTo = ValidateReturnTo(request.Query("return_to"), c);
      string state = RandomNumberGenerator.GetString(StateAlphabet, 43);
      long now = c.Time.GetUtcNow().ToUnixTimeMilliseconds();
      await c.Config.StateStore.SetAsync(state, new StateRecord(returnTo, now, now + (long)StateTtl.TotalMilliseconds), StateTtl).ConfigureAwait(false);

      string location = $"{c.EnlittOrigin}/auth/oauth2/authorize"
              + $"?client_id={Uri.EscapeDataString(c.Config.ClientId)}"
              + $"&redirect_uri={Uri.EscapeDataString(c.Config.RedirectUri)}"
              + "&response_type=code"
              + $"&state={Uri.EscapeDataString(state)}";
      return See(location);
    };
  }

  /// <summary>Creates the callback handler: validates <c>state</c>, exchanges the code, sets the session cookie and redirects onward.</summary>
  /// <param name="config">The configuration.</param>
  /// <returns>The handler.</returns>
  /// <exception cref="EnlittConfigurationException">The configuration is invalid.</exception>
  public static EnlittHandler CreateCallbackHandler(CallbackConfig config)
  {
    Resolved c = Resolve(config);
    return async request =>
    {
      string? state = request.Query("state");
      StateRecord? record = string.IsNullOrEmpty(state) ? null : await c.Config.StateStore.ConsumeAsync(state).ConfigureAwait(false);
      if (record is null || record.ExpiresAt < c.Time.GetUtcNow().ToUnixTimeMilliseconds())
      {
        // No live record to trust: the default page, and nothing is exchanged.
        return See(c.AppOrigin + c.Config.DefaultReturnTo);
      }

      // A live record is consumed: every outcome below, signed out or not, goes to its own validated returnTo.
      string target = c.AppOrigin + (ValidateReturnTo(record.ReturnTo, c) ?? c.Config.DefaultReturnTo);
      string? code = request.Query("code");
      if (request.Query("error") is not null || string.IsNullOrEmpty(code))
      {
        return See(target);
      }

      (string Token, string Subject)? session = await ExchangeAsync(c, code, request.CancellationToken).ConfigureAwait(false);
      if (session is null)
      {
        return See(target);
      }

      HandlerResponse response = See(target);
      if (c.Config.OnSignIn is { } hook)
      {
        await hook(new SignInIdentity(session.Value.Subject), response).ConfigureAwait(false);
      }

      response.Append("Set-Cookie", SessionCookie(c.CookieName, session.Value.Token));
      return response;
    };
  }

  /// <summary>Creates the logout handler: revokes the session (best effort), clears the cookie and redirects.</summary>
  /// <param name="config">The configuration.</param>
  /// <returns>The handler; it accepts any method.</returns>
  /// <exception cref="EnlittConfigurationException">The configuration is invalid.</exception>
  public static EnlittHandler CreateLogoutHandler(CallbackConfig config)
  {
    Resolved c = Resolve(config);
    return async request =>
    {
      string? token = Cookies.Read(request.Header("Cookie"), c.CookieName);
      if (!string.IsNullOrEmpty(token))
      {
        await RevokeAsync(c, token, request.CancellationToken).ConfigureAwait(false);
      }

      HandlerResponse response = See(c.AppOrigin + (ValidateReturnTo(request.Query("return_to"), c) ?? c.Config.DefaultReturnTo));
      response.Append("Set-Cookie", ClearedCookie(c.CookieName));
      return response;
    };
  }

  /// <summary>The <c>Set-Cookie</c> value that clears the session cookie.</summary>
  internal static string ClearedCookie(string name) => $"{name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

  private static string SessionCookie(string name, string token) =>
      $"{name}={Uri.EscapeDataString(token)}; Path=/; HttpOnly; Secure; SameSite=Lax";

  /// <summary>A 303 with <c>Cache-Control: no-store</c>; every handler response has this shape.</summary>
  internal static HandlerResponse See(string location)
  {
    var response = new HandlerResponse { Status = 303 };
    response.Append("Location", location);
    response.Append("Cache-Control", "no-store");
    return response;
  }

  /// <summary>The configuration with every default applied and every check made.</summary>
  internal sealed record Resolved(
      CallbackConfig Config,
      string CookieName,
      string AppOrigin,
      string EnlittOrigin,
      string ApiOrigin,
      string Authorization,
      TimeProvider Time);

  internal static Resolved Resolve(CallbackConfig config)
  {
    ArgumentNullException.ThrowIfNull(config);
    if (string.IsNullOrWhiteSpace(config.ClientId))
    {
      throw new EnlittConfigurationException("ClientId is required.");
    }

    string appOrigin = Origin(config.AppOrigin, "AppOrigin");
    string enlittOrigin = Origin(config.EnlittOrigin ?? DefaultEnlittOrigin, "EnlittOrigin");
    string apiOrigin = config.EnlittApiOrigin is null ? enlittOrigin : Origin(config.EnlittApiOrigin, "EnlittApiOrigin");

    if (!Uri.TryCreate(config.RedirectUri, UriKind.Absolute, out Uri? redirect)
        || !(redirect.Scheme == Uri.UriSchemeHttps || (redirect.Scheme == Uri.UriSchemeHttp && TransportRules.IsLoopbackHost(redirect.Host)))
        || redirect.Fragment.Length > 0)
    {
      throw new EnlittConfigurationException("RedirectUri must be an absolute https URL (http only for loopback) with no fragment.");
    }

    if (!IsSafePath(config.DefaultReturnTo))
    {
      throw new EnlittConfigurationException("DefaultReturnTo must be a path on AppOrigin starting with a single '/'.");
    }

    if (config.StateStore is null)
    {
      throw new EnlittConfigurationException("StateStore is required.");
    }

    string cookieName = string.IsNullOrEmpty(config.CookieName) ? EnlittConstants.SessionCookieName : config.CookieName;
    return new Resolved(
        config,
        cookieName,
        appOrigin,
        enlittOrigin,
        apiOrigin,
        Secrets.ResolveBusinessAuthorizationHeader(config.SecretKey),
        config.TimeProvider ?? TimeProvider.System);
  }

  private static string Origin(string value, string name)
  {
    if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
        || !(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && TransportRules.IsLoopbackHost(uri.Host)))
        || (uri.AbsolutePath != "/" && uri.AbsolutePath.Length > 0) || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
    {
      throw new EnlittConfigurationException($"{name} must be an https origin (http only for loopback) with no path.");
    }

    return uri.GetLeftPart(UriPartial.Authority);
  }

  /// <summary>A path on the app: one leading slash, not scheme-relative, no backslash or control character.</summary>
  private static bool IsSafePath(string? value) =>
      !string.IsNullOrEmpty(value) && value[0] == '/' && !value.StartsWith("//", StringComparison.Ordinal)
      && !value.Contains('\\') && !value.Any(char.IsControl);

  /// <summary>
  /// Validates an onward target: it must resolve to a path on the app's own origin, with no scheme-relative form,
  /// backslash, control character or (once decoded) traversal segment. Returns null when it is not acceptable.
  /// </summary>
  internal static string? ValidateReturnTo(string? raw, Resolved c)
  {
    if (!IsSafePath(raw))
    {
      return null;
    }

    string decoded;
    try
    {
      decoded = Uri.UnescapeDataString(raw!);
    }
    catch (UriFormatException)
    {
      return null;
    }

    if (!IsSafePath(decoded) || decoded.Split('?')[0].Split('/').Contains(".."))
    {
      return null;
    }

    if (!Uri.TryCreate(new Uri(c.AppOrigin), raw, out Uri? resolved) || resolved.GetLeftPart(UriPartial.Authority) != c.AppOrigin)
    {
      return null;
    }

    return resolved.PathAndQuery;
  }

  private static async Task<(string Token, string Subject)?> ExchangeAsync(Resolved c, string code, CancellationToken cancellationToken)
  {
    try
    {
      using HttpRequestMessage message = new(HttpMethod.Post, c.ApiOrigin + "/auth/oauth2/token")
      {
        Content = new FormUrlEncodedContent(
          [
              KeyValuePair.Create("grant_type", "authorization_code"),
                    KeyValuePair.Create("code", code),
                    KeyValuePair.Create("redirect_uri", c.Config.RedirectUri),
                    KeyValuePair.Create("client_id", c.Config.ClientId),
                ]),
      };
      message.Headers.TryAddWithoutValidation("Authorization", c.Authorization);
      message.Headers.TryAddWithoutValidation("Accept", "application/json");
      message.Headers.TryAddWithoutValidation(EnlittContract.VersionHeader, EnlittContract.ApiVersion);

      using HttpResponseMessage response = await InternalClient.HttpFor(c.Config.Seams).SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
      if (response.StatusCode != HttpStatusCode.OK)
      {
        return null;
      }

      string text = await InternalClient.ReadTextAsync(response, 1 << 20, cancellationToken).ConfigureAwait(false);
      var body = WireShapes.ReadBody(WireShapes.CodeExchange, text, "code exchange response");
      string token = body["session_token"]!.GetValue<string>();
      string subject = body["subject"]!.GetValue<string>();
      return EnlittSession.IsValidToken(token) && SubjectPattern.IsMatch(subject) ? (token, subject) : null;
    }
    catch (Exception ex) when (ex is EnlittException or HttpRequestException or IOException)
    {
      // Any failed exchange is a signed-out outcome; nothing about it reaches a URL, log or body.
      return null;
    }
  }

  internal static async Task RevokeAsync(Resolved c, string token, CancellationToken cancellationToken)
  {
    try
    {
      using HttpRequestMessage message = new(HttpMethod.Post, c.ApiOrigin + "/auth/oauth2/revoke")
      {
        Content = new FormUrlEncodedContent([KeyValuePair.Create("token", token), KeyValuePair.Create("client_id", c.Config.ClientId)]),
      };
      message.Headers.TryAddWithoutValidation("Authorization", c.Authorization);
      message.Headers.TryAddWithoutValidation(EnlittContract.VersionHeader, EnlittContract.ApiVersion);
      using HttpResponseMessage response = await InternalClient.HttpFor(c.Config.Seams).SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is HttpRequestException or IOException or EnlittException)
    {
      // The outcome is the same either way: the cookie is cleared regardless.
    }
  }
}

/// <summary>Query-string and cookie parsing shared by the handlers.</summary>
internal static class QueryString
{
  /// <summary>Parses a <c>?a=b&amp;c=d</c> string (or a form body) into decoded lists.</summary>
  internal static Dictionary<string, List<string>> Parse(string query)
  {
    var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
    foreach (string pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
    {
      int eq = pair.IndexOf('=');
      string key = Decode(eq < 0 ? pair : pair[..eq]);
      string value = eq < 0 ? string.Empty : Decode(pair[(eq + 1)..]);
      if (!result.TryGetValue(key, out List<string>? list))
      {
        result[key] = list = [];
      }

      list.Add(value);
    }

    return result;
  }

  private static string Decode(string value)
  {
    try
    {
      return Uri.UnescapeDataString(value.Replace('+', ' '));
    }
    catch (UriFormatException)
    {
      return value;
    }
  }
}

/// <summary>Cookie header parsing.</summary>
internal static class Cookies
{
  /// <summary>Reads one cookie from a <c>Cookie</c> header; returns null when absent or empty. The value is percent-decoded.</summary>
  internal static string? Read(string? header, string name)
  {
    if (string.IsNullOrEmpty(header))
    {
      return null;
    }

    foreach (string part in header.Split(';'))
    {
      string trimmed = part.Trim();
      int eq = trimmed.IndexOf('=');
      if (eq > 0 && trimmed[..eq] == name)
      {
        string value = trimmed[(eq + 1)..];
        try
        {
          value = Uri.UnescapeDataString(value);
        }
        catch (UriFormatException)
        {
          // Keep the raw value; the session bound check decides whether it is usable.
        }

        return value.Length == 0 ? null : value;
      }
    }

    return null;
  }
}
