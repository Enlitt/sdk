// Staging driver: runs the .NET SDK against a deployed Enlitt Worker.
//
// It is spawned by tests/staging/sdk-dotnet.test.ts (`dotnet run --project tests/StagingDriver`) and is never part of
// `dotnet test`. It prints one JSON line per check, {"check","ok","detail"}, where detail holds error codes and counts
// only: never a token, a secret or model content.
//
// Inputs arrive only through the child's environment:
//   ENLITT_BASE_URL, ENLITT_SECRET_KEY      the Worker and the business key
//   ENLITT_SESSION_TOKEN                    a seeded personal-session token for the model calls
//   ENLITT_ORIGIN                           the dashboard origin that serves the authorize step
//   ENLITT_CLIENT_ID, ENLITT_REDIRECT_URI   the seeded application and its registered callback URL
//                                           (the callback's origin is also the local app's origin)
//   ENLITT_PERSONAL_COOKIE                  the full Cookie value of the seeded personal session (authorize step)
//   ENLITT_TEST_PROVIDER_TOKEN (optional)   when set, every request to ENLITT_BASE_URL carries the two staging
//                                           test-provider headers, so standard calls use the recorded provider
//
// The local app is driven in process through TestServer: the loopback redirect target is parsed, never connected to,
// so no port is opened. The test-provider headers are added by a DelegatingHandler placed in the SDK's HTTP stack
// through its internal test seam; the SDK has no public header hook.
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Enlitt;
using Enlitt.AspNetCore;
using Enlitt.Auth;
using Enlitt.Extensions.AI;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

const int LoopbackPort = 45819;
const string BasePath = "/enlitt/client";

TransportSeams seams = BuildSeams();
EnlittOptions options = new()
{
  SecretKey = Env("ENLITT_SECRET_KEY"),
  BaseUrl = Env("ENLITT_BASE_URL"),
  Session = new EnlittSession(Env("ENLITT_SESSION_TOKEN")),
};

await RunCheck("standard_call", () => StandardCall(options, seams));
await RunCheck("standard_stream", () => StandardStream(options, seams));
await RunCheck("usage", () => Usage(options, seams));
await RunCheck("premium_with_charge", () => Premium(options, seams));
await RunCheck("login_required", () => LoginRequired(options, seams));
await RunCheck("client_sign_in_loopback", () => ClientSignInLoopback(options, seams));
return 0;

// ---- output ---------------------------------------------------------------------------------------------------------

/// <summary>Prints one result line.</summary>
static void Report(string check, bool ok, object detail) =>
    Console.WriteLine(JsonSerializer.Serialize(new { check, ok, detail }));

/// <summary>Runs one check; an exception becomes a failed line naming only its type and code.</summary>
static async Task RunCheck(string name, Func<Task<object>> check)
{
  try
  {
    Report(name, true, await check());
  }
  catch (EnlittException error)
  {
    Report(name, false, new { error = error.GetType().Name, code = error.Code });
  }
  catch (InvalidOperationException error)
  {
    // The driver's own failures name statuses and key names only, never a secret.
    Report(name, false, new { error = error.GetType().Name, message = error.Message });
  }
  catch (Exception error)
  {
    Report(name, false, new { error = error.GetType().Name });
  }
}

/// <summary>A required environment value (the name, never the value, appears in errors).</summary>
static string Env(string name) =>
    Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : throw new InvalidOperationException($"{name} is not set");

static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

/// <summary>The SDK's HTTP stack, with the staging test-provider headers added when the test token is present.</summary>
static TransportSeams BuildSeams()
{
  var socket = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false };
  string? token = Environment.GetEnvironmentVariable("ENLITT_TEST_PROVIDER_TOKEN");
  return new TransportSeams
  {
    Handler = string.IsNullOrEmpty(token) ? socket : new TestProviderHandler(socket, new Uri(Env("ENLITT_BASE_URL")).Host, token),
  };
}

// ---- model-call checks ------------------------------------------------------------------------------------------------

static async Task<object> StandardCall(EnlittOptions options, TransportSeams seams)
{
  using IChatClient client = EnlittChatClient.Standard(options, seams);
  ChatResponse result = await client.GetResponseAsync("Reply with: ok");
  return new { has_text = result.Text.Length > 0, finish = result.FinishReason?.Value };
}

static async Task<object> StandardStream(EnlittOptions options, TransportSeams seams)
{
  using IChatClient client = EnlittChatClient.Standard(options, seams);
  int updates = 0;
  int finishes = 0;
  await foreach (ChatResponseUpdate update in client.GetStreamingResponseAsync("Reply with: ok"))
  {
    updates++;
    if (update.FinishReason is not null)
    {
      finishes++;
    }
  }

  return finishes == 1 ? new { updates, finishes } : throw new InvalidOperationException($"expected one finish, saw {finishes}");
}

static async Task<object> Usage(EnlittOptions options, TransportSeams seams)
{
  EnlittUsage result = await EnlittSdk.UsageCoreAsync(options, seams, default);
  return new { standard_percent = result.Standard.RemainingPercent, premium_percent = result.Premium.RemainingPercent };
}

/// <summary>A premium charge around a local provider double, with a constant price.</summary>
static async Task<object> Premium(EnlittOptions options, TransportSeams seams)
{
  int providerCalls = 0;
  string operationId = await EnlittSdk.WithPremiumChargeCoreAsync(
      PremiumOptions(options),
      (charge, handle, _) =>
      {
        providerCalls++; // the "provider" is this local double
        charge("1");
        return Task.FromResult(handle.OperationId);
      },
      seams,
      default);
  return new { provider_calls = providerCalls, has_operation_id = operationId.Length > 0 };
}

/// <summary>A garbage session is refused before the provider double runs.</summary>
static async Task<object> LoginRequired(EnlittOptions options, TransportSeams seams)
{
  int providerCalls = 0;
  try
  {
    await EnlittSdk.WithPremiumChargeCoreAsync(
        PremiumOptions(options) with { Session = new EnlittSession("garbage-session-token-for-driver-check") },
        (_, _, _) =>
        {
          providerCalls++;
          return Task.FromResult(0);
        },
        seams,
        default);
  }
  catch (EnlittLoginRequiredException error)
  {
    return providerCalls == 0
        ? new { code = error.Code, provider_calls = providerCalls }
        : throw new InvalidOperationException("the provider ran before admission");
  }

  throw new InvalidOperationException("a garbage session was admitted");
}

static WithPremiumChargeOptions PremiumOptions(EnlittOptions options) => new()
{
  SecretKey = options.SecretKey,
  BaseUrl = options.BaseUrl,
  Session = options.Session,
  MaxCharge = "1000",
  Provider = new PremiumProvider("staging-double", "double-1"),
};

// ---- client sign-in loopback ------------------------------------------------------------------------------------------

/// <summary>Starts the business app in process: callback, client sign-in and one header-authenticated model route.</summary>
static async Task<IHost> StartLocalApp(EnlittOptions options, TransportSeams seams)
{
  var redirect = new Uri(Env("ENLITT_REDIRECT_URI"));
  string origin = redirect.GetLeftPart(UriPartial.Authority);
  var callback = new CallbackConfig
  {
    ClientId = Env("ENLITT_CLIENT_ID"),
    SecretKey = options.SecretKey,
    RedirectUri = redirect.ToString(),
    AppOrigin = origin,
    DefaultReturnTo = "/",
    StateStore = new MemoryStateStore(),
    EnlittOrigin = Env("ENLITT_ORIGIN"),
    EnlittApiOrigin = Env("ENLITT_BASE_URL"),
    Seams = seams,
  };
  var signIn = new ClientSignInConfig
  {
    Callback = callback,
    BasePath = BasePath,
    AppName = "Staging driver",
    Store = new MemoryClientSignInStore(),
  };

  IHost host = new HostBuilder()
      .ConfigureWebHost(web => web
          .UseTestServer()
          .ConfigureServices(services => services.AddRouting())
          .Configure(app =>
          {
            app.UseEnlittSession(new EnlittSessionMiddlewareOptions { Header = true });
            app.UseRouting();
            app.UseEndpoints(endpoints =>
              {
                endpoints.MapEnlittAuth(callback, callbackPath: redirect.AbsolutePath);
                endpoints.MapEnlittClientSignIn(signIn);
                endpoints.MapGet("/model", async context =>
                  {
                    // The ambient session comes from the middleware (the Enlitt-Session header).
                    using IChatClient client = EnlittChatClient.Standard(
                          new EnlittOptions { SecretKey = options.SecretKey, BaseUrl = options.BaseUrl },
                          seams);
                    ChatResponse result = await client.GetResponseAsync("Reply with: ok");
                    await context.Response.WriteAsJsonAsync(new { finish = result.FinishReason?.Value, has_text = result.Text.Length > 0 });
                  });
              });
          }))
      .Build();
  await host.StartAsync();
  return host;
}

/// <summary>The redirect target of a response, or an error naming only the status.</summary>
static Uri LocationOf(HttpResponseMessage response) =>
    (int)response.StatusCode is 302 or 303 or 307 && response.Headers.Location is { } location
        ? (location.IsAbsoluteUri ? location : new Uri(new Uri("http://localhost"), location))
        : throw new InvalidOperationException($"expected a redirect, got {(int)response.StatusCode}");

static async Task<object> ClientSignInLoopback(EnlittOptions options, TransportSeams seams)
{
  using IHost host = await StartLocalApp(options, seams);
  string origin = new Uri(Env("ENLITT_REDIRECT_URI")).GetLeftPart(UriPartial.Authority);
  using HttpClient local = host.GetTestClient();
  local.BaseAddress = new Uri(origin);
  using var remote = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false });

  string verifier = Base64Url(RandomNumberGenerator.GetBytes(48));
  string challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
  string state = Base64Url(RandomNumberGenerator.GetBytes(16));
  string query = string.Join("&", new Dictionary<string, string>
  {
    ["mode"] = "loopback",
    ["port"] = LoopbackPort.ToString(System.Globalization.CultureInfo.InvariantCulture),
    ["state"] = state,
    ["code_challenge"] = challenge,
    ["code_challenge_method"] = "S256",
  }.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}"));

  int steps = 0;

  // 1. start -> redirect to Enlitt's authorize step.
  using HttpResponseMessage start = await local.GetAsync($"{BasePath}/start?{query}");
  Uri authorize = LocationOf(start);
  steps++;

  // 2. authorize, with the seeded personal-session cookie, run by hand.
  using var authorizeRequest = new HttpRequestMessage(HttpMethod.Get, authorize);
  authorizeRequest.Headers.TryAddWithoutValidation("Cookie", Env("ENLITT_PERSONAL_COOKIE"));
  using HttpResponseMessage authorized = await remote.SendAsync(authorizeRequest);
  Uri location = LocationOf(authorized);
  steps++;

  // 3. callback -> complete -> loopback redirect, back through the local app.
  // The test-server client keeps no cookie jar, so the session cookie the
  // callback sets is carried to the complete step by hand, as a browser would.
  var cookies = new List<string>();
  for (int hop = 0; hop < 4 && location.Host != "127.0.0.1"; hop++)
  {
    using var hopRequest = new HttpRequestMessage(HttpMethod.Get, location.PathAndQuery);
    if (cookies.Count > 0)
    {
      hopRequest.Headers.TryAddWithoutValidation("Cookie", string.Join("; ", cookies));
    }

    using HttpResponseMessage response = await local.SendAsync(hopRequest);
    if (response.Headers.TryGetValues("Set-Cookie", out IEnumerable<string>? setCookies))
    {
      // Keep only the name=value pair; attributes are not sent back.
      cookies.AddRange(setCookies.Select(header => header.Split(';')[0]));
    }

    location = LocationOf(response);
    steps++;
  }

  if (location.Host != "127.0.0.1" || location.Port != LoopbackPort)
  {
    throw new InvalidOperationException("the flow did not end at the loopback target");
  }

  System.Collections.Specialized.NameValueCollection returned = System.Web.HttpUtility.ParseQueryString(location.Query);
  if (returned["state"] != state || string.IsNullOrEmpty(returned["code"]))
  {
    throw new InvalidOperationException($"loopback redirect lacks a matching state and code: {string.Join(",", returned.AllKeys.OrderBy(k => k, StringComparer.Ordinal))}");
  }

  // 4. token.
  var grant = new JsonObject { ["grant_type"] = "code", ["code"] = returned["code"], ["code_verifier"] = verifier };
  using var tokenRequest = new StringContent(grant.ToJsonString(), Encoding.UTF8, "application/json");
  using HttpResponseMessage tokenResponse = await local.PostAsync($"{BasePath}/token", tokenRequest);
  if (!tokenResponse.IsSuccessStatusCode)
  {
    throw new InvalidOperationException($"token answered {(int)tokenResponse.StatusCode}");
  }

  string sessionToken = JsonNode.Parse(await tokenResponse.Content.ReadAsStringAsync())!["session_token"]!.GetValue<string>();

  // 5. one standard call with the Enlitt-Session header through the middleware.
  using var modelRequest = new HttpRequestMessage(HttpMethod.Get, "/model");
  modelRequest.Headers.Add("Enlitt-Session", sessionToken);
  using HttpResponseMessage model = await local.SendAsync(modelRequest);
  if (!model.IsSuccessStatusCode)
  {
    throw new InvalidOperationException($"model route answered {(int)model.StatusCode}");
  }

  return new { redirects = steps, model_status = (int)model.StatusCode };
}

/// <summary>Adds the staging test-provider headers to every request to the Worker's host, and to no other host.</summary>
internal sealed class TestProviderHandler(HttpMessageHandler inner, string host, string token) : DelegatingHandler(inner)
{
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
  {
    if (string.Equals(request.RequestUri?.Host, host, StringComparison.OrdinalIgnoreCase))
    {
      request.Headers.TryAddWithoutValidation("x-enlitt-test-provider", "recorded");
      request.Headers.TryAddWithoutValidation("x-enlitt-test-token", token);
    }

    return base.SendAsync(request, cancellationToken);
  }
}
