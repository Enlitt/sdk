// Enlitt sign-in kit: the engine-independent core.
//
// This file is pure C# 9 and references no UnityEngine type, so the .NET test
// project compiles it directly. The Unity layer (EnlittSignIn.cs) only supplies
// the browser, HTTP client, token storage and deep-link source.
//
// The wire it speaks is "Client sign-in handoff" in specs/PROTOCOLS.md. The kit
// holds no Enlitt secret and never calls an Enlitt host: every request goes to
// the game's own backend (BackendBaseUrl).
#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Enlitt.SignIn
{
    /// <summary>Opens a URL in the player's browser.</summary>
    public interface IBrowser
    {
        /// <summary>Opens <paramref name="url"/> in the system browser. Called on the caller's thread.</summary>
        /// <param name="url">The absolute URL to open.</param>
        void Open(string url);
    }

    /// <summary>The HTTP client the core uses to reach the game backend.</summary>
    public interface ISignInHttp
    {
        /// <summary>
        /// Posts a JSON body and returns the HTTP status and the response body.
        /// A 4xx or 5xx answer is returned normally; only a transport failure throws.
        /// </summary>
        /// <param name="url">The absolute request URL.</param>
        /// <param name="json">The JSON request body.</param>
        /// <param name="headers">Extra request headers, such as <c>Enlitt-Session</c>.</param>
        /// <param name="ct">Cancels the request.</param>
        /// <returns>The HTTP status code and the response body text.</returns>
        Task<(int Status, string Body)> PostJsonAsync(
            string url,
            string json,
            IReadOnlyDictionary<string, string> headers,
            CancellationToken ct);
    }

    /// <summary>Persists the session token between game launches.</summary>
    public interface ITokenStorage
    {
        /// <summary>Returns the stored session token, or <c>null</c> when there is none.</summary>
        /// <returns>The stored token, or <c>null</c>.</returns>
        string? Load();

        /// <summary>Stores the session token, replacing any previous one.</summary>
        /// <param name="token">The opaque session token.</param>
        void Save(string token);

        /// <summary>Removes the stored session token.</summary>
        void Clear();
    }

    /// <summary>Delivers deep-link URLs that opened or resumed the game.</summary>
    public interface IDeepLinkSource
    {
        /// <summary>Raised with the full URL each time the game is opened through a deep link.</summary>
        event Action<string> Received;
    }

    /// <summary>The stable error codes carried by <see cref="EnlittSignInException.Code"/>.</summary>
    public static class SignInErrorCode
    {
        /// <summary>The person cancelled, or the backend could not complete the sign-in (wire).</summary>
        public const string AccessDenied = "access_denied";

        /// <summary>The code, pairing or verifier was unknown, used, expired or wrong (wire).</summary>
        public const string InvalidGrant = "invalid_grant";

        /// <summary>The pairing expired before it was confirmed (wire).</summary>
        public const string ExpiredToken = "expired_token";

        /// <summary>The backend rejected the request as malformed (wire).</summary>
        public const string InvalidRequest = "invalid_request";

        /// <summary>The browser came back with a <c>state</c> that is not this sign-in's (local).</summary>
        public const string StateMismatch = "state_mismatch";

        /// <summary>The sign-in did not finish within <see cref="SignInCoreOptions.Timeout"/> (local).</summary>
        public const string Timeout = "timeout";

        /// <summary>The caller cancelled the sign-in (local).</summary>
        public const string Cancelled = "cancelled";

        /// <summary>The backend could not be reached or answered something unexpected (local).</summary>
        public const string Network = "network";

        /// <summary>A request needed a session but the player is signed out (local).</summary>
        public const string NotSignedIn = "not_signed_in";

        /// <summary>The kit or the platform is configured in a way that cannot work (local).</summary>
        public const string Configuration = "configuration";
    }

    /// <summary>Raised for every sign-in failure. <see cref="Code"/> is one of <see cref="SignInErrorCode"/>.</summary>
    public sealed class EnlittSignInException : Exception
    {
        /// <summary>Creates an exception with a stable code and a human-readable message.</summary>
        /// <param name="code">One of the <see cref="SignInErrorCode"/> values.</param>
        /// <param name="message">A message that never contains a token, code or verifier.</param>
        /// <param name="inner">The transport exception behind a <c>network</c> failure, if any.</param>
        public EnlittSignInException(string code, string message, Exception? inner = null)
            : base(message, inner)
        {
            Code = code;
        }

        /// <summary>The stable error code, one of <see cref="SignInErrorCode"/>.</summary>
        public string Code { get; }

        /// <summary>Returns the code and message only, never request data.</summary>
        /// <returns>A short description.</returns>
        public override string ToString() => "EnlittSignInException [" + Code + "]: " + Message;
    }

    /// <summary>Settings of <see cref="SignInCore"/>.</summary>
    public sealed class SignInCoreOptions
    {
        /// <summary>
        /// The game backend's client sign-in base: the absolute <c>&lt;appOrigin&gt;&lt;basePath&gt;</c>.
        /// It must be <c>https:</c>, except <c>http://127.0.0.1</c> and <c>http://localhost</c> for development.
        /// </summary>
        public string BackendBaseUrl { get; set; } = "";

        /// <summary>
        /// The deep-link URL the backend returns to (<c>mode=redirect</c>). Optional, and it must also
        /// be listed in the server's <c>returnUrls</c>.
        /// </summary>
        public string? ReturnUrl { get; set; }

        /// <summary>How long one sign-in may take before it fails with <c>timeout</c>. Defaults to 10 minutes.</summary>
        public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(10);

        /// <summary>
        /// Waits between pairing polls. It defaults to <see cref="Task.Delay(TimeSpan, CancellationToken)"/>
        /// and exists so tests can poll without real waiting.
        /// </summary>
        public Func<TimeSpan, CancellationToken, Task>? Delay { get; set; }

        /// <summary>Returns a description without any secret.</summary>
        /// <returns>A short description.</returns>
        public override string ToString() => "SignInCoreOptions(" + BackendBaseUrl + ")";
    }

    /// <summary>A PKCE verifier and its S256 challenge.</summary>
    public sealed class PkcePair
    {
        /// <summary>Creates a pair. Use <see cref="SignInCore.CreatePkce"/> to make a random one.</summary>
        /// <param name="verifier">The RFC 7636 code verifier.</param>
        /// <param name="challenge">The matching S256 challenge.</param>
        public PkcePair(string verifier, string challenge)
        {
            Verifier = verifier;
            Challenge = challenge;
        }

        /// <summary>The secret verifier. It is sent only to the redeeming <c>/token</c> call.</summary>
        public string Verifier { get; }

        /// <summary>The public challenge, <c>base64url(SHA-256(verifier))</c>.</summary>
        public string Challenge { get; }

        /// <summary>Returns a fixed description that omits the verifier.</summary>
        /// <returns>A fixed string.</returns>
        public override string ToString() => "PkcePair";
    }

    /// <summary>A started pairing: the code the player types on another device, and the means to wait for it.</summary>
    public sealed class PairingInfo
    {
        private readonly Func<CancellationToken, Task> _wait;

        internal PairingInfo(string userCode, string verificationUri, int expiresIn, Func<CancellationToken, Task> wait)
        {
            UserCode = userCode;
            VerificationUri = verificationUri;
            ExpiresIn = expiresIn;
            _wait = wait;
        }

        /// <summary>The code to show the player, formatted <c>XXXX-XXXX</c>.</summary>
        public string UserCode { get; }

        /// <summary>The absolute page where the player enters the code on a phone or computer.</summary>
        public string VerificationUri { get; }

        /// <summary>Seconds until the pairing expires.</summary>
        public int ExpiresIn { get; }

        /// <summary>
        /// Polls the backend until the player confirms on the other device, then stores the session.
        /// It raises <c>access_denied</c> if the player cancelled and <c>expired_token</c> on expiry.
        /// </summary>
        /// <param name="ct">Cancels the wait.</param>
        /// <returns>A task that completes when the player is signed in.</returns>
        public Task WaitAsync(CancellationToken ct = default) => _wait(ct);

        /// <summary>Returns the user code and page only, never the pairing id or verifier.</summary>
        /// <returns>A short description.</returns>
        public override string ToString() => "PairingInfo(" + UserCode + ", " + VerificationUri + ")";
    }

    /// <summary>
    /// The sign-in engine. It runs the loopback, deep-link and pairing flows against the game backend,
    /// stores the resulting session token, and produces the request header that carries it.
    /// </summary>
    public sealed class SignInCore
    {
        /// <summary>The request header that carries the session token to the game backend.</summary>
        public const string SessionHeaderName = "Enlitt-Session";

        private const int MaxRequestLineBytes = 8 * 1024;
        private const string LoopbackSuccessPage = "Signed in. You can close this tab and return to the game.";
        private const string LoopbackErrorPage = "Sign-in did not complete. You can close this tab and try again in the game.";

        private static readonly TimeSpan LogoutTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan ConnectionTimeout = TimeSpan.FromSeconds(10);

        private readonly SignInCoreOptions _options;
        private readonly IBrowser _browser;
        private readonly ISignInHttp _http;
        private readonly ITokenStorage _storage;
        private readonly IDeepLinkSource? _deepLinks;
        private readonly string _baseUrl;
        private string? _sessionToken;

        /// <summary>Creates the engine and loads any stored session token.</summary>
        /// <param name="options">The backend address and timeouts.</param>
        /// <param name="browser">Opens the sign-in page.</param>
        /// <param name="http">Reaches the game backend.</param>
        /// <param name="storage">Persists the session token.</param>
        /// <param name="deepLinks">Delivers deep links; required only for <see cref="SignInWithRedirectAsync"/>.</param>
        /// <exception cref="EnlittSignInException">With code <c>configuration</c> when the options are unusable.</exception>
        public SignInCore(
            SignInCoreOptions options,
            IBrowser browser,
            ISignInHttp http,
            ITokenStorage storage,
            IDeepLinkSource? deepLinks = null)
        {
            _options = options ?? throw new ArgumentNullException(nameof(options));
            _browser = browser ?? throw new ArgumentNullException(nameof(browser));
            _http = http ?? throw new ArgumentNullException(nameof(http));
            _storage = storage ?? throw new ArgumentNullException(nameof(storage));
            _deepLinks = deepLinks;
            _baseUrl = ValidateBackendBaseUrl(options.BackendBaseUrl);
            if (options.ReturnUrl != null && !Uri.TryCreate(options.ReturnUrl, UriKind.Absolute, out _))
            {
                throw Configuration("ReturnUrl must be an absolute URL.");
            }

            if (options.Timeout <= TimeSpan.Zero)
            {
                throw Configuration("Timeout must be positive.");
            }

            string? stored = storage.Load();
            _sessionToken = string.IsNullOrEmpty(stored) ? null : stored;
        }

        /// <summary>The current session token, or <c>null</c> when signed out. Treat it as a secret.</summary>
        public string? SessionToken => _sessionToken;

        /// <summary>True when a session token is held.</summary>
        public bool IsSignedIn => _sessionToken != null;

        // ---------------------------------------------------------------- PKCE

        /// <summary>Makes a random PKCE pair: a 32-byte verifier (43 base64url characters) and its S256 challenge.</summary>
        /// <returns>The new pair.</returns>
        public static PkcePair CreatePkce()
        {
            string verifier = Base64Url(RandomBytes(32));
            return new PkcePair(verifier, ComputeChallenge(verifier));
        }

        /// <summary>Computes <c>base64url(SHA-256(ASCII(verifier)))</c> without padding.</summary>
        /// <param name="verifier">The RFC 7636 code verifier.</param>
        /// <returns>The S256 challenge.</returns>
        public static string ComputeChallenge(string verifier)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return Base64Url(sha.ComputeHash(Encoding.ASCII.GetBytes(verifier)));
            }
        }

        // ------------------------------------------------------------ Loopback

        /// <summary>
        /// Signs in through a one-shot HTTP listener on <c>127.0.0.1</c>. The browser opens the backend's
        /// sign-in page and is sent back to the listener with a one-time code, which is then redeemed.
        /// </summary>
        /// <param name="ct">Cancels the sign-in and closes the listener.</param>
        /// <returns>A task that completes when the session is stored.</returns>
        /// <exception cref="EnlittSignInException">With the code describing why sign-in failed.</exception>
        public Task SignInWithLoopbackAsync(CancellationToken ct = default)
        {
            return RunWithDeadlineAsync(ct, async linked =>
            {
                PkcePair pkce = CreatePkce();
                string state = Base64Url(RandomBytes(16));
                var listener = new TcpListener(IPAddress.Loopback, 0);
                try
                {
                    listener.Start();
                    int port = ((IPEndPoint)listener.LocalEndpoint).Port;
                    var callback = new TaskCompletionSource<Dictionary<string, string>>(
                        TaskCreationOptions.RunContinuationsAsynchronously);

                    // Closing the listener on cancellation or timeout frees the port and ends the accept loop.
                    using (linked.Register(() =>
                    {
                        listener.Stop();
                        callback.TrySetCanceled();
                    }))
                    {
                        _ = AcceptLoopAsync(listener, state, callback, linked);

                        string startUrl = _baseUrl + "/start?mode=loopback"
                            + "&port=" + port.ToString(CultureInfo.InvariantCulture)
                            + "&state=" + state
                            + "&code_challenge=" + pkce.Challenge
                            + "&code_challenge_method=S256";
                        _browser.Open(startUrl);

                        Dictionary<string, string> query = await callback.Task;
                        listener.Stop();
                        string code = ReadCallback(query, state);
                        await RedeemCodeAsync(code, pkce.Verifier, linked);
                    }
                }
                finally
                {
                    listener.Stop();
                }
            });
        }

        private static async Task AcceptLoopAsync(
            TcpListener listener,
            string expectedState,
            TaskCompletionSource<Dictionary<string, string>> callback,
            CancellationToken lifetime)
        {
            while (!lifetime.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                }
                catch (SocketException e) when (e.SocketErrorCode == SocketError.ConnectionReset
                    || e.SocketErrorCode == SocketError.ConnectionAborted)
                {
                    // A peer that vanished before it was accepted; keep listening.
                    continue;
                }
                catch (Exception)
                {
                    // The listener was stopped (sign-in finished, timed out or was cancelled).
                    return;
                }

                // Each connection is served on its own so an idle speculative connection cannot block the real one.
                _ = ServeConnectionAsync(client, expectedState, callback, lifetime);
            }
        }

        private static async Task ServeConnectionAsync(
            TcpClient client,
            string expectedState,
            TaskCompletionSource<Dictionary<string, string>> callback,
            CancellationToken lifetime)
        {
            using (client)
            using (var connectionCts = CancellationTokenSource.CreateLinkedTokenSource(lifetime))
            {
                connectionCts.CancelAfter(ConnectionTimeout);
                // NetworkStream ignores cancellation tokens, so a timeout must close the socket instead.
                using (connectionCts.Token.Register(() => client.Dispose()))
                {
                    try
                    {
                        NetworkStream stream = client.GetStream();
                        string? requestLine = await ReadRequestLineAsync(stream, connectionCts.Token).ConfigureAwait(false);
                        if (requestLine == null)
                        {
                            return;
                        }

                        Dictionary<string, string>? query = ParseCallbackRequestLine(requestLine);
                        if (query == null)
                        {
                            // Not GET /callback, for example the browser's /favicon.ico: answer and keep waiting.
                            await WriteResponseAsync(stream, "404 Not Found", "Not found.", connectionCts.Token).ConfigureAwait(false);
                            await DrainAsync(client, stream, connectionCts).ConfigureAwait(false);
                            return;
                        }

                        bool ok = query.TryGetValue("state", out string? state)
                            && state == expectedState
                            && query.ContainsKey("code")
                            && !query.ContainsKey("error");
                        await WriteResponseAsync(
                            stream,
                            "200 OK",
                            ok ? LoopbackSuccessPage : LoopbackErrorPage,
                            connectionCts.Token).ConfigureAwait(false);
                        callback.TrySetResult(query);
                        await DrainAsync(client, stream, connectionCts).ConfigureAwait(false);
                    }
                    catch (Exception)
                    {
                        // A reset or timed-out connection is ignored; the listener keeps waiting for the real callback.
                    }
                }
            }
        }

        /// <summary>
        /// Lets the browser finish sending its request headers before the socket closes. Closing a socket that still
        /// has unread data makes the OS reset the connection, which can discard the page the browser has not shown yet.
        /// </summary>
        private static async Task DrainAsync(TcpClient client, NetworkStream stream, CancellationTokenSource connectionCts)
        {
            connectionCts.CancelAfter(TimeSpan.FromSeconds(1));
            client.Client.Shutdown(SocketShutdown.Send);
            var scratch = new byte[1024];
            while (await stream.ReadAsync(scratch, 0, scratch.Length, connectionCts.Token).ConfigureAwait(false) > 0)
            {
            }
        }

        /// <summary>Reads one HTTP request line (up to 8 KiB), or returns <c>null</c> if the peer sends none.</summary>
        private static async Task<string?> ReadRequestLineAsync(NetworkStream stream, CancellationToken ct)
        {
            var buffer = new byte[MaxRequestLineBytes];
            int length = 0;
            while (length < buffer.Length)
            {
                int read = await stream.ReadAsync(buffer, length, buffer.Length - length, ct).ConfigureAwait(false);
                if (read == 0)
                {
                    return null;
                }

                int searchFrom = length;
                length += read;
                int newline = Array.IndexOf(buffer, (byte)'\n', searchFrom, read);
                if (newline >= 0)
                {
                    return Encoding.ASCII.GetString(buffer, 0, newline).TrimEnd('\r');
                }
            }

            return null;
        }

        private static async Task WriteResponseAsync(NetworkStream stream, string status, string text, CancellationToken ct)
        {
            byte[] body = Encoding.UTF8.GetBytes(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Enlitt</title></head><body><p>"
                + text
                + "</p></body></html>");
            string head = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: text/html; charset=utf-8\r\n"
                + "Content-Length: " + body.Length.ToString(CultureInfo.InvariantCulture) + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Referrer-Policy: no-referrer\r\n"
                + "Connection: close\r\n\r\n";
            byte[] headBytes = Encoding.ASCII.GetBytes(head);
            await stream.WriteAsync(headBytes, 0, headBytes.Length, ct).ConfigureAwait(false);
            await stream.WriteAsync(body, 0, body.Length, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }

        /// <summary>Returns the decoded query of a <c>GET /callback?...</c> request line, or <c>null</c> for any other request.</summary>
        private static Dictionary<string, string>? ParseCallbackRequestLine(string requestLine)
        {
            string[] parts = requestLine.Split(' ');
            if (parts.Length < 2 || parts[0] != "GET")
            {
                return null;
            }

            string target = parts[1];
            int questionMark = target.IndexOf('?');
            string path = questionMark < 0 ? target : target.Substring(0, questionMark);
            if (path != "/callback" || questionMark < 0)
            {
                return null;
            }

            return ParseQuery(target.Substring(questionMark + 1));
        }

        // ----------------------------------------------------------- Deep link

        /// <summary>
        /// Signs in through a deep link back into the game (the mobile flow). It needs
        /// <see cref="SignInCoreOptions.ReturnUrl"/> and an <see cref="IDeepLinkSource"/>.
        /// </summary>
        /// <param name="ct">Cancels the sign-in.</param>
        /// <returns>A task that completes when the session is stored.</returns>
        /// <exception cref="EnlittSignInException">With the code describing why sign-in failed.</exception>
        public Task SignInWithRedirectAsync(CancellationToken ct = default)
        {
            string? returnUrl = _options.ReturnUrl;
            if (string.IsNullOrEmpty(returnUrl))
            {
                return Task.FromException(Configuration("Deep-link sign-in needs ReturnUrl."));
            }

            IDeepLinkSource? deepLinks = _deepLinks;
            if (deepLinks == null)
            {
                return Task.FromException(Configuration("Deep-link sign-in needs an IDeepLinkSource."));
            }

            return RunWithDeadlineAsync(ct, async linked =>
            {
                PkcePair pkce = CreatePkce();
                string state = Base64Url(RandomBytes(16));
                var received = new TaskCompletionSource<Dictionary<string, string>>(
                    TaskCreationOptions.RunContinuationsAsynchronously);

                // Other URLs, and links with another state, are not ours: ignore them and keep waiting.
                Action<string> handler = url =>
                {
                    if (!url.StartsWith(returnUrl, StringComparison.Ordinal))
                    {
                        return;
                    }

                    Dictionary<string, string> query = ParseQuery(QueryOf(url));
                    if (query.TryGetValue("state", out string? linkState) && linkState == state)
                    {
                        received.TrySetResult(query);
                    }
                };

                using (linked.Register(() => received.TrySetCanceled()))
                {
                    deepLinks.Received += handler;
                    try
                    {
                        string startUrl = _baseUrl + "/start?mode=redirect"
                            + "&redirect_uri=" + Uri.EscapeDataString(returnUrl)
                            + "&state=" + state
                            + "&code_challenge=" + pkce.Challenge
                            + "&code_challenge_method=S256";
                        _browser.Open(startUrl);

                        Dictionary<string, string> query = await received.Task;
                        string code = ReadCallback(query, state);
                        await RedeemCodeAsync(code, pkce.Verifier, linked);
                    }
                    finally
                    {
                        deepLinks.Received -= handler;
                    }
                }
            });
        }

        private static string QueryOf(string url)
        {
            int fragment = url.IndexOf('#');
            if (fragment >= 0)
            {
                url = url.Substring(0, fragment);
            }

            int questionMark = url.IndexOf('?');
            return questionMark < 0 ? "" : url.Substring(questionMark + 1);
        }

        // -------------------------------------------------------------- Pairing

        /// <summary>
        /// Starts a pairing for a device that cannot open a browser. Show <see cref="PairingInfo.UserCode"/> and
        /// <see cref="PairingInfo.VerificationUri"/> to the player, then await <see cref="PairingInfo.WaitAsync"/>.
        /// </summary>
        /// <param name="ct">Cancels the request.</param>
        /// <returns>The code to show and the means to wait for confirmation.</returns>
        /// <exception cref="EnlittSignInException">With code <c>configuration</c> when the backend has pairing off.</exception>
        public async Task<PairingInfo> StartPairingAsync(CancellationToken ct = default)
        {
            PairingInfo? info = null;
            await RunWithDeadlineAsync(ct, async linked =>
            {
                PkcePair pkce = CreatePkce();
                string body = "{\"code_challenge\":" + JsonQuote(pkce.Challenge) + ",\"code_challenge_method\":\"S256\"}";
                (int status, string text) = await PostAsync("/pairing", body, null, linked);
                if (status == 404)
                {
                    throw Configuration("The backend has pairing turned off.");
                }

                Dictionary<string, string?>? json = MiniJson.TryParseObject(text);
                if (status != 200 || json == null)
                {
                    throw UnexpectedReply(status);
                }

                string? pairingId = Field(json, "pairing_id");
                string? userCode = Field(json, "user_code");
                string? verificationUri = Field(json, "verification_uri");
                if (pairingId == null || userCode == null || verificationUri == null
                    || !TryInt(Field(json, "expires_in"), out int expiresIn)
                    || !TryInt(Field(json, "interval"), out int interval))
                {
                    throw UnexpectedReply(status);
                }

                string verifier = pkce.Verifier;
                info = new PairingInfo(
                    userCode,
                    verificationUri,
                    expiresIn,
                    waitCt => PollPairingAsync(pairingId, verifier, expiresIn, interval, waitCt));
            });
            return info!;
        }

        private Task PollPairingAsync(string pairingId, string verifier, int expiresIn, int intervalSeconds, CancellationToken ct)
        {
            return RunWithDeadlineAsync(ct, async linked =>
            {
                string body = "{\"grant_type\":\"pairing\",\"pairing_id\":" + JsonQuote(pairingId)
                    + ",\"code_verifier\":" + JsonQuote(verifier) + "}";
                var clock = System.Diagnostics.Stopwatch.StartNew();
                TimeSpan interval = TimeSpan.FromSeconds(Math.Max(0, intervalSeconds));
                while (true)
                {
                    linked.ThrowIfCancellationRequested();
                    if (clock.Elapsed >= TimeSpan.FromSeconds(expiresIn))
                    {
                        throw new EnlittSignInException(SignInErrorCode.ExpiredToken, "The pairing expired before it was confirmed.");
                    }

                    TokenReply reply;
                    try
                    {
                        (int status, string text) = await PostAsync("/token", body, null, linked);
                        reply = ParseTokenReply(status, text);
                    }
                    catch (EnlittSignInException e) when (e.Code == SignInErrorCode.Network)
                    {
                        reply = TokenReply.Transient();
                    }

                    if (reply.Token != null)
                    {
                        SaveSession(reply.Token);
                        return;
                    }

                    if (reply.ErrorCode == "authorization_pending")
                    {
                        await Wait(interval, linked);
                    }
                    else if (reply.ErrorCode == null)
                    {
                        // A non-JSON or 5xx answer: back off five extra seconds before asking again.
                        await Wait(interval + TimeSpan.FromSeconds(5), linked);
                    }
                    else
                    {
                        throw ErrorFor(reply.ErrorCode);
                    }
                }
            });
        }

        private Task Wait(TimeSpan span, CancellationToken ct)
        {
            return _options.Delay != null ? _options.Delay(span, ct) : Task.Delay(span, ct);
        }

        // ---------------------------------------------------------- Token redeem

        private async Task RedeemCodeAsync(string code, string verifier, CancellationToken ct)
        {
            string body = "{\"grant_type\":\"code\",\"code\":" + JsonQuote(code)
                + ",\"code_verifier\":" + JsonQuote(verifier) + "}";
            (int status, string text) = await PostAsync("/token", body, null, ct);
            TokenReply reply = ParseTokenReply(status, text);
            if (reply.Token != null)
            {
                SaveSession(reply.Token);
                return;
            }

            throw reply.ErrorCode == null || reply.ErrorCode == "authorization_pending"
                ? UnexpectedReply(status)
                : ErrorFor(reply.ErrorCode);
        }

        /// <summary>Checks the callback's state, maps <c>error</c> to an exception, and returns the code.</summary>
        private static string ReadCallback(Dictionary<string, string> query, string expectedState)
        {
            if (!query.TryGetValue("state", out string? state) || state != expectedState)
            {
                throw new EnlittSignInException(SignInErrorCode.StateMismatch, "The sign-in response did not match this sign-in attempt.");
            }

            if (query.TryGetValue("error", out string? error))
            {
                throw ErrorFor(error);
            }

            if (!query.TryGetValue("code", out string? code) || code.Length == 0)
            {
                throw new EnlittSignInException(SignInErrorCode.InvalidRequest, "The sign-in response carried no code.");
            }

            return code;
        }

        private sealed class TokenReply
        {
            public string? Token { get; private set; }

            /// <summary>The wire error, or <c>null</c> for a success or a transient (non-JSON / 5xx) answer.</summary>
            public string? ErrorCode { get; private set; }

            public static TokenReply Success(string token) => new TokenReply { Token = token };

            public static TokenReply Error(string code) => new TokenReply { ErrorCode = code };

            public static TokenReply Transient() => new TokenReply();
        }

        private static TokenReply ParseTokenReply(int status, string body)
        {
            Dictionary<string, string?>? json = MiniJson.TryParseObject(body);
            if (json == null || status >= 500)
            {
                return TokenReply.Transient();
            }

            if (status == 200)
            {
                string? token = Field(json, "session_token");
                return token != null ? TokenReply.Success(token) : TokenReply.Transient();
            }

            string? error = Field(json, "error");
            return error != null ? TokenReply.Error(error) : TokenReply.Transient();
        }

        private static EnlittSignInException ErrorFor(string wireError)
        {
            switch (wireError)
            {
                case SignInErrorCode.AccessDenied:
                    return new EnlittSignInException(wireError, "Sign-in was cancelled or denied.");
                case SignInErrorCode.InvalidGrant:
                    return new EnlittSignInException(wireError, "The sign-in code was not accepted. Try signing in again.");
                case SignInErrorCode.ExpiredToken:
                    return new EnlittSignInException(wireError, "The sign-in expired. Try signing in again.");
                case SignInErrorCode.InvalidRequest:
                    return new EnlittSignInException(wireError, "The backend rejected the sign-in request.");
                default:
                    return new EnlittSignInException(SignInErrorCode.InvalidRequest, "The backend answered with an unknown error.");
            }
        }

        private static EnlittSignInException UnexpectedReply(int status)
        {
            return new EnlittSignInException(
                SignInErrorCode.Network,
                "The backend answered with an unexpected response (HTTP " + status.ToString(CultureInfo.InvariantCulture) + ").");
        }

        private void SaveSession(string token)
        {
            _storage.Save(token);
            _sessionToken = token;
        }

        // ------------------------------------------------------- Session state

        /// <summary>Returns the header that authorizes a request to the game backend: <c>Enlitt-Session: token</c>.</summary>
        /// <returns>A one-entry header map.</returns>
        /// <exception cref="EnlittSignInException">With code <c>not_signed_in</c> when signed out.</exception>
        public IReadOnlyDictionary<string, string> AuthorizationHeaders()
        {
            string? token = _sessionToken;
            if (token == null)
            {
                throw new EnlittSignInException(SignInErrorCode.NotSignedIn, "The player is not signed in.");
            }

            return new Dictionary<string, string> { { SessionHeaderName, token } };
        }

        /// <summary>
        /// Signs out: asks the backend to revoke the session, ignoring any failure, and always clears the
        /// stored token.
        /// </summary>
        /// <param name="ct">Cancels the revoke request; the local token is cleared regardless.</param>
        /// <returns>A task that completes once local state is cleared.</returns>
        public async Task SignOutAsync(CancellationToken ct = default)
        {
            string? token = _sessionToken;
            ForgetSession();
            if (token == null)
            {
                return;
            }

            try
            {
                using (var timeout = new CancellationTokenSource(LogoutTimeout))
                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token))
                {
                    var headers = new Dictionary<string, string> { { SessionHeaderName, token } };
                    await PostAsync("/logout", "{}", headers, linked.Token);
                }
            }
            catch (Exception)
            {
                // The backend may be unreachable or the session already gone; the player is signed out locally either way.
            }
        }

        /// <summary>
        /// Clears the stored session without contacting the backend. Call it when the game backend reports that
        /// the session is no longer valid.
        /// </summary>
        public void ForgetSession()
        {
            _sessionToken = null;
            _storage.Clear();
        }

        /// <summary>Returns a fixed description that omits the session token.</summary>
        /// <returns>A short description.</returns>
        public override string ToString() => "SignInCore(signedIn=" + (IsSignedIn ? "true" : "false") + ")";

        // --------------------------------------------------------------- Helpers

        /// <summary>
        /// Runs <paramref name="body"/> under the caller's token plus <see cref="SignInCoreOptions.Timeout"/>,
        /// turning a cancellation into <c>cancelled</c> or <c>timeout</c>.
        /// </summary>
        private async Task RunWithDeadlineAsync(CancellationToken ct, Func<CancellationToken, Task> body)
        {
            using (var timeout = new CancellationTokenSource(_options.Timeout))
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeout.Token))
            {
                try
                {
                    await body(linked.Token);
                }
                catch (OperationCanceledException)
                {
                    if (ct.IsCancellationRequested)
                    {
                        throw new EnlittSignInException(SignInErrorCode.Cancelled, "Sign-in was cancelled.");
                    }

                    if (timeout.IsCancellationRequested)
                    {
                        throw new EnlittSignInException(SignInErrorCode.Timeout, "Sign-in took too long and was stopped.");
                    }

                    throw;
                }
            }
        }

        /// <summary>Posts to <c>&lt;base&gt;&lt;path&gt;</c>, turning any transport failure into a <c>network</c> error.</summary>
        private async Task<(int Status, string Body)> PostAsync(
            string path,
            string json,
            IReadOnlyDictionary<string, string>? headers,
            CancellationToken ct)
        {
            try
            {
                return await _http.PostJsonAsync(
                    _baseUrl + path,
                    json,
                    headers ?? new Dictionary<string, string>(),
                    ct);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (EnlittSignInException)
            {
                throw;
            }
            catch (Exception e)
            {
                throw new EnlittSignInException(
                    SignInErrorCode.Network,
                    "Could not reach the game backend: " + e.Message,
                    e);
            }
        }

        private static EnlittSignInException Configuration(string message)
        {
            return new EnlittSignInException(SignInErrorCode.Configuration, message);
        }

        private static string ValidateBackendBaseUrl(string? value)
        {
            if (string.IsNullOrEmpty(value) || !Uri.TryCreate(value, UriKind.Absolute, out Uri? uri))
            {
                throw Configuration("BackendBaseUrl must be an absolute URL.");
            }

            bool devHost = uri.Scheme == Uri.UriSchemeHttp && (uri.Host == "127.0.0.1" || uri.Host == "localhost");
            if (uri.Scheme != Uri.UriSchemeHttps && !devHost)
            {
                throw Configuration("BackendBaseUrl must be https (http is allowed only for 127.0.0.1 and localhost).");
            }

            if (uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            {
                throw Configuration("BackendBaseUrl must not contain credentials, a query, or a fragment.");
            }

            return value!.TrimEnd('/');
        }

        private static byte[] RandomBytes(int count)
        {
            var bytes = new byte[count];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }

            return bytes;
        }

        /// <summary>Encodes bytes as unpadded base64url (RFC 4648 section 5).</summary>
        private static string Base64Url(byte[] bytes)
        {
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private static Dictionary<string, string> ParseQuery(string query)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string pair in query.Split(new[] { '&' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int equals = pair.IndexOf('=');
                string key = equals < 0 ? pair : pair.Substring(0, equals);
                string value = equals < 0 ? "" : pair.Substring(equals + 1);
                result[Decode(key)] = Decode(value);
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

        private static string? Field(Dictionary<string, string?> json, string name)
        {
            return json.TryGetValue(name, out string? value) && !string.IsNullOrEmpty(value) ? value : null;
        }

        private static bool TryInt(string? text, out int value)
        {
            value = 0;
            return text != null && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);
        }

        private static string JsonQuote(string value)
        {
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }

                        break;
                }
            }

            return sb.Append('"').ToString();
        }
    }

    /// <summary>
    /// A tiny JSON reader for the flat objects the handoff wire returns. Unity 2021.3 ships no
    /// System.Text.Json, and the wire needs nothing more than string and number members.
    /// </summary>
    internal static class MiniJson
    {
        private const int MaxDepth = 32;

        /// <summary>
        /// Parses a JSON object into its scalar members (strings as text, numbers and literals as raw text,
        /// <c>null</c> as <c>null</c>). Nested objects and arrays are skipped. Returns <c>null</c> when the
        /// text is not one valid JSON object.
        /// </summary>
        public static Dictionary<string, string?>? TryParseObject(string? json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return null;
            }

            try
            {
                var reader = new Reader(json!);
                reader.SkipWhitespace();
                reader.Expect('{');
                var result = new Dictionary<string, string?>(StringComparer.Ordinal);
                reader.SkipWhitespace();
                if (reader.Peek() == '}')
                {
                    reader.Advance();
                }
                else
                {
                    while (true)
                    {
                        reader.SkipWhitespace();
                        string key = reader.ReadString();
                        reader.SkipWhitespace();
                        reader.Expect(':');
                        reader.SkipWhitespace();
                        char c = reader.Peek();
                        if (c == '"')
                        {
                            result[key] = reader.ReadString();
                        }
                        else if (c == '{' || c == '[')
                        {
                            reader.SkipValue(0);
                        }
                        else
                        {
                            string literal = reader.ReadLiteral();
                            result[key] = literal == "null" ? null : literal;
                        }

                        reader.SkipWhitespace();
                        char next = reader.Peek();
                        reader.Advance();
                        if (next == '}')
                        {
                            break;
                        }

                        if (next != ',')
                        {
                            return null;
                        }
                    }
                }

                reader.SkipWhitespace();
                return reader.AtEnd ? result : null;
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private sealed class Reader
        {
            private readonly string _text;
            private int _pos;

            public Reader(string text)
            {
                _text = text;
            }

            public bool AtEnd => _pos >= _text.Length;

            public char Peek()
            {
                if (AtEnd)
                {
                    throw new FormatException("Unexpected end of JSON.");
                }

                return _text[_pos];
            }

            public void Advance() => _pos++;

            public void SkipWhitespace()
            {
                while (!AtEnd && char.IsWhiteSpace(_text[_pos]))
                {
                    _pos++;
                }
            }

            public void Expect(char expected)
            {
                if (Peek() != expected)
                {
                    throw new FormatException("Expected " + expected);
                }

                _pos++;
            }

            public string ReadString()
            {
                Expect('"');
                var sb = new StringBuilder();
                while (true)
                {
                    char c = Peek();
                    _pos++;
                    if (c == '"')
                    {
                        return sb.ToString();
                    }

                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }

                    char escape = Peek();
                    _pos++;
                    switch (escape)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (_pos + 4 > _text.Length
                                || !int.TryParse(_text.Substring(_pos, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out int code))
                            {
                                throw new FormatException("Bad unicode escape.");
                            }

                            sb.Append((char)code);
                            _pos += 4;
                            break;
                        default:
                            throw new FormatException("Bad escape.");
                    }
                }
            }

            /// <summary>Reads a number, <c>true</c>, <c>false</c> or <c>null</c> as raw text.</summary>
            public string ReadLiteral()
            {
                int start = _pos;
                while (!AtEnd && ",}] \t\r\n".IndexOf(_text[_pos]) < 0)
                {
                    _pos++;
                }

                if (_pos == start)
                {
                    throw new FormatException("Empty value.");
                }

                return _text.Substring(start, _pos - start);
            }

            /// <summary>Skips one JSON value of any type, to a bounded depth.</summary>
            public void SkipValue(int depth)
            {
                if (depth > MaxDepth)
                {
                    throw new FormatException("JSON nested too deeply.");
                }

                SkipWhitespace();
                char c = Peek();
                if (c == '"')
                {
                    ReadString();
                }
                else if (c == '{' || c == '[')
                {
                    char close = c == '{' ? '}' : ']';
                    _pos++;
                    SkipWhitespace();
                    if (Peek() == close)
                    {
                        _pos++;
                        return;
                    }

                    while (true)
                    {
                        SkipWhitespace();
                        if (c == '{')
                        {
                            ReadString();
                            SkipWhitespace();
                            Expect(':');
                        }

                        SkipValue(depth + 1);
                        SkipWhitespace();
                        char next = Peek();
                        _pos++;
                        if (next == close)
                        {
                            return;
                        }

                        if (next != ',')
                        {
                            throw new FormatException("Expected , or " + close);
                        }
                    }
                }
                else
                {
                    ReadLiteral();
                }
            }
        }
    }
}
