using Enlitt.Auth;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Primitives;

namespace Enlitt.AspNetCore;

/// <summary>Options of <see cref="EnlittAspNetCoreExtensions.UseEnlittSession"/>.</summary>
public sealed record EnlittSessionMiddlewareOptions
{
  /// <summary>The session cookie name. Must equal <see cref="CallbackConfig.CookieName"/>. Defaults to <see cref="EnlittConstants.SessionCookieName"/>.</summary>
  public string? CookieName { get; init; }

  /// <summary>
  /// When true, a non-empty <c>Enlitt-Session</c> header is the session, and the cookie is read only when the header is absent or empty.
  /// For game and native clients that have no cookie jar. Default false: the header is ignored completely.
  /// </summary>
  public bool Header { get; init; }
}

/// <summary>ASP.NET Core bindings: they convert <see cref="HttpContext"/> to and from the neutral handler types and contain no other logic.</summary>
public static class EnlittAspNetCoreExtensions
{
  /// <summary>
  /// Runs the rest of the pipeline inside an Enlitt session context. It never rejects a request, makes no network call and
  /// does not validate the token: a missing or malformed token gives a context holding a null session.
  /// </summary>
  /// <param name="app">The application builder.</param>
  /// <param name="options">Optional settings.</param>
  /// <returns><paramref name="app"/>.</returns>
  public static IApplicationBuilder UseEnlittSession(this IApplicationBuilder app, EnlittSessionMiddlewareOptions? options = null)
  {
    ArgumentNullException.ThrowIfNull(app);
    string cookieName = string.IsNullOrEmpty(options?.CookieName) ? EnlittConstants.SessionCookieName : options.CookieName;
    bool useHeader = options?.Header ?? false;

    return app.Use(async (context, next) =>
    {
      string? token = null;
      if (useHeader)
      {
        string? header = context.Request.Headers[EnlittConstants.SessionHeaderName].ToString();
        token = string.IsNullOrEmpty(header) ? null : header;
      }

      if (token is null && context.Request.Cookies.TryGetValue(cookieName, out string? cookie) && !string.IsNullOrEmpty(cookie))
      {
        token = cookie;
      }

      EnlittSession? session = null;
      if (token is not null)
      {
        try
        {
          session = new EnlittSession(token);
        }
        catch (EnlittConfigurationException)
        {
          // A token that fails the bound check is the same as no token.
        }
      }

      await EnlittSdk.RunWithEnlittSessionAsync(session, () => next(context)).ConfigureAwait(false);
    });
  }

  /// <summary>Maps the login-start, callback and logout handlers.</summary>
  /// <param name="endpoints">The route builder.</param>
  /// <param name="config">The shared configuration. <see cref="CallbackConfig.RedirectUri"/> should end with <paramref name="callbackPath"/>.</param>
  /// <param name="loginPath">Where login-start is served.</param>
  /// <param name="callbackPath">Where the callback is served.</param>
  /// <param name="logoutPath">Where logout is served (any method).</param>
  /// <returns><paramref name="endpoints"/>.</returns>
  public static IEndpointRouteBuilder MapEnlittAuth(
      this IEndpointRouteBuilder endpoints,
      CallbackConfig config,
      string loginPath = "/enlitt/login",
      string callbackPath = "/enlitt/callback",
      string logoutPath = "/enlitt/logout")
  {
    ArgumentNullException.ThrowIfNull(endpoints);
    endpoints.Map(loginPath, Serve(CallbackHandlers.CreateLoginStartHandler(config)));
    endpoints.Map(callbackPath, Serve(CallbackHandlers.CreateCallbackHandler(config)));
    endpoints.Map(logoutPath, Serve(CallbackHandlers.CreateLogoutHandler(config)));
    return endpoints;
  }

  /// <summary>Maps the client sign-in handoff handler under its base path (every path below it).</summary>
  /// <param name="endpoints">The route builder.</param>
  /// <param name="config">The configuration; construction checks run now.</param>
  /// <returns><paramref name="endpoints"/>.</returns>
  public static IEndpointRouteBuilder MapEnlittClientSignIn(this IEndpointRouteBuilder endpoints, ClientSignInConfig config)
  {
    ArgumentNullException.ThrowIfNull(endpoints);
    endpoints.Map(config.BasePath + "/{**rest}", Serve(ClientSignIn.CreateHandler(config)));
    return endpoints;
  }

  private static RequestDelegate Serve(EnlittHandler handler) => async context =>
  {
    HttpRequest http = context.Request;
    byte[] body = [];
    if (http.ContentLength is not 0 && http.Body.CanRead)
    {
      using var buffer = new MemoryStream();
      await http.Body.CopyToAsync(buffer, context.RequestAborted).ConfigureAwait(false);
      body = buffer.ToArray();
    }

    // Cookies are joined with "; " as a browser sends them; every other repeated header is comma-joined.
    IEnumerable<KeyValuePair<string, string>> headers = http.Headers.Select(h => KeyValuePair.Create(
          h.Key,
          h.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase) ? string.Join("; ", h.Value.ToArray()) : h.Value.ToString()));

    var request = new HandlerRequest(
          http.Method,
          new Uri($"{http.Scheme}://{http.Host}{http.PathBase}{http.Path}{http.QueryString}"),
          headers,
          body)
    {
      CancellationToken = context.RequestAborted,
    };

    HandlerResponse response = await handler(request).ConfigureAwait(false);
    context.Response.StatusCode = response.Status;
    foreach (KeyValuePair<string, string> header in response.Headers)
    {
      if (header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
      {
        context.Response.ContentType = header.Value;
      }
      else
      {
        context.Response.Headers.Append(header.Key, new StringValues(header.Value));
      }
    }

    if (response.Body.Length > 0)
    {
      await context.Response.Body.WriteAsync(response.Body, context.RequestAborted).ConfigureAwait(false);
    }
  };
}
