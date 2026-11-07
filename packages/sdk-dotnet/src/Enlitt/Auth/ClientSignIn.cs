using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Enlitt.Auth;

/// <summary>
/// The server-side store of the client sign-in handoff. Values are opaque strings; the handler owns their format.
/// Multi-process deployments must share it, like the login-state store.
/// </summary>
public interface IClientSignInStore
{
  /// <summary>Stores <paramref name="value"/> under <paramref name="key"/>, overwriting, for <paramref name="ttl"/>.</summary>
  /// <param name="key">The record key.</param>
  /// <param name="value">The opaque value.</param>
  /// <param name="ttl">How long the store keeps it.</param>
  Task SetAsync(string key, string value, TimeSpan ttl);

  /// <summary>Reads a value without removing it.</summary>
  /// <param name="key">The record key.</param>
  /// <returns>The value, or null.</returns>
  Task<string?> GetAsync(string key);

  /// <summary>Atomically reads and removes a value.</summary>
  /// <param name="key">The record key.</param>
  /// <returns>The value, or null when it is unknown, consumed or expired.</returns>
  Task<string?> ConsumeAsync(string key);
}

/// <summary>A single-process in-memory <see cref="IClientSignInStore"/> for development and tests. It does not work across processes.</summary>
/// <param name="timeProvider">The clock; the system clock by default.</param>
public sealed class MemoryClientSignInStore(TimeProvider? timeProvider = null) : IClientSignInStore
{
  private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
  private readonly Dictionary<string, (string Value, DateTimeOffset Expires)> _items = [];
  private readonly object _gate = new();

  /// <inheritdoc />
  public Task SetAsync(string key, string value, TimeSpan ttl)
  {
    lock (_gate)
    {
      _items[key] = (value, _time.GetUtcNow() + ttl);
    }

    return Task.CompletedTask;
  }

  /// <inheritdoc />
  public Task<string?> GetAsync(string key)
  {
    lock (_gate)
    {
      return Task.FromResult(Live(key));
    }
  }

  /// <inheritdoc />
  public Task<string?> ConsumeAsync(string key)
  {
    lock (_gate)
    {
      string? value = Live(key);
      _items.Remove(key);
      return Task.FromResult(value);
    }
  }

  private string? Live(string key) =>
      _items.TryGetValue(key, out var entry) && entry.Expires > _time.GetUtcNow() ? entry.Value : null;
}

/// <summary>Configuration of the client sign-in handoff handler.</summary>
public sealed record ClientSignInConfig
{
  /// <summary>The same configuration the login-start, callback and logout handlers are mounted with.</summary>
  public required CallbackConfig Callback { get; init; }

  /// <summary>The path on <see cref="CallbackConfig.AppOrigin"/> the handler serves, such as <c>/enlitt/client</c>; no trailing slash.</summary>
  public required string BasePath { get; init; }

  /// <summary>The application's name (1-60 characters), shown on the pairing pages.</summary>
  public required string AppName { get; init; }

  /// <summary>Whether the loopback mode is enabled. Default true.</summary>
  public bool Loopback { get; init; } = true;

  /// <summary>Exact deep-link targets the redirect mode may use. Default empty.</summary>
  public IReadOnlyList<string> ReturnUrls { get; init; } = [];

  /// <summary>Whether the pairing (device code) mode is enabled. Default false.</summary>
  public bool Pairing { get; init; }

  /// <summary>The server-side handoff store.</summary>
  public required IClientSignInStore Store { get; init; }
}

/// <summary>The business-hosted client sign-in handoff (PROTOCOLS "Client sign-in handoff").</summary>
public static class ClientSignIn
{
  private const string UserCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";
  private const string CsrfCookie = "enlitt_pair_csrf";
  private const int MaxBodyBytes = 16 * 1024;
  private static readonly TimeSpan HandoffTtl = TimeSpan.FromMinutes(10);
  private static readonly TimeSpan CodeTtl = TimeSpan.FromMinutes(5);
  private static readonly TimeSpan PairingTtl = TimeSpan.FromMinutes(10);
  private static readonly Regex StatePattern = new("^[A-Za-z0-9._~-]{1,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
  private static readonly Regex VerifierPattern = new("^[A-Za-z0-9._~-]{43,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
  private static readonly Regex ChallengePattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
  private static readonly Regex IdPattern = ChallengePattern;
  private static readonly Regex PortPattern = new("^[1-9][0-9]{3,4}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
  private static readonly string[] ForbiddenSchemes = ["http", "javascript", "data", "file", "vbscript"];

  /// <summary>Creates the handler. It serves every path under <see cref="ClientSignInConfig.BasePath"/> and answers 404 for any other.</summary>
  /// <param name="config">The configuration.</param>
  /// <returns>The handler; mount it with one catch-all route.</returns>
  /// <exception cref="EnlittConfigurationException">The configuration is invalid.</exception>
  public static EnlittHandler CreateHandler(ClientSignInConfig config)
  {
    ArgumentNullException.ThrowIfNull(config);
    CallbackHandlers.Resolved callback = CallbackHandlers.Resolve(config.Callback);
    ValidateConfig(config);
    return new Handler(config, callback).HandleAsync;
  }

  private static void ValidateConfig(ClientSignInConfig config)
  {
    string basePath = config.BasePath;
    if (string.IsNullOrEmpty(basePath) || basePath[0] != '/' || basePath.EndsWith('/') || basePath.Contains('?') || basePath.Contains('#'))
    {
      throw new EnlittConfigurationException("BasePath must start with '/', must not end with '/', and must contain no '?' or '#'.");
    }

    if (string.IsNullOrEmpty(config.AppName) || config.AppName.Length > 60)
    {
      throw new EnlittConfigurationException("AppName must be 1-60 characters.");
    }

    foreach (string url in config.ReturnUrls)
    {
      if (!IsAllowedReturnUrl(url))
      {
        throw new EnlittConfigurationException(
            "Each ReturnUrls entry must be an absolute URL without a fragment: https, or a lowercase reverse-DNS private-use scheme (not http, javascript, data, file or vbscript).");
      }
    }

    if (!config.Loopback && config.ReturnUrls.Count == 0 && !config.Pairing)
    {
      throw new EnlittConfigurationException("Enable at least one of Loopback, ReturnUrls or Pairing.");
    }
  }

  private static bool IsAllowedReturnUrl(string url)
  {
    if (string.IsNullOrEmpty(url) || url.Contains('#') || !Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
    {
      return false;
    }

    // The scheme as written (Uri lower-cases its own copy), so "Com.Example" is refused rather than silently fixed.
    string written = url[..url.IndexOf(':')];
    if (written == "https")
    {
      return uri.Host.Length > 0;
    }

    return written == written.ToLowerInvariant()
        && written.Contains('.')
        && !ForbiddenSchemes.Contains(written)
        && written.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '-' or '+');
  }

  /// <summary>One configured handler: the routes and their per-request state.</summary>
  private sealed class Handler(ClientSignInConfig config, CallbackHandlers.Resolved callback)
  {
    private readonly IClientSignInStore _store = config.Store;
    private readonly EnlittHandler _loginStart = CallbackHandlers.CreateLoginStartHandler(config.Callback);
    private readonly EnlittHandler _logout = CallbackHandlers.CreateLogoutHandler(config.Callback);
    private readonly string _base = config.BasePath;
    private TimeProvider Time => callback.Time;

    public async Task<HandlerResponse> HandleAsync(HandlerRequest request)
    {
      string path = request.Url.AbsolutePath;
      if (!path.StartsWith(_base + "/", StringComparison.Ordinal))
      {
        return Plain(404, "Not found.");
      }

      string route = path[(_base.Length + 1)..];
      return route switch
      {
        "start" => await Only(request, "GET", StartAsync).ConfigureAwait(false),
        "complete" => await Only(request, "GET", CompleteAsync).ConfigureAwait(false),
        "token" => await Only(request, "POST", TokenAsync).ConfigureAwait(false),
        "logout" => await Only(request, "POST", LogoutAsync).ConfigureAwait(false),
        "pairing" when config.Pairing => await Only(request, "POST", PairingAsync).ConfigureAwait(false),
        "pair" when config.Pairing => request.Method switch
        {
          "GET" => PairForm(null),
          "POST" => await PairPostAsync(request).ConfigureAwait(false),
          _ => Plain(405, "Method not allowed."),
        },
        _ => Plain(404, "Not found."),
      };
    }

    private static async Task<HandlerResponse> Only(HandlerRequest request, string method, Func<HandlerRequest, Task<HandlerResponse>> route) =>
        request.Method == method ? await route(request).ConfigureAwait(false) : Plain(405, "Method not allowed.");

    // ---- start ----------------------------------------------------------------------------------------------

    private async Task<HandlerResponse> StartAsync(HandlerRequest request)
    {
      IReadOnlyDictionary<string, List<string>> query = request.QueryAll;
      string? Single(string name) => query.TryGetValue(name, out List<string>? v) && v.Count == 1 ? v[0] : null;

      string? mode = Single("mode");
      string? state = Single("state");
      string? challenge = Single("code_challenge");
      string[] expected = mode switch
      {
        "loopback" => ["mode", "state", "code_challenge", "code_challenge_method", "port"],
        "redirect" => ["mode", "state", "code_challenge", "code_challenge_method", "redirect_uri"],
        _ => [],
      };

      // Exactly the expected fields, each once: an unknown, missing or repeated field refuses the request.
      if (expected.Length == 0 || query.Count != expected.Length || expected.Any(name => Single(name) is null))
      {
        return BadStart();
      }

      if (state is null || !StatePattern.IsMatch(state) || challenge is null || !ChallengePattern.IsMatch(challenge) || Single("code_challenge_method") != "S256")
      {
        return BadStart();
      }

      var target = new JsonObject { ["mode"] = mode };
      if (mode == "loopback")
      {
        string port = Single("port")!;
        if (!config.Loopback || !PortPattern.IsMatch(port) || int.Parse(port, System.Globalization.CultureInfo.InvariantCulture) is < 1024 or > 65535)
        {
          return BadStart();
        }

        target["port"] = int.Parse(port, System.Globalization.CultureInfo.InvariantCulture);
      }
      else
      {
        string redirectUri = Single("redirect_uri")!;
        if (!config.ReturnUrls.Contains(redirectUri, StringComparer.Ordinal))
        {
          return BadStart();
        }

        target["redirectUri"] = redirectUri;
      }

      var handoff = new JsonObject { ["target"] = target, ["state"] = state, ["codeChallenge"] = challenge };
      return await BeginLoginAsync(handoff, request.CancellationToken).ConfigureAwait(false);
    }

    private static HandlerResponse BadStart() =>
        Html(400, "Sign-in request invalid", "<p>This sign-in request is not valid. Go back to the app and try again.</p>");

    /// <summary>Writes the handoff and starts the business login, clearing any session cookie this browser already holds.</summary>
    private async Task<HandlerResponse> BeginLoginAsync(JsonObject handoff, CancellationToken cancellationToken)
    {
      string id = RandomId();
      await _store.SetAsync("h:" + id, handoff.ToJsonString(), HandoffTtl).ConfigureAwait(false);

      // Clearing the cookie guarantees any session seen at "complete" was minted by this very sign-in.
      string returnTo = $"{_base}/complete?h={id}";
      var inner = new HandlerRequest("GET", new Uri(callback.AppOrigin + _base + "/login?return_to=" + Uri.EscapeDataString(returnTo))) { CancellationToken = cancellationToken };
      HandlerResponse response = await _loginStart(inner).ConfigureAwait(false);
      response.Append("Set-Cookie", CallbackHandlers.ClearedCookie(callback.CookieName));
      return response;
    }

    // ---- complete -------------------------------------------------------------------------------------------

    private async Task<HandlerResponse> CompleteAsync(HandlerRequest request)
    {
      string clear = CallbackHandlers.ClearedCookie(callback.CookieName);
      string? id = request.Query("h");
      string? raw = id is not null && IdPattern.IsMatch(id) ? await _store.ConsumeAsync("h:" + id).ConfigureAwait(false) : null;
      JsonObject? handoff = Json.ParseObject(raw);
      HandlerResponse response;
      if (handoff is null)
      {
        response = Html(400, "Link expired", "<p>This sign-in link has expired. Go back to the app and try again.</p>");
        response.Append("Set-Cookie", clear);
        return response;
      }

      string? token = Cookies.Read(request.Header("Cookie"), callback.CookieName);
      if (token is not null && !EnlittSession.IsValidToken(token))
      {
        token = null;
      }

      JsonObject target = handoff["target"]!.AsObject();
      string? state = handoff["state"]?.GetValue<string>();
      string mode = target["mode"]!.GetValue<string>();

      if (mode == "pairing")
      {
        response = await CompletePairingAsync(target["pairingId"]!.GetValue<string>(), token).ConfigureAwait(false);
      }
      else
      {
        string baseUrl = mode == "loopback"
            ? $"http://127.0.0.1:{target["port"]!.GetValue<int>()}/callback"
            : target["redirectUri"]!.GetValue<string>();
        string query;
        if (token is null)
        {
          query = "error=access_denied&state=" + Uri.EscapeDataString(state!);
        }
        else
        {
          string code = RandomId();
          var codeRecord = new JsonObject { ["sessionToken"] = token, ["codeChallenge"] = handoff["codeChallenge"]!.GetValue<string>() };
          await _store.SetAsync("c:" + code, codeRecord.ToJsonString(), CodeTtl).ConfigureAwait(false);
          query = "code=" + code + "&state=" + Uri.EscapeDataString(state!);
        }

        response = CallbackHandlers.See(baseUrl + (baseUrl.Contains('?') ? '&' : '?') + query);
      }

      // The token now belongs to the client; the browser must not keep a second copy.
      response.Append("Set-Cookie", clear);
      return response;
    }

    private async Task<HandlerResponse> CompletePairingAsync(string pairingId, string? token)
    {
      JsonObject? pairing = Json.ParseObject(await _store.GetAsync("p:" + pairingId).ConfigureAwait(false));
      long left = pairing is null ? 0 : pairing["expiresAt"]!.GetValue<long>() - Time.GetUtcNow().ToUnixTimeMilliseconds();
      if (pairing is null || left <= 0)
      {
        return Html(400, "Link expired", "<p>This sign-in link has expired. Go back to the app and try again.</p>");
      }

      if (token is null)
      {
        pairing["status"] = "denied";
        await _store.SetAsync("p:" + pairingId, pairing.ToJsonString(), TimeSpan.FromMilliseconds(left)).ConfigureAwait(false);
        return Html(200, "Sign-in cancelled", "<p>Sign-in cancelled. You can go back to your other device and try again.</p>");
      }

      pairing["status"] = "ready";
      pairing["sessionToken"] = token;
      await _store.SetAsync("p:" + pairingId, pairing.ToJsonString(), TimeSpan.FromMilliseconds(left)).ConfigureAwait(false);
      return Html(200, "Signed in", "<p>Signed in. You can go back to your other device.</p>");
    }

    // ---- pairing --------------------------------------------------------------------------------------------

    private async Task<HandlerResponse> PairingAsync(HandlerRequest request)
    {
      JsonObject? body = ReadJsonBody(request);
      if (body is null || !HasExactly(body, "code_challenge", "code_challenge_method")
          || !Str(body, "code_challenge", out string? challenge) || !ChallengePattern.IsMatch(challenge!)
          || !Str(body, "code_challenge_method", out string? method) || method != "S256")
      {
        return TokenError("invalid_request");
      }

      string pairingId = RandomId();
      string userCode;
      do
      {
        // GetString draws by rejection sampling, so every letter is equally likely.
        userCode = RandomNumberGenerator.GetString(UserCodeAlphabet, 8);
      }
      while (await _store.GetAsync("u:" + userCode).ConfigureAwait(false) is not null);

      long expiresAt = Time.GetUtcNow().ToUnixTimeMilliseconds() + (long)PairingTtl.TotalMilliseconds;
      var pairing = new JsonObject { ["status"] = "pending", ["codeChallenge"] = challenge, ["userCode"] = userCode, ["expiresAt"] = expiresAt };
      await _store.SetAsync("p:" + pairingId, pairing.ToJsonString(), PairingTtl).ConfigureAwait(false);
      await _store.SetAsync("u:" + userCode, pairingId, PairingTtl).ConfigureAwait(false);

      return JsonResponse(200, new JsonObject
      {
        ["pairing_id"] = pairingId,
        ["user_code"] = userCode[..4] + "-" + userCode[4..],
        ["verification_uri"] = callback.AppOrigin + _base + "/pair",
        ["expires_in"] = 600,
        ["interval"] = 5,
      });
    }

    // ---- pair (HTML) ----------------------------------------------------------------------------------------

    private HandlerResponse PairForm(string? message)
    {
      string csrf = RandomId();
      string notice = message is null ? string.Empty : $"<p class=\"error\">{Esc(message)}</p>";
      HandlerResponse response = Html(200, "Enter your code", $"{notice}<p>Enter the code shown on your other device.</p>"
          + $"<form method=\"post\" action=\"{Esc(_base)}/pair\">"
          + $"<input type=\"hidden\" name=\"csrf\" value=\"{csrf}\">"
          + "<input name=\"user_code\" autocomplete=\"off\" autocapitalize=\"characters\" maxlength=\"16\" required>"
          + "<button type=\"submit\">Next</button></form>");
      response.Append("Set-Cookie", $"{CsrfCookie}={csrf}; Path={_base}; HttpOnly; Secure; SameSite=Strict");
      return response;
    }

    private async Task<HandlerResponse> PairPostAsync(HandlerRequest request)
    {
      string? origin = request.Header("Origin");
      if (origin is not null && origin != callback.AppOrigin)
      {
        return Plain(403, "Forbidden.");
      }

      if (request.Body.Length > MaxBodyBytes)
      {
        return Plain(400, "Bad request.");
      }

      Dictionary<string, List<string>> form = QueryString.Parse(Encoding.UTF8.GetString(request.Body));
      string? Field(string name) => form.TryGetValue(name, out List<string>? v) ? v[0] : null;

      // Double-submit check: the form value must equal the cookie, compared in constant time.
      string? cookie = Cookies.Read(request.Header("Cookie"), CsrfCookie);
      string? csrf = Field("csrf");
      if (cookie is null || csrf is null || !SameSecret(cookie, csrf))
      {
        return Plain(403, "Forbidden.");
      }

      string typed = new(Normalize(Field("user_code")).ToArray());
      string? pairingId = typed.Length == 8 ? await _store.GetAsync("u:" + typed).ConfigureAwait(false) : null;
      JsonObject? pairing = pairingId is null ? null : Json.ParseObject(await _store.GetAsync("p:" + pairingId).ConfigureAwait(false));
      if (pairing is null || pairing["status"]!.GetValue<string>() != "pending")
      {
        return PairForm("That code is not valid or has expired.");
      }

      string action = Field("action") ?? string.Empty;
      if (action == "cancel")
      {
        pairing["status"] = "denied";
        long left = Math.Max(1000, pairing["expiresAt"]!.GetValue<long>() - Time.GetUtcNow().ToUnixTimeMilliseconds());
        await _store.SetAsync("p:" + pairingId, pairing.ToJsonString(), TimeSpan.FromMilliseconds(left)).ConfigureAwait(false);
        return Html(200, "Sign-in cancelled", "<p>Sign-in cancelled. You can go back to your other device.</p>");
      }

      if (action == "confirm")
      {
        var handoff = new JsonObject
        {
          ["target"] = new JsonObject { ["mode"] = "pairing", ["pairingId"] = pairingId },
          ["codeChallenge"] = pairing["codeChallenge"]!.GetValue<string>(),
        };
        return await BeginLoginAsync(handoff, request.CancellationToken).ConfigureAwait(false);
      }

      string shown = typed[..4] + "-" + typed[4..];
      return Html(200, "Confirm sign-in",
          $"<p>Sign in to {Esc(config.AppName)} on another device?</p>"
          + $"<p class=\"code\">{shown}</p>"
          + "<p>Only continue if this code is on a screen in front of you right now. If someone sent you this code, do not continue — they are trying to use your account.</p>"
          + $"<form method=\"post\" action=\"{Esc(_base)}/pair\">"
          + $"<input type=\"hidden\" name=\"csrf\" value=\"{Esc(csrf)}\">"
          + $"<input type=\"hidden\" name=\"user_code\" value=\"{shown}\">"
          + "<button type=\"submit\" name=\"action\" value=\"confirm\">Continue</button> "
          + "<button type=\"submit\" name=\"action\" value=\"cancel\">Cancel</button></form>");
    }

    /// <summary>Upper-cases the input and drops every character that is not a letter.</summary>
    private static IEnumerable<char> Normalize(string? input) =>
        (input ?? string.Empty).ToUpperInvariant().Where(ch => ch is >= 'A' and <= 'Z');

    // ---- token ----------------------------------------------------------------------------------------------

    private async Task<HandlerResponse> TokenAsync(HandlerRequest request)
    {
      JsonObject? body = ReadJsonBody(request);
      if (body is null || !Str(body, "grant_type", out string? grant) || !Str(body, "code_verifier", out string? verifier) || !VerifierPattern.IsMatch(verifier!))
      {
        return TokenError("invalid_request");
      }

      if (grant == "code" && HasExactly(body, "grant_type", "code", "code_verifier") && Str(body, "code", out string? code))
      {
        string? raw = IdPattern.IsMatch(code!) ? await _store.ConsumeAsync("c:" + code).ConfigureAwait(false) : null;
        JsonObject? record = Json.ParseObject(raw);
        return record is not null && ChallengeMatches(verifier!, record["codeChallenge"]!.GetValue<string>())
            ? TokenSuccess(record["sessionToken"]!.GetValue<string>())
            : TokenError("invalid_grant");
      }

      if (grant == "pairing" && HasExactly(body, "grant_type", "pairing_id", "code_verifier") && Str(body, "pairing_id", out string? pairingId))
      {
        return await PairingGrantAsync(pairingId!, verifier!).ConfigureAwait(false);
      }

      return TokenError("invalid_request");
    }

    private async Task<HandlerResponse> PairingGrantAsync(string pairingId, string verifier)
    {
      if (!IdPattern.IsMatch(pairingId))
      {
        return TokenError("invalid_grant");
      }

      JsonObject? pairing = Json.ParseObject(await _store.GetAsync("p:" + pairingId).ConfigureAwait(false));
      if (pairing is null)
      {
        return TokenError("invalid_grant");
      }

      if (pairing["expiresAt"]!.GetValue<long>() <= Time.GetUtcNow().ToUnixTimeMilliseconds())
      {
        await _store.ConsumeAsync("p:" + pairingId).ConfigureAwait(false);
        return TokenError("expired_token");
      }

      switch (pairing["status"]!.GetValue<string>())
      {
        case "pending":
          return TokenError("authorization_pending");
        case "denied":
          await _store.ConsumeAsync("p:" + pairingId).ConfigureAwait(false);
          return TokenError("access_denied");
        case "ready":
          // Consume first: a wrong verifier still spends the pairing.
          JsonObject? taken = Json.ParseObject(await _store.ConsumeAsync("p:" + pairingId).ConfigureAwait(false));
          await _store.ConsumeAsync("u:" + pairing["userCode"]!.GetValue<string>()).ConfigureAwait(false);
          return taken is not null && ChallengeMatches(verifier, taken["codeChallenge"]!.GetValue<string>())
              ? TokenSuccess(taken["sessionToken"]!.GetValue<string>())
              : TokenError("invalid_grant");
        default:
          return TokenError("invalid_grant");
      }
    }

    private static bool ChallengeMatches(string verifier, string storedChallenge)
    {
      string computed = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
      return SameSecret(computed, storedChallenge);
    }

    // ---- logout ---------------------------------------------------------------------------------------------

    private async Task<HandlerResponse> LogoutAsync(HandlerRequest request)
    {
      string? token = request.Header(EnlittConstants.SessionHeaderName);
      if (!string.IsNullOrEmpty(token) && EnlittSession.IsValidToken(token))
      {
        // One revocation implementation: the cookie logout handler does it, and its redirect is discarded.
        var inner = new HandlerRequest(
            "POST",
            new Uri(callback.AppOrigin + _base + "/logout"),
            [KeyValuePair.Create("Cookie", $"{callback.CookieName}={Uri.EscapeDataString(token)}")])
        {
          CancellationToken = request.CancellationToken,
        };
        await _logout(inner).ConfigureAwait(false);
      }

      var response = new HandlerResponse { Status = 204 };
      response.Append("Cache-Control", "no-store");
      return response;
    }

    // ---- helpers --------------------------------------------------------------------------------------------

    private JsonObject? ReadJsonBody(HandlerRequest request)
    {
      string? type = request.Header("Content-Type");
      if (type is null || !type.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) || request.Body.Length > MaxBodyBytes)
      {
        return null;
      }

      try
      {
        return JsonNode.Parse(request.Body) as JsonObject;
      }
      catch (JsonException)
      {
        return null;
      }
    }

    private static bool HasExactly(JsonObject body, params string[] names) =>
        body.Count == names.Length && names.All(body.ContainsKey);

    private static bool Str(JsonObject body, string name, out string? value)
    {
      value = body[name] is JsonValue v && v.TryGetValue(out string? s) ? s : null;
      return value is not null;
    }

    private static bool SameSecret(string a, string b) =>
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    /// <summary>32 random bytes as 43 base64url characters.</summary>
    private static string RandomId() => Base64Url(RandomNumberGenerator.GetBytes(32));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string Esc(string value) => WebUtility.HtmlEncode(value);

    private static HandlerResponse TokenSuccess(string token) => JsonResponse(200, new JsonObject { ["session_token"] = token });

    private static HandlerResponse TokenError(string error) => JsonResponse(400, new JsonObject { ["error"] = error });

    private static HandlerResponse JsonResponse(int status, JsonObject body)
    {
      var response = new HandlerResponse { Status = status, Body = Encoding.UTF8.GetBytes(body.ToJsonString()) };
      response.Append("Content-Type", "application/json");
      response.Append("Cache-Control", "no-store");
      return response;
    }

    private static HandlerResponse Plain(int status, string text) => Html(status, text, $"<p>{Esc(text)}</p>");

    /// <summary>An HTML page with the hardening headers every page carries.</summary>
    private static HandlerResponse Html(int status, string title, string body)
    {
      string page = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
          + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
          + $"<title>{Esc(title)}</title>"
          + "<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}"
          + ".code{font-size:2rem;letter-spacing:.2em;font-weight:600}.error{color:#b00020}button{font-size:1rem;padding:.5rem 1rem}</style>"
          + $"</head><body>{body}</body></html>";
      var response = new HandlerResponse { Status = status, Body = Encoding.UTF8.GetBytes(page) };
      response.Append("Content-Type", "text/html; charset=utf-8");
      response.Append("Cache-Control", "no-store");
      response.Append("X-Frame-Options", "DENY");
      response.Append("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
      response.Append("Referrer-Policy", "no-referrer");
      return response;
    }
  }

  private static class Json
  {
    /// <summary>Parses a stored record; null for a missing value.</summary>
    internal static JsonObject? ParseObject(string? raw) => raw is null ? null : JsonNode.Parse(raw) as JsonObject;
  }
}
