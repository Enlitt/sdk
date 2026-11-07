using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Enlitt.Auth;

namespace Enlitt.Tests;

/// <summary>The client sign-in handoff: start, complete, token, pairing and logout.</summary>
public class ClientSignInTests
{
  private const string App = "https://app.test";
  private const string Base = "/enlitt/signin";

  private sealed class Rig
  {
    public ManualTime Time { get; } = new();

    public StubHandler Enlitt { get; } = new(request =>
        request.Path.EndsWith("/revoke", StringComparison.Ordinal)
            ? StubHandler.Reply(200, "{}")
            : StubHandler.Reply(200, """{"session_token":"tok_live_1","subject":"user_1"}"""));

    public MemoryClientSignInStore Store { get; }

    public CallbackConfig Callback { get; }

    public Rig()
    {
      Store = new MemoryClientSignInStore(Time);
      Callback = new CallbackConfig
      {
        ClientId = "client_1",
        SecretKey = Kit.Secret,
        RedirectUri = App + "/enlitt/callback",
        EnlittOrigin = "https://enlitt.test",
        EnlittApiOrigin = "https://api.enlitt.test",
        AppOrigin = App,
        DefaultReturnTo = "/home",
        StateStore = new MemoryStateStore(Time),
        TimeProvider = Time,
        Seams = Kit.Seams(Enlitt),
      };
    }

    public ClientSignInConfig Config(bool loopback = true, string[]? returnUrls = null, bool pairing = false) => new()
    {
      Callback = Callback,
      BasePath = Base,
      AppName = "Demo <App>",
      Loopback = loopback,
      ReturnUrls = returnUrls ?? [],
      Pairing = pairing,
      Store = Store,
    };

    public EnlittHandler Handler(ClientSignInConfig? config = null) => ClientSignIn.CreateHandler(config ?? Config());

    public EnlittHandler Callbacks => CallbackHandlers.CreateCallbackHandler(Callback);

    /// <summary>Runs start and the Enlitt callback, and returns the response of "complete".</summary>
    public async Task<HandlerResponse> CompleteAsync(EnlittHandler handler, string startQuery, bool signedIn = true)
    {
      HandlerResponse start = await handler(Get($"{Base}/start?{startQuery}"));
      Assert.Equal(303, start.Status);
      string state = System.Web.HttpUtility.ParseQueryString(new Uri(start.Get("Location")!).Query)["state"]!;

      HandlerResponse callback = await Callbacks(Get(signedIn ? $"/enlitt/callback?code=abc&state={state}" : $"/enlitt/callback?error=access_denied&state={state}"));
      string complete = new Uri(callback.Get("Location")!).PathAndQuery;
      string? cookie = signedIn ? "enlitt_session=tok_live_1" : null;
      return await handler(Get(complete, cookie));
    }
  }

  private static HandlerRequest Get(string pathAndQuery, string? cookie = null) =>
      new("GET", new Uri(App + pathAndQuery), cookie is null ? null : [KeyValuePair.Create("Cookie", cookie)]);

  private static HandlerRequest PostJson(string path, JsonObject body) =>
      new("POST", new Uri(App + path), [KeyValuePair.Create("Content-Type", "application/json")], Encoding.UTF8.GetBytes(body.ToJsonString()));

  private static (string Verifier, string Challenge) Pkce()
  {
    string verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
    return (verifier, Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))));
  }

  private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

  private static string LoopbackQuery(string challenge, int port = 51234, string state = "client-state-1") =>
      $"mode=loopback&state={state}&code_challenge={challenge}&code_challenge_method=S256&port={port}";

  private static JsonObject Json(HandlerResponse response) => JsonNode.Parse(response.Body)!.AsObject();

  private static string CodeOf(HandlerResponse complete) =>
      System.Web.HttpUtility.ParseQueryString(new Uri(complete.Get("Location")!).Query)["code"]!;

  // ---- construction ---------------------------------------------------------------------------------------------

  public static IEnumerable<object[]> BadConfigs() =>
  [
      ["base-slash", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { BasePath = "/x/" })],
        ["base-empty", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { BasePath = "" })],
        ["base-query", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { BasePath = "/x?y" })],
        ["no-name", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { AppName = "" })],
        ["long-name", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { AppName = new string('a', 61) })],
        ["http-return", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { ReturnUrls = ["http://app.test/cb"] })],
        ["js-return", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { ReturnUrls = ["javascript:alert(1)"] })],
        ["fragment-return", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { ReturnUrls = ["https://app.test/cb#x"] })],
        ["upper-scheme", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { ReturnUrls = ["Com.Example.app://cb"] })],
        ["no-dot-scheme", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { ReturnUrls = ["myapp://cb"] })],
        ["nothing-enabled", (Func<ClientSignInConfig, ClientSignInConfig>)(c => c with { Loopback = false })],
    ];

  [Theory]
  [MemberData(nameof(BadConfigs))]
  public void InvalidConfigurationIsRefusedAtConstruction(string name, Func<ClientSignInConfig, ClientSignInConfig> change)
  {
    Assert.NotNull(name);
    Assert.Throws<EnlittConfigurationException>(() => ClientSignIn.CreateHandler(change(new Rig().Config())));
  }

  [Fact]
  public void PrivateUseAndHttpsReturnUrlsAreAccepted()
  {
    var rig = new Rig();
    _ = ClientSignIn.CreateHandler(rig.Config(loopback: false, returnUrls: ["com.example.app://signin", "https://app.test/mobile"]));
  }

  // ---- routing ------------------------------------------------------------------------------------------------

  [Fact]
  public async Task UnknownPathsAre404AndWrongMethodsAre405()
  {
    EnlittHandler handler = new Rig().Handler();
    Assert.Equal(404, (await handler(Get("/elsewhere"))).Status);
    Assert.Equal(404, (await handler(Get($"{Base}/nope"))).Status);
    Assert.Equal(405, (await handler(new HandlerRequest("POST", new Uri(App + Base + "/start")))).Status);
    Assert.Equal(405, (await handler(Get($"{Base}/token"))).Status);
  }

  [Fact]
  public async Task PairingRoutesAre404WhenPairingIsOff()
  {
    EnlittHandler handler = new Rig().Handler();
    Assert.Equal(404, (await handler(Get($"{Base}/pair"))).Status);
    Assert.Equal(404, (await handler(PostJson($"{Base}/pairing", new JsonObject()))).Status);
  }

  // ---- start --------------------------------------------------------------------------------------------------

  public static IEnumerable<object[]> BadStarts()
  {
    string c = Pkce().Challenge;
    yield return [""];
    yield return ["mode=other&state=s&code_challenge=" + c + "&code_challenge_method=S256&port=51234"];
    yield return [$"mode=loopback&state=s&code_challenge={c}&code_challenge_method=plain&port=51234"];
    yield return [$"mode=loopback&state=s&code_challenge=short&code_challenge_method=S256&port=51234"];
    yield return [$"mode=loopback&state=s&code_challenge={c}&code_challenge_method=S256&port=80"];
    yield return [$"mode=loopback&state=s&code_challenge={c}&code_challenge_method=S256&port=70000"];
    yield return [$"mode=loopback&state=s&code_challenge={c}&code_challenge_method=S256&port=051234"];
    yield return [$"mode=loopback&state=s&code_challenge={c}&code_challenge_method=S256&port=51234&extra=1"];
    yield return [$"mode=loopback&state=s&state=t&code_challenge={c}&code_challenge_method=S256&port=51234"];
    yield return [$"mode=loopback&state=bad%20state&code_challenge={c}&code_challenge_method=S256&port=51234"];
    yield return [$"mode=redirect&state=s&code_challenge={c}&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fevil.test%2Fcb"];
  }

  [Theory]
  [MemberData(nameof(BadStarts))]
  public async Task InvalidStartIsAn400PageWithNoRedirect(string query)
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(Get($"{Base}/start?{query}"));
    Assert.Equal(400, response.Status);
    Assert.Null(response.Get("Location"));
  }

  [Fact]
  public async Task LoopbackStartIsRefusedWhenLoopbackIsOff()
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler(rig.Config(loopback: false, pairing: true))(Get($"{Base}/start?{LoopbackQuery(Pkce().Challenge)}"));
    Assert.Equal(400, response.Status);
  }

  [Fact]
  public async Task ValidStartRedirectsToEnlittLoginAndClearsTheCookie()
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(Get($"{Base}/start?{LoopbackQuery(Pkce().Challenge)}"));
    Assert.Equal(303, response.Status);
    Assert.StartsWith("https://enlitt.test/auth/oauth2/authorize?", response.Get("Location"));
    Assert.StartsWith("enlitt_session=;", Assert.Single(response.GetAll("Set-Cookie")));
  }

  // ---- loopback flow ------------------------------------------------------------------------------------------

  [Fact]
  public async Task FullLoopbackFlowGivesTheSessionTokenOnceThroughTheTokenEndpoint()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    (string verifier, string challenge) = Pkce();

    HandlerResponse complete = await rig.CompleteAsync(handler, LoopbackQuery(challenge, 51234, "client-state-1"));

    Assert.Equal(303, complete.Status);
    var target = new Uri(complete.Get("Location")!);
    Assert.Equal("http://127.0.0.1:51234/callback", target.GetLeftPart(UriPartial.Path));
    Assert.Equal("client-state-1", System.Web.HttpUtility.ParseQueryString(target.Query)["state"]);
    Assert.DoesNotContain("tok_live_1", complete.Get("Location"));
    Assert.StartsWith("enlitt_session=;", Assert.Single(complete.GetAll("Set-Cookie")));

    string code = CodeOf(complete);
    var body = new JsonObject { ["grant_type"] = "code", ["code"] = code, ["code_verifier"] = verifier };
    HandlerResponse token = await handler(PostJson($"{Base}/token", body));
    Assert.Equal(200, token.Status);
    Assert.Equal("tok_live_1", Json(token)["session_token"]!.GetValue<string>());
    Assert.Equal("no-store", token.Get("Cache-Control"));

    // The code is single use.
    HandlerResponse again = await handler(PostJson($"{Base}/token", body));
    Assert.Equal(400, again.Status);
    Assert.Equal("invalid_grant", Json(again)["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task AWrongVerifierIsRefusedAndStillSpendsTheCode()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    (string verifier, string challenge) = Pkce();
    string code = CodeOf(await rig.CompleteAsync(handler, LoopbackQuery(challenge)));

    HandlerResponse wrong = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "code", ["code"] = code, ["code_verifier"] = Pkce().Verifier }));
    Assert.Equal("invalid_grant", Json(wrong)["error"]!.GetValue<string>());

    HandlerResponse right = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "code", ["code"] = code, ["code_verifier"] = verifier }));
    Assert.Equal(400, right.Status);
  }

  [Fact]
  public async Task ACodeExpiresAfterFiveMinutes()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    (string verifier, string challenge) = Pkce();
    string code = CodeOf(await rig.CompleteAsync(handler, LoopbackQuery(challenge)));
    rig.Time.Advance(TimeSpan.FromMinutes(5) + TimeSpan.FromSeconds(1));
    HandlerResponse response = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "code", ["code"] = code, ["code_verifier"] = verifier }));
    Assert.Equal("invalid_grant", Json(response)["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task ASignedOutCompleteReturnsAccessDeniedWithTheClientState()
  {
    var rig = new Rig();
    HandlerResponse complete = await rig.CompleteAsync(rig.Handler(), LoopbackQuery(Pkce().Challenge, 51234, "st-9"), signedIn: false);
    var target = new Uri(complete.Get("Location")!);
    var query = System.Web.HttpUtility.ParseQueryString(target.Query);
    Assert.Equal("access_denied", query["error"]);
    Assert.Equal("st-9", query["state"]);
    Assert.Null(query["code"]);
  }

  [Fact]
  public async Task ACompleteLinkWorksOnlyOnce()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    HandlerResponse start = await handler(Get($"{Base}/start?{LoopbackQuery(Pkce().Challenge)}"));
    string state = System.Web.HttpUtility.ParseQueryString(new Uri(start.Get("Location")!).Query)["state"]!;
    HandlerResponse callback = await rig.Callbacks(Get($"/enlitt/callback?code=abc&state={state}"));
    string complete = new Uri(callback.Get("Location")!).PathAndQuery;

    Assert.Equal(303, (await handler(Get(complete, "enlitt_session=tok_live_1"))).Status);
    HandlerResponse second = await handler(Get(complete, "enlitt_session=tok_live_1"));
    Assert.Equal(400, second.Status);
    Assert.StartsWith("enlitt_session=;", Assert.Single(second.GetAll("Set-Cookie")));
  }

  [Fact]
  public async Task AnExpiredHandoffIsRefused()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    HandlerResponse start = await handler(Get($"{Base}/start?{LoopbackQuery(Pkce().Challenge)}"));
    string state = System.Web.HttpUtility.ParseQueryString(new Uri(start.Get("Location")!).Query)["state"]!;
    HandlerResponse callback = await rig.Callbacks(Get($"/enlitt/callback?code=abc&state={state}"));
    rig.Time.Advance(TimeSpan.FromMinutes(11));
    HandlerResponse complete = await handler(Get(new Uri(callback.Get("Location")!).PathAndQuery, "enlitt_session=tok_live_1"));
    Assert.Equal(400, complete.Status);
  }

  [Fact]
  public async Task RedirectModeReturnsToTheRegisteredUrl()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(returnUrls: ["com.example.app://signin"]));
    (string verifier, string challenge) = Pkce();
    string uri = Uri.EscapeDataString("com.example.app://signin");
    HandlerResponse complete = await rig.CompleteAsync(handler, $"mode=redirect&state=s1&code_challenge={challenge}&code_challenge_method=S256&redirect_uri={uri}");

    Assert.StartsWith("com.example.app://signin?code=", complete.Get("Location"));
    HandlerResponse token = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "code", ["code"] = CodeOf(complete), ["code_verifier"] = verifier }));
    Assert.Equal(200, token.Status);
  }

  // ---- token endpoint -----------------------------------------------------------------------------------------

  [Theory]
  [InlineData("""{"grant_type":"code","code":"x","code_verifier":"short"}""")]
  [InlineData("""{"grant_type":"nope","code_verifier":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}""")]
  [InlineData("""{"grant_type":"code","code":"x","code_verifier":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","extra":1}""")]
  [InlineData("[]")]
  public async Task MalformedTokenRequestsAreInvalidRequest(string body)
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(new HandlerRequest("POST", new Uri(App + Base + "/token"), [KeyValuePair.Create("Content-Type", "application/json")], Encoding.UTF8.GetBytes(body)));
    Assert.Equal(400, response.Status);
    Assert.Equal("invalid_request", Json(response)["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task ATokenRequestWithoutJsonContentTypeIsInvalid()
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(new HandlerRequest("POST", new Uri(App + Base + "/token"), null, "{}"u8.ToArray()));
    Assert.Equal("invalid_request", Json(response)["error"]!.GetValue<string>());
  }

  // ---- pairing ------------------------------------------------------------------------------------------------

  private static async Task<(JsonObject Created, string Verifier)> CreatePairing(EnlittHandler handler)
  {
    (string verifier, string challenge) = Pkce();
    HandlerResponse created = await handler(PostJson($"{Base}/pairing", new JsonObject { ["code_challenge"] = challenge, ["code_challenge_method"] = "S256" }));
    Assert.Equal(200, created.Status);
    return (Json(created), verifier);
  }

  private static async Task<(string Csrf, string Cookie)> PairForm(EnlittHandler handler)
  {
    HandlerResponse form = await handler(Get($"{Base}/pair"));
    string cookie = Assert.Single(form.GetAll("Set-Cookie"));
    Assert.Contains("HttpOnly", cookie);
    Assert.Contains("SameSite=Strict", cookie);
    string csrf = cookie.Split(';')[0].Split('=')[1];
    return (csrf, $"enlitt_pair_csrf={csrf}");
  }

  private static HandlerRequest PairPost(string form, string? cookie, string? origin = null)
  {
    var headers = new List<KeyValuePair<string, string>> { KeyValuePair.Create("Content-Type", "application/x-www-form-urlencoded") };
    if (cookie is not null)
    {
      headers.Add(KeyValuePair.Create("Cookie", cookie));
    }

    if (origin is not null)
    {
      headers.Add(KeyValuePair.Create("Origin", origin));
    }

    return new HandlerRequest("POST", new Uri(App + Base + "/pair"), headers, Encoding.UTF8.GetBytes(form));
  }

  [Fact]
  public async Task PairingCodeUsesTheUnambiguousAlphabetAndPendingUntilConfirmed()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (JsonObject created, string verifier) = await CreatePairing(handler);

    string userCode = created["user_code"]!.GetValue<string>();
    Assert.Matches("^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$", userCode);
    Assert.Equal(App + Base + "/pair", created["verification_uri"]!.GetValue<string>());
    Assert.Equal(600, created["expires_in"]!.GetValue<int>());

    HandlerResponse pending = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "pairing", ["pairing_id"] = created["pairing_id"]!.GetValue<string>(), ["code_verifier"] = verifier }));
    Assert.Equal("authorization_pending", Json(pending)["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task PairPostNeedsTheCsrfCookieAndASameOrigin()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (string csrf, string cookie) = await PairForm(handler);

    Assert.Equal(403, (await handler(PairPost($"csrf={csrf}&user_code=BBBB-BBBB", null))).Status);
    Assert.Equal(403, (await handler(PairPost($"csrf=other&user_code=BBBB-BBBB", cookie))).Status);
    Assert.Equal(403, (await handler(PairPost($"csrf={csrf}&user_code=BBBB-BBBB", cookie, "https://evil.test"))).Status);
  }

  [Fact]
  public async Task AnUnknownUserCodeShowsTheFormAgain()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (string csrf, string cookie) = await PairForm(handler);
    HandlerResponse response = await handler(PairPost($"csrf={csrf}&user_code=BBBB-BBBB", cookie));
    Assert.Equal(200, response.Status);
    Assert.Contains("not valid or has expired", response.BodyText);
  }

  [Fact]
  public async Task FullPairingFlowDeliversTheTokenOnce()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (JsonObject created, string verifier) = await CreatePairing(handler);
    string pairingId = created["pairing_id"]!.GetValue<string>();
    string typed = created["user_code"]!.GetValue<string>().ToLowerInvariant();
    (string csrf, string cookie) = await PairForm(handler);

    // Confirmation page: escapes the app name and warns about unsolicited codes.
    HandlerResponse confirm = await handler(PairPost($"csrf={csrf}&user_code={typed}", cookie));
    Assert.Equal(200, confirm.Status);
    Assert.Contains("Demo &lt;App&gt;", confirm.BodyText);
    Assert.DoesNotContain("<App>", confirm.BodyText);
    Assert.Contains(created["user_code"]!.GetValue<string>(), confirm.BodyText);
    Assert.Contains("do not continue", confirm.BodyText);
    Assert.Equal("DENY", confirm.Get("X-Frame-Options"));
    Assert.Contains("frame-ancestors 'none'", confirm.Get("Content-Security-Policy"));

    // Continue: the browser is sent through Enlitt login, then back to "complete".
    HandlerResponse go = await handler(PairPost($"csrf={csrf}&user_code={typed}&action=confirm", cookie));
    Assert.Equal(303, go.Status);
    string state = System.Web.HttpUtility.ParseQueryString(new Uri(go.Get("Location")!).Query)["state"]!;
    HandlerResponse callback = await rig.Callbacks(Get($"/enlitt/callback?code=abc&state={state}"));
    HandlerResponse done = await handler(Get(new Uri(callback.Get("Location")!).PathAndQuery, "enlitt_session=tok_live_1"));
    Assert.Equal(200, done.Status);
    Assert.DoesNotContain("tok_live_1", done.BodyText);

    var grant = new JsonObject { ["grant_type"] = "pairing", ["pairing_id"] = pairingId, ["code_verifier"] = verifier };
    HandlerResponse token = await handler(PostJson($"{Base}/token", grant));
    Assert.Equal(200, token.Status);
    Assert.Equal("tok_live_1", Json(token)["session_token"]!.GetValue<string>());
    Assert.Equal("invalid_grant", Json(await handler(PostJson($"{Base}/token", grant)))["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task CancellingAPairingGivesAccessDenied()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (JsonObject created, string verifier) = await CreatePairing(handler);
    (string csrf, string cookie) = await PairForm(handler);
    await handler(PairPost($"csrf={csrf}&user_code={created["user_code"]!.GetValue<string>()}&action=cancel", cookie));
    HandlerResponse token = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "pairing", ["pairing_id"] = created["pairing_id"]!.GetValue<string>(), ["code_verifier"] = verifier }));
    Assert.Equal("access_denied", Json(token)["error"]!.GetValue<string>());
  }

  [Fact]
  public async Task AnExpiredPairingGivesExpiredToken()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    (JsonObject created, string verifier) = await CreatePairing(handler);
    rig.Time.Advance(TimeSpan.FromMinutes(11));
    HandlerResponse token = await handler(PostJson($"{Base}/token", new JsonObject { ["grant_type"] = "pairing", ["pairing_id"] = created["pairing_id"]!.GetValue<string>(), ["code_verifier"] = verifier }));
    Assert.Contains(Json(token)["error"]!.GetValue<string>(), new[] { "expired_token", "invalid_grant" });
  }

  [Fact]
  public async Task PairingRequestsWithExtraFieldsAreRefused()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler(rig.Config(pairing: true));
    HandlerResponse response = await handler(PostJson($"{Base}/pairing", new JsonObject { ["code_challenge"] = Pkce().Challenge, ["code_challenge_method"] = "S256", ["x"] = 1 }));
    Assert.Equal(400, response.Status);
  }

  // ---- logout and secrecy -------------------------------------------------------------------------------------

  [Fact]
  public async Task LogoutRevokesTheHeaderTokenAndAnswers204()
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(new HandlerRequest("POST", new Uri(App + Base + "/logout"), [KeyValuePair.Create("Enlitt-Session", "tok_live_1")]));
    Assert.Equal(204, response.Status);
    Assert.Contains("token=tok_live_1", Assert.Single(rig.Enlitt.Requests).Body);
  }

  [Fact]
  public async Task LogoutIs204EvenWhenRevocationFails()
  {
    var rig = new Rig();
    EnlittHandler handler = new Rig().Handler();
    _ = rig;
    var failing = new Rig();
    var config = failing.Config() with
    {
      Callback = failing.Callback with { Seams = Kit.Seams(new StubHandler(_ => throw new HttpRequestException("down"))) },
    };
    HandlerResponse response = await ClientSignIn.CreateHandler(config)(new HandlerRequest("POST", new Uri(App + Base + "/logout"), [KeyValuePair.Create("Enlitt-Session", "tok")]));
    Assert.Equal(204, response.Status);
    Assert.NotNull(handler);
  }

  [Fact]
  public async Task LogoutWithoutAHeaderIs204AndMakesNoRequest()
  {
    var rig = new Rig();
    HandlerResponse response = await rig.Handler()(new HandlerRequest("POST", new Uri(App + Base + "/logout")));
    Assert.Equal(204, response.Status);
    Assert.Empty(rig.Enlitt.Requests);
  }

  [Fact]
  public async Task NoResponseOrStoredRecordLeaksTheSessionToken()
  {
    var rig = new Rig();
    EnlittHandler handler = rig.Handler();
    HandlerResponse complete = await rig.CompleteAsync(handler, LoopbackQuery(Pkce().Challenge));
    Assert.DoesNotContain("tok_live_1", string.Join("|", complete.Headers.Select(h => h.Value)));
    Assert.DoesNotContain("tok_live_1", complete.BodyText);
  }
}
