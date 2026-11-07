using Enlitt.AspNetCore;
using Enlitt.Auth;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Enlitt.Tests;

/// <summary>The ASP.NET Core bindings, driven in process through TestServer (no port is opened).</summary>
public class AspNetCoreTests
{
  /// <summary>Builds a test server whose "/who" endpoint reports the ambient session state.</summary>
  private static async Task<IHost> StartAsync(EnlittSessionMiddlewareOptions? options, Action<IEndpointRouteBuilder>? map = null)
  {
    IHost host = new HostBuilder()
        .ConfigureWebHost(web => web
            .UseTestServer()
            .ConfigureServices(services => services.AddRouting())
            .Configure(app =>
            {
              app.UseEnlittSession(options);
              app.UseRouting();
              app.UseEndpoints(endpoints =>
                  {
                    endpoints.MapGet("/who", async context =>
                        {
                          EnlittSession? session = EnlittSdk.GetEnlittSession();
                          await context.Response.WriteAsync(session is null ? "signed-out" : "signed-in");
                        });
                    map?.Invoke(endpoints);
                  });
            }))
        .Build();
    await host.StartAsync();
    return host;
  }

  private static async Task<string> WhoAsync(HttpClient client, string? cookie = null, string? header = null)
  {
    using var request = new HttpRequestMessage(HttpMethod.Get, "/who");
    if (cookie is not null)
    {
      request.Headers.Add("Cookie", cookie);
    }

    if (header is not null)
    {
      request.Headers.Add("Enlitt-Session", header);
    }

    using HttpResponseMessage response = await client.SendAsync(request);
    return await response.Content.ReadAsStringAsync();
  }

  [Fact]
  public async Task CookieSessionIsVisibleToHandlersAndNoCookieIsSignedOut()
  {
    using IHost host = await StartAsync(null);
    using HttpClient client = host.GetTestClient();
    Assert.Equal("signed-in", await WhoAsync(client, cookie: "enlitt_session=tok1"));
    Assert.Equal("signed-out", await WhoAsync(client));
  }

  [Fact]
  public async Task ACustomCookieNameIsHonoured()
  {
    using IHost host = await StartAsync(new EnlittSessionMiddlewareOptions { CookieName = "my_session" });
    using HttpClient client = host.GetTestClient();
    Assert.Equal("signed-in", await WhoAsync(client, cookie: "my_session=tok1"));
    Assert.Equal("signed-out", await WhoAsync(client, cookie: "enlitt_session=tok1"));
  }

  [Fact]
  public async Task TheHeaderIsIgnoredUnlessEnabled()
  {
    using IHost host = await StartAsync(null);
    using HttpClient client = host.GetTestClient();
    Assert.Equal("signed-out", await WhoAsync(client, header: "tok1"));
  }

  [Fact]
  public async Task TheHeaderIsASessionSourceWhenEnabledAndWinsOverTheCookie()
  {
    using IHost host = await StartAsync(new EnlittSessionMiddlewareOptions { Header = true });
    using HttpClient client = host.GetTestClient();
    Assert.Equal("signed-in", await WhoAsync(client, header: "tok1"));
    Assert.Equal("signed-in", await WhoAsync(client, cookie: "enlitt_session=tok2"));
    Assert.Equal("signed-in", await WhoAsync(client, cookie: "enlitt_session=tok2", header: "tok1"));
  }

  [Fact]
  public async Task AnOversizedTokenIsTreatedAsSignedOutAndNeverRejected()
  {
    using IHost host = await StartAsync(new EnlittSessionMiddlewareOptions { Header = true });
    using HttpClient client = host.GetTestClient();
    Assert.Equal("signed-out", await WhoAsync(client, header: new string('a', 5000)));
  }

  [Fact]
  public async Task MapEnlittAuthServesLoginAndCallbackThroughTheHost()
  {
    var time = new ManualTime();
    var enlitt = new StubHandler(_ => StubHandler.Reply(200, """{"session_token":"tok_live_1","subject":"user_1"}"""));
    var config = new CallbackConfig
    {
      ClientId = "client_1",
      SecretKey = Kit.Secret,
      RedirectUri = "http://localhost/enlitt/callback",
      EnlittOrigin = "https://enlitt.test",
      EnlittApiOrigin = "https://api.enlitt.test",
      AppOrigin = "http://localhost",
      DefaultReturnTo = "/home",
      StateStore = new MemoryStateStore(time),
      TimeProvider = time,
      Seams = Kit.Seams(enlitt),
    };
    using IHost host = await StartAsync(null, endpoints => endpoints.MapEnlittAuth(config));
    using HttpClient client = host.GetTestClient();

    using HttpResponseMessage login = await client.GetAsync("/enlitt/login?return_to=/play");
    Assert.Equal(System.Net.HttpStatusCode.SeeOther, login.StatusCode);
    string state = System.Web.HttpUtility.ParseQueryString(login.Headers.Location!.Query)["state"]!;

    using HttpResponseMessage callback = await client.GetAsync($"/enlitt/callback?code=abc&state={state}");
    Assert.Equal(System.Net.HttpStatusCode.SeeOther, callback.StatusCode);
    Assert.Equal("http://localhost/play", callback.Headers.Location!.OriginalString);
    Assert.Contains(callback.Headers.GetValues("Set-Cookie"), c => c.StartsWith("enlitt_session=tok_live_1;", StringComparison.Ordinal));
  }

  [Fact]
  public async Task MapEnlittClientSignInServesTheHandoffAndFormBodies()
  {
    var time = new ManualTime();
    var config = new ClientSignInConfig
    {
      Callback = new CallbackConfig
      {
        ClientId = "client_1",
        SecretKey = Kit.Secret,
        RedirectUri = "http://localhost/enlitt/callback",
        EnlittOrigin = "https://enlitt.test",
        AppOrigin = "http://localhost",
        DefaultReturnTo = "/home",
        StateStore = new MemoryStateStore(time),
        TimeProvider = time,
      },
      BasePath = "/enlitt/signin",
      AppName = "Demo",
      Loopback = true,
      Pairing = true,
      Store = new MemoryClientSignInStore(time),
    };
    using IHost host = await StartAsync(null, endpoints => endpoints.MapEnlittClientSignIn(config));
    using HttpClient client = host.GetTestClient();

    using HttpResponseMessage bad = await client.GetAsync("/enlitt/signin/start");
    Assert.Equal(System.Net.HttpStatusCode.BadRequest, bad.StatusCode);

    using HttpResponseMessage form = await client.GetAsync("/enlitt/signin/pair");
    Assert.Equal(System.Net.HttpStatusCode.OK, form.StatusCode);
    Assert.StartsWith("text/html", form.Content.Headers.ContentType!.ToString(), StringComparison.Ordinal);

    using HttpResponseMessage missing = await client.GetAsync("/enlitt/signin/nope");
    Assert.Equal(System.Net.HttpStatusCode.NotFound, missing.StatusCode);
  }
}
