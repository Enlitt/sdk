using Enlitt.Auth;

namespace Enlitt.Tests;

/// <summary>The cookie sign-in handlers: login start, callback, logout.</summary>
public class AuthTests
{
  private const string App = "https://app.test";

  /// <summary>A wired-up callback config over a stub that plays Enlitt's token and revoke endpoints.</summary>
  private sealed class Rig
  {
    public ManualTime Time { get; } = new();

    public MemoryStateStore Store { get; }

    public StubHandler Enlitt { get; }

    public Func<RecordedRequest, HttpResponseMessage> Respond { get; set; } = request =>
        request.Path.EndsWith("/revoke", StringComparison.Ordinal)
            ? StubHandler.Reply(200, "{}")
            : StubHandler.Reply(200, """{"session_token":"tok_live_1","subject":"user_1","future_field":1}""");

    public Rig()
    {
      Store = new MemoryStateStore(Time);
      Enlitt = new StubHandler(request => Respond(request));
    }

    public CallbackConfig Config(Func<SignInIdentity, HandlerResponse, Task>? onSignIn = null, string? cookieName = null) => new()
    {
      ClientId = "client_1",
      SecretKey = Kit.Secret,
      RedirectUri = App + "/enlitt/callback",
      EnlittOrigin = "https://enlitt.test",
      EnlittApiOrigin = "https://api.enlitt.test",
      AppOrigin = App,
      DefaultReturnTo = "/home",
      CookieName = cookieName,
      StateStore = Store,
      TimeProvider = Time,
      OnSignIn = onSignIn,
      Seams = Kit.Seams(Enlitt),
    };

    /// <summary>Starts a login and returns the state it issued.</summary>
    public async Task<string> StartAsync(CallbackConfig config, string? returnTo = null)
    {
      string query = returnTo is null ? string.Empty : "?return_to=" + Uri.EscapeDataString(returnTo);
      HandlerResponse start = await CallbackHandlers.CreateLoginStartHandler(config)(Get("/enlitt/login" + query));
      return StateOf(start);
    }
  }

  private static HandlerRequest Get(string pathAndQuery, string? cookie = null) =>
      new("GET", new Uri(App + pathAndQuery), cookie is null ? null : [KeyValuePair.Create("Cookie", cookie)]);

  private static string StateOf(HandlerResponse start)
  {
    var location = new Uri(start.Get("Location")!);
    return System.Web.HttpUtility.ParseQueryString(location.Query)["state"]!;
  }

  [Fact]
  public async Task LoginStartRedirectsToTheAuthorizeEndpointWithAFreshState()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    EnlittHandler start = CallbackHandlers.CreateLoginStartHandler(config);

    HandlerResponse a = await start(Get("/enlitt/login"));
    HandlerResponse b = await start(Get("/enlitt/login"));

    Assert.Equal(303, a.Status);
    Assert.Equal("no-store", a.Get("Cache-Control"));
    var location = new Uri(a.Get("Location")!);
    Assert.Equal("https://enlitt.test/auth/oauth2/authorize", location.GetLeftPart(UriPartial.Path));
    var query = System.Web.HttpUtility.ParseQueryString(location.Query);
    Assert.Equal("client_1", query["client_id"]);
    Assert.Equal(App + "/enlitt/callback", query["redirect_uri"]);
    Assert.Equal("code", query["response_type"]);
    Assert.NotEqual(StateOf(a), StateOf(b));
    Assert.Equal(43, StateOf(a).Length);
  }

  [Fact]
  public async Task SuccessfulCallbackSetsExactlyOneSecureCookieAndPutsNoTokenInAnyUrl()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, "/dashboard?tab=1");

    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));

    Assert.Equal(303, response.Status);
    Assert.Equal(App + "/dashboard?tab=1", response.Get("Location"));
    string cookie = Assert.Single(response.GetAll("Set-Cookie"));
    Assert.StartsWith("enlitt_session=tok_live_1;", cookie);
    Assert.Contains("HttpOnly", cookie);
    Assert.Contains("Secure", cookie);
    Assert.Contains("SameSite=Lax", cookie);
    Assert.Contains("Path=/", cookie);
    Assert.DoesNotContain("tok_live_1", response.Get("Location"));

    RecordedRequest exchange = Assert.Single(rig.Enlitt.Requests);
    Assert.Equal("https://api.enlitt.test/auth/oauth2/token", exchange.Uri.ToString());
    Assert.Equal("Bearer " + Kit.Secret, exchange.Header("Authorization"));
    Assert.Equal(EnlittContract.ApiVersion, exchange.Header(EnlittContract.VersionHeader));
    Assert.Contains("grant_type=authorization_code", exchange.Body);
    Assert.Contains("code=abc", exchange.Body);
    Assert.Contains("client_id=client_1", exchange.Body);
  }

  [Fact]
  public async Task ACustomCookieNameIsUsed()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config(cookieName: "my_session");
    string state = await rig.StartAsync(config);
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.StartsWith("my_session=", Assert.Single(response.GetAll("Set-Cookie")));
  }

  [Theory]
  [InlineData("missing")]
  [InlineData("unknown")]
  [InlineData("expired")]
  public async Task BadStateIsRefusedBeforeAnyExchangeWithNoCookie(string kind)
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, "/dashboard");
    string query = kind switch
    {
      "missing" => "code=abc",
      "unknown" => "code=abc&state=nope",
      _ => $"code=abc&state={state}",
    };
    if (kind == "expired")
    {
      rig.Time.Advance(TimeSpan.FromMinutes(11));
    }

    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get("/enlitt/callback?" + query));

    Assert.Equal(App + "/home", response.Get("Location"));
    Assert.Empty(response.GetAll("Set-Cookie"));
    Assert.Empty(rig.Enlitt.Requests);
  }

  [Fact]
  public async Task AReplayedStateIsRefused()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, "/dashboard");
    EnlittHandler callback = CallbackHandlers.CreateCallbackHandler(config);

    await callback(Get($"/enlitt/callback?code=abc&state={state}"));
    HandlerResponse replay = await callback(Get($"/enlitt/callback?code=abc&state={state}"));

    Assert.Equal(App + "/home", replay.Get("Location"));
    Assert.Empty(replay.GetAll("Set-Cookie"));
    Assert.Single(rig.Enlitt.Requests);
  }

  [Fact]
  public async Task AStateFromAnotherStoreIsForeignAndRefused()
  {
    var rig = new Rig();
    var other = new Rig();
    string foreign = await other.StartAsync(other.Config());
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(rig.Config())(Get($"/enlitt/callback?code=abc&state={foreign}"));
    Assert.Empty(response.GetAll("Set-Cookie"));
    Assert.Empty(rig.Enlitt.Requests);
  }

  [Theory]
  [InlineData("https://evil.test/x")]
  [InlineData("//evil.test/x")]
  [InlineData("/%2e%2e/admin")]
  [InlineData("/a/../b")]
  [InlineData("/a\\b")]
  [InlineData("javascript:alert(1)")]
  public async Task ReturnToThatIsNotAPathOnTheAppFallsBackToTheDefault(string returnTo)
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, returnTo);
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.Equal(App + "/home", response.Get("Location"));
  }

  [Fact]
  public async Task ACancelledLoginGoesToTheStoredReturnToWithNoCookieAndNoExchange()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, "/pricing");
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?error=access_denied&state={state}"));
    Assert.Equal(App + "/pricing", response.Get("Location"));
    Assert.Empty(response.GetAll("Set-Cookie"));
    Assert.Empty(rig.Enlitt.Requests);
  }

  [Fact]
  public async Task AFailedExchangeGoesToTheStoredReturnToWithNoCookie()
  {
    var rig = new Rig { Respond = _ => StubHandler.Reply(400, """{"error":"invalid_grant"}""") };
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config, "/pricing");
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.Equal(App + "/pricing", response.Get("Location"));
    Assert.Empty(response.GetAll("Set-Cookie"));
    Assert.Single(rig.Enlitt.Requests);
  }

  [Theory]
  [InlineData("""{"session_token":"tok","subject":"bad subject!"}""")]
  [InlineData("""{"session_token":"","subject":"user_1"}""")]
  [InlineData("""{"session_token":5,"subject":"user_1"}""")]
  [InlineData("not json")]
  public async Task AMalformedExchangeAnswerSetsNoCookieAndRunsNoHook(string answer)
  {
    var rig = new Rig { Respond = _ => StubHandler.Reply(200, answer) };
    bool hooked = false;
    CallbackConfig config = rig.Config((_, _) =>
    {
      hooked = true;
      return Task.CompletedTask;
    });
    string state = await rig.StartAsync(config);
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.Empty(response.GetAll("Set-Cookie"));
    Assert.False(hooked);
  }

  [Fact]
  public async Task OnSignInSeesTheVerifiedSubjectAndMayAddItsOwnCookie()
  {
    var rig = new Rig();
    var seen = new List<string>();
    CallbackConfig config = rig.Config(async (identity, response) =>
    {
      await Task.Delay(5);
      seen.Add(identity.Subject);
      response.Append("Set-Cookie", "app_user=1; Path=/");
    });
    string state = await rig.StartAsync(config);

    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));

    Assert.Equal(["user_1"], seen);
    IReadOnlyList<string> cookies = response.GetAll("Set-Cookie");
    Assert.Equal(2, cookies.Count);
    Assert.Contains(cookies, c => c.StartsWith("app_user=1", StringComparison.Ordinal));
    Assert.Contains(cookies, c => c.StartsWith("enlitt_session=", StringComparison.Ordinal));
  }

  [Fact]
  public async Task OnSignInRunsOnceUnderReplayAndNeverOnCancelOrFailure()
  {
    var rig = new Rig();
    int runs = 0;
    CallbackConfig config = rig.Config((_, _) =>
    {
      runs++;
      return Task.CompletedTask;
    });
    EnlittHandler callback = CallbackHandlers.CreateCallbackHandler(config);

    string state = await rig.StartAsync(config);
    await callback(Get($"/enlitt/callback?code=abc&state={state}"));
    await callback(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.Equal(1, runs);

    string cancelled = await rig.StartAsync(config);
    await callback(Get($"/enlitt/callback?error=access_denied&state={cancelled}"));
    Assert.Equal(1, runs);
  }

  [Fact]
  public async Task AHookFailurePropagatesAndSetsNoSessionCookie()
  {
    var rig = new Rig();
    CallbackConfig config = rig.Config((_, _) => throw new InvalidOperationException("db down"));
    string state = await rig.StartAsync(config);
    await Assert.ThrowsAsync<InvalidOperationException>(() => CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}")));
  }

  [Fact]
  public async Task ExtraFieldsInTheExchangeAnswerStillSetTheCookie()
  {
    var rig = new Rig { Respond = _ => StubHandler.Reply(200, """{"session_token":"tok_x","subject":"u1","brand_new":{"a":1}}""") };
    CallbackConfig config = rig.Config();
    string state = await rig.StartAsync(config);
    HandlerResponse response = await CallbackHandlers.CreateCallbackHandler(config)(Get($"/enlitt/callback?code=abc&state={state}"));
    Assert.StartsWith("enlitt_session=tok_x;", Assert.Single(response.GetAll("Set-Cookie")));
  }

  [Fact]
  public async Task LogoutRevokesTheCookieTokenAndClearsTheCookie()
  {
    var rig = new Rig();
    HandlerResponse response = await CallbackHandlers.CreateLogoutHandler(rig.Config())(
        new HandlerRequest("POST", new Uri(App + "/enlitt/logout?return_to=/bye"), [KeyValuePair.Create("Cookie", "other=1; enlitt_session=tok_live_1")]));

    Assert.Equal(App + "/bye", response.Get("Location"));
    string cleared = Assert.Single(response.GetAll("Set-Cookie"));
    Assert.StartsWith("enlitt_session=;", cleared);
    Assert.Contains("Max-Age=0", cleared);

    RecordedRequest revoke = Assert.Single(rig.Enlitt.Requests);
    Assert.Equal("https://api.enlitt.test/auth/oauth2/revoke", revoke.Uri.ToString());
    Assert.Equal(EnlittContract.ApiVersion, revoke.Header(EnlittContract.VersionHeader));
    Assert.Contains("token=tok_live_1", revoke.Body);
  }

  [Fact]
  public async Task LogoutStillClearsTheCookieWhenRevocationFails()
  {
    var rig = new Rig { Respond = _ => throw new HttpRequestException("down") };
    HandlerResponse response = await CallbackHandlers.CreateLogoutHandler(rig.Config())(
        new HandlerRequest("GET", new Uri(App + "/enlitt/logout"), [KeyValuePair.Create("Cookie", "enlitt_session=tok")]));
    Assert.StartsWith("enlitt_session=;", Assert.Single(response.GetAll("Set-Cookie")));
    Assert.Equal(App + "/home", response.Get("Location"));
  }

  [Fact]
  public async Task LogoutWithNoCookieMakesNoRequest()
  {
    var rig = new Rig();
    await CallbackHandlers.CreateLogoutHandler(rig.Config())(Get("/enlitt/logout"));
    Assert.Empty(rig.Enlitt.Requests);
  }

  [Fact]
  public void ConfigurationIsCheckedAtConstruction()
  {
    var rig = new Rig();
    Assert.Throws<EnlittConfigurationException>(() => CallbackHandlers.CreateLoginStartHandler(rig.Config() with { ClientId = "" }));
    Assert.Throws<EnlittConfigurationException>(() => CallbackHandlers.CreateLoginStartHandler(rig.Config() with { RedirectUri = "http://app.test/cb" }));
    Assert.Throws<EnlittConfigurationException>(() => CallbackHandlers.CreateLoginStartHandler(rig.Config() with { AppOrigin = "https://app.test/path" }));
    Assert.Throws<EnlittConfigurationException>(() => CallbackHandlers.CreateLoginStartHandler(rig.Config() with { DefaultReturnTo = "//evil.test" }));
    Assert.Throws<EnlittConfigurationException>(() => CallbackHandlers.CreateLoginStartHandler(rig.Config() with { SecretKey = "bad key" }));
  }

  [Fact]
  public async Task StatesExpireInTheMemoryStore()
  {
    var time = new ManualTime();
    var store = new MemoryStateStore(time);
    await store.SetAsync("s", new StateRecord("/x", 0, 0), TimeSpan.FromMinutes(1));
    Assert.NotNull(await store.GetAsync("s"));
    time.Advance(TimeSpan.FromMinutes(2));
    Assert.Null(await store.GetAsync("s"));
    Assert.Null(await store.ConsumeAsync("s"));
  }
}
