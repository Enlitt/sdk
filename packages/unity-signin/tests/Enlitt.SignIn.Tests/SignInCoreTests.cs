using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace Enlitt.SignIn.Tests
{
    public sealed class PkceTests
    {
        [Fact]
        public void ChallengeMatchesRfc7636AppendixB()
        {
            Assert.Equal(
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                SignInCore.ComputeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        }

        [Fact]
        public void VerifiersAre43Base64UrlCharactersAndUnique()
        {
            PkcePair first = SignInCore.CreatePkce();
            PkcePair second = SignInCore.CreatePkce();
            Assert.Matches("^[A-Za-z0-9_-]{43}$", first.Verifier);
            Assert.Matches("^[A-Za-z0-9_-]{43}$", first.Challenge);
            Assert.Equal(SignInCore.ComputeChallenge(first.Verifier), first.Challenge);
            Assert.NotEqual(first.Verifier, second.Verifier);
        }
    }

    public sealed class LoopbackTests
    {
        private const string BaseUrl = "https://game.example.com/enlitt/client";

        /// <summary>Parses the query of a start URL into a dictionary, asserting nothing about order.</summary>
        private static Dictionary<string, string> QueryOf(string url)
        {
            return new Uri(url).Query.TrimStart('?').Split('&')
                .Select(pair => pair.Split('=', 2))
                .ToDictionary(parts => parts[0], parts => Uri.UnescapeDataString(parts[1]));
        }

        private static async Task<(HttpStatusCode Status, string Body)> GetAsync(int port, string pathAndQuery)
        {
            using (var client = new HttpClient())
            {
                HttpResponseMessage response = await client.GetAsync("http://127.0.0.1:" + port + pathAndQuery);
                return (response.StatusCode, await response.Content.ReadAsStringAsync());
            }
        }

        private static StubHttp TokenOk(string token = "session-token-xyz")
        {
            return new StubHttp(_ => (200, "{\"session_token\":\"" + token + "\"}"));
        }

        private static SignInCore NewCore(IBrowser browser, StubHttp http, MemoryStorage storage, TimeSpan? timeout = null)
        {
            return new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl, Timeout = timeout ?? TimeSpan.FromSeconds(20) },
                browser,
                http,
                storage);
        }

        private static void AssertPortFree(int port)
        {
            var probe = new TcpListener(IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
        }

        [Fact]
        public async Task CompletesSignInThroughARealCallbackAndIgnoresFavicon()
        {
            Task<string>? browserWork = null;
            var http = TokenOk();
            var storage = new MemoryStorage();
            var browser = new FakeBrowser(url =>
            {
                Dictionary<string, string> query = QueryOf(url);
                int port = int.Parse(query["port"]);
                browserWork = Task.Run(async () =>
                {
                    (HttpStatusCode favicon, _) = await GetAsync(port, "/favicon.ico");
                    Assert.Equal(HttpStatusCode.NotFound, favicon);
                    (HttpStatusCode status, string body) = await GetAsync(
                        port, "/callback?code=one-time-code&state=" + query["state"]);
                    Assert.Equal(HttpStatusCode.OK, status);
                    return body;
                });
            });
            SignInCore core = NewCore(browser, http, storage);

            await core.SignInWithLoopbackAsync();

            Assert.Contains("Signed in. You can close this tab and return to the game.", await browserWork!);
            Assert.Equal("session-token-xyz", storage.Token);
            Assert.Equal("session-token-xyz", core.SessionToken);
            Assert.True(core.IsSignedIn);

            // The start URL carries exactly the five loopback fields.
            Dictionary<string, string> start = QueryOf(Assert.Single(browser.Opened));
            Assert.StartsWith(BaseUrl + "/start?", Assert.Single(browser.Opened));
            Assert.Equal(
                new[] { "code_challenge", "code_challenge_method", "mode", "port", "state" },
                start.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            Assert.Equal("loopback", start["mode"]);
            Assert.Equal("S256", start["code_challenge_method"]);
            Assert.Matches("^[A-Za-z0-9_-]{22}$", start["state"]);
            Assert.Matches("^[1-9][0-9]*$", start["port"]);

            // The redeem request sends the code and the verifier behind the challenge.
            RecordedRequest redeem = Assert.Single(http.Requests);
            Assert.Equal(BaseUrl + "/token", redeem.Url);
            Assert.Contains("\"grant_type\":\"code\"", redeem.Json);
            Assert.Contains("\"code\":\"one-time-code\"", redeem.Json);
            string verifier = Regex.Match(redeem.Json, "\"code_verifier\":\"([^\"]+)\"").Groups[1].Value;
            Assert.Equal(start["code_challenge"], SignInCore.ComputeChallenge(verifier));
        }

        [Fact]
        public async Task WrongStateIsStateMismatch()
        {
            var http = TokenOk();
            var browser = new FakeBrowser(url =>
            {
                int port = int.Parse(QueryOf(url)["port"]);
                _ = Task.Run(() => GetAsync(port, "/callback?code=c&state=not-the-state"));
            });
            SignInCore core = NewCore(browser, http, new MemoryStorage());

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.SignInWithLoopbackAsync());

            Assert.Equal("state_mismatch", error.Code);
            Assert.Empty(http.Requests);
        }

        [Fact]
        public async Task ErrorAccessDeniedRaisesAccessDeniedAndShowsTheErrorPage()
        {
            Task<string>? page = null;
            var http = TokenOk();
            var browser = new FakeBrowser(url =>
            {
                Dictionary<string, string> query = QueryOf(url);
                int port = int.Parse(query["port"]);
                page = Task.Run(async () => (await GetAsync(port, "/callback?error=access_denied&state=" + query["state"])).Body);
            });
            SignInCore core = NewCore(browser, http, new MemoryStorage());

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.SignInWithLoopbackAsync());

            Assert.Equal("access_denied", error.Code);
            Assert.Contains("did not complete", await page!);
            Assert.Empty(http.Requests);
        }

        [Fact]
        public async Task BackendRejectingTheCodeSurfacesTheWireError()
        {
            var http = new StubHttp(_ => (400, "{\"error\":\"invalid_grant\"}"));
            var storage = new MemoryStorage();
            var browser = new FakeBrowser(url =>
            {
                Dictionary<string, string> query = QueryOf(url);
                _ = Task.Run(() => GetAsync(int.Parse(query["port"]), "/callback?code=c&state=" + query["state"]));
            });
            SignInCore core = NewCore(browser, http, storage);

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.SignInWithLoopbackAsync());

            Assert.Equal("invalid_grant", error.Code);
            Assert.Null(storage.Token);
        }

        [Fact]
        public async Task AnOversizedRequestLineIsIgnoredAndTheRealCallbackStillWorks()
        {
            var storage = new MemoryStorage();
            var browser = new FakeBrowser(url =>
            {
                Dictionary<string, string> query = QueryOf(url);
                int port = int.Parse(query["port"]);
                _ = Task.Run(async () =>
                {
                    // 9000 bytes and no newline: over the 8 KiB request-line cap.
                    using (var junk = new TcpClient())
                    {
                        await junk.ConnectAsync(IPAddress.Loopback, port);
                        await junk.GetStream().WriteAsync(new byte[9000].Select(_ => (byte)'a').ToArray());
                    }

                    await GetAsync(port, "/callback?code=c&state=" + query["state"]);
                });
            });
            SignInCore core = NewCore(browser, TokenOk(), storage);

            await core.SignInWithLoopbackAsync();

            Assert.Equal("session-token-xyz", storage.Token);
        }

        [Fact]
        public async Task TimeoutClosesTheListener()
        {
            int port = 0;
            var browser = new FakeBrowser(url => port = int.Parse(QueryOf(url)["port"]));
            SignInCore core = NewCore(browser, TokenOk(), new MemoryStorage(), TimeSpan.FromMilliseconds(300));

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.SignInWithLoopbackAsync());

            Assert.Equal("timeout", error.Code);
            Assert.NotEqual(0, port);
            AssertPortFree(port);
        }

        [Fact]
        public async Task CancellationClosesTheListener()
        {
            int port = 0;
            using (var cts = new CancellationTokenSource())
            {
                var browser = new FakeBrowser(url =>
                {
                    port = int.Parse(QueryOf(url)["port"]);
                    cts.CancelAfter(200);
                });
                SignInCore core = NewCore(browser, TokenOk(), new MemoryStorage());

                EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(
                    () => core.SignInWithLoopbackAsync(cts.Token));

                Assert.Equal("cancelled", error.Code);
            }

            Assert.NotEqual(0, port);
            AssertPortFree(port);
        }

        [Fact]
        public async Task UnreachableBackendIsANetworkError()
        {
            var browser = new FakeBrowser(url =>
            {
                Dictionary<string, string> query = QueryOf(url);
                _ = Task.Run(() => GetAsync(int.Parse(query["port"]), "/callback?code=c&state=" + query["state"]));
            });
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl },
                browser,
                new ThrowingHttp(),
                new MemoryStorage());

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.SignInWithLoopbackAsync());

            Assert.Equal("network", error.Code);
        }
    }

    public sealed class DeepLinkTests
    {
        private const string BaseUrl = "https://game.example.com/enlitt/client";
        private const string ReturnUrl = "com.example.game://signin";

        [Fact]
        public async Task IgnoresOtherPrefixesAndWrongStateThenCompletesOnTheMatch()
        {
            var links = new FakeDeepLinks();
            var storage = new MemoryStorage();
            var http = new StubHttp(_ => (200, "{\"session_token\":\"deep-token\"}"));
            string? startUrl = null;
            var browser = new FakeBrowser(url => startUrl = url);
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl, ReturnUrl = ReturnUrl },
                browser,
                http,
                storage,
                links);

            Task signIn = core.SignInWithRedirectAsync();
            Assert.NotNull(startUrl);
            Assert.Contains("mode=redirect", startUrl);
            Assert.Contains("redirect_uri=" + Uri.EscapeDataString(ReturnUrl), startUrl);
            string state = Regex.Match(startUrl!, "state=([A-Za-z0-9_-]+)").Groups[1].Value;

            links.Raise("com.other.app://signin?code=stolen&state=" + state);
            links.Raise(ReturnUrl + "?code=late&state=wrong-state");
            await Task.Delay(100);
            Assert.False(signIn.IsCompleted);
            Assert.Empty(http.Requests);

            links.Raise(ReturnUrl + "?code=real-code&state=" + state);
            await signIn;

            Assert.Equal("deep-token", storage.Token);
            Assert.Contains("\"code\":\"real-code\"", Assert.Single(http.Requests).Json);
            Assert.Equal(0, links.Subscribers);
        }

        [Fact]
        public async Task ErrorInTheLinkRaisesAccessDenied()
        {
            var links = new FakeDeepLinks();
            string? startUrl = null;
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl, ReturnUrl = ReturnUrl },
                new FakeBrowser(url => startUrl = url),
                new StubHttp(_ => (500, "")),
                new MemoryStorage(),
                links);

            Task signIn = core.SignInWithRedirectAsync();
            string state = Regex.Match(startUrl!, "state=([A-Za-z0-9_-]+)").Groups[1].Value;
            links.Raise(ReturnUrl + "?error=access_denied&state=" + state);

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => signIn);
            Assert.Equal("access_denied", error.Code);
        }

        [Fact]
        public async Task RequiresReturnUrlAndADeepLinkSource()
        {
            var noReturnUrl = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl },
                new FakeBrowser(_ => { }),
                new StubHttp(_ => (200, "{}")),
                new MemoryStorage(),
                new FakeDeepLinks());
            var noSource = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl, ReturnUrl = ReturnUrl },
                new FakeBrowser(_ => { }),
                new StubHttp(_ => (200, "{}")),
                new MemoryStorage());

            Assert.Equal("configuration", (await Assert.ThrowsAsync<EnlittSignInException>(() => noReturnUrl.SignInWithRedirectAsync())).Code);
            Assert.Equal("configuration", (await Assert.ThrowsAsync<EnlittSignInException>(() => noSource.SignInWithRedirectAsync())).Code);
        }
    }

    public sealed class PairingTests
    {
        private const string BaseUrl = "https://game.example.com/enlitt/client";
        private const string PairingBody =
            "{\"pairing_id\":\"pid\",\"user_code\":\"BCDF-GHJK\",\"verification_uri\":\"https://game.example.com/enlitt/client/pair\",\"expires_in\":600,\"interval\":5}";

        /// <summary>Builds a core whose /pairing succeeds and whose /token follows the given replies, recording delays.</summary>
        private static (SignInCore Core, StubHttp Http, List<TimeSpan> Delays, MemoryStorage Storage) Build(
            params (int Status, string Body)[] tokenReplies)
        {
            int next = 0;
            var delays = new List<TimeSpan>();
            var storage = new MemoryStorage();
            var http = new StubHttp(request =>
            {
                if (request.Url.EndsWith("/pairing", StringComparison.Ordinal))
                {
                    return (200, PairingBody);
                }

                return tokenReplies[Math.Min(next++, tokenReplies.Length - 1)];
            });
            var core = new SignInCore(
                new SignInCoreOptions
                {
                    BackendBaseUrl = BaseUrl,
                    Delay = (span, _) =>
                    {
                        delays.Add(span);
                        return Task.CompletedTask;
                    },
                },
                new FakeBrowser(_ => { }),
                http,
                storage);
            return (core, http, delays, storage);
        }

        [Fact]
        public async Task StartReturnsTheCodeAndPollsThroughPendingUntilAToken()
        {
            var (core, http, delays, storage) = Build(
                (400, "{\"error\":\"authorization_pending\"}"),
                (400, "{\"error\":\"authorization_pending\"}"),
                (200, "{\"session_token\":\"pair-token\"}"));

            PairingInfo info = await core.StartPairingAsync();
            Assert.Equal("BCDF-GHJK", info.UserCode);
            Assert.Equal("https://game.example.com/enlitt/client/pair", info.VerificationUri);
            Assert.Equal(600, info.ExpiresIn);
            Assert.Contains("\"code_challenge_method\":\"S256\"", http.Requests[0].Json);

            await info.WaitAsync();

            Assert.Equal("pair-token", storage.Token);
            Assert.Equal(new[] { TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5) }, delays);
            Assert.Contains("\"grant_type\":\"pairing\"", http.Requests[1].Json);
            Assert.Contains("\"pairing_id\":\"pid\"", http.Requests[1].Json);
        }

        [Fact]
        public async Task NonJsonAndServerErrorsBackOffFiveExtraSecondsAndKeepPolling()
        {
            var (core, _, delays, storage) = Build(
                (200, "<html>captive portal</html>"),
                (503, "{\"error\":\"unavailable\"}"),
                (200, "{\"session_token\":\"pair-token\"}"));

            await (await core.StartPairingAsync()).WaitAsync();

            Assert.Equal("pair-token", storage.Token);
            Assert.Equal(new[] { TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10) }, delays);
        }

        [Theory]
        [InlineData("expired_token")]
        [InlineData("access_denied")]
        [InlineData("invalid_grant")]
        public async Task TerminalErrorsRaiseTheirCode(string wireError)
        {
            var (core, _, _, storage) = Build(
                (400, "{\"error\":\"authorization_pending\"}"),
                (400, "{\"error\":\"" + wireError + "\"}"));
            PairingInfo info = await core.StartPairingAsync();

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => info.WaitAsync());

            Assert.Equal(wireError, error.Code);
            Assert.Null(storage.Token);
        }

        [Fact]
        public async Task PairingTurnedOffOnTheBackendIsAConfigurationError()
        {
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl },
                new FakeBrowser(_ => { }),
                new StubHttp(_ => (404, "Not found")),
                new MemoryStorage());

            EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => core.StartPairingAsync());

            Assert.Equal("configuration", error.Code);
        }

        [Fact]
        public async Task CancellingTheWaitRaisesCancelled()
        {
            var (core, _, _, _) = Build((400, "{\"error\":\"authorization_pending\"}"));
            PairingInfo info = await core.StartPairingAsync();
            using (var cts = new CancellationTokenSource())
            {
                cts.Cancel();
                EnlittSignInException error = await Assert.ThrowsAsync<EnlittSignInException>(() => info.WaitAsync(cts.Token));
                Assert.Equal("cancelled", error.Code);
            }
        }
    }

    public sealed class SessionTests
    {
        private const string BaseUrl = "https://game.example.com/enlitt/client";

        [Fact]
        public async Task SignOutClearsStorageEvenWhenTheHttpCallThrows()
        {
            var storage = new MemoryStorage { Token = "stored-token" };
            var http = new ThrowingHttp();
            var core = new SignInCore(new SignInCoreOptions { BackendBaseUrl = BaseUrl }, new FakeBrowser(_ => { }), http, storage);
            Assert.True(core.IsSignedIn);

            await core.SignOutAsync();

            Assert.Equal(1, http.Calls);
            Assert.Null(storage.Token);
            Assert.False(core.IsSignedIn);
        }

        [Fact]
        public async Task SignOutPostsLogoutWithTheSessionHeader()
        {
            var storage = new MemoryStorage { Token = "stored-token" };
            var http = new StubHttp(_ => (204, ""));
            var core = new SignInCore(new SignInCoreOptions { BackendBaseUrl = BaseUrl + "/" }, new FakeBrowser(_ => { }), http, storage);

            await core.SignOutAsync();

            RecordedRequest request = Assert.Single(http.Requests);
            Assert.Equal(BaseUrl + "/logout", request.Url);
            Assert.Equal("stored-token", request.Headers["Enlitt-Session"]);
            Assert.Null(storage.Token);
        }

        [Fact]
        public void ForgetSessionClearsWithoutARequest()
        {
            var storage = new MemoryStorage { Token = "stored-token" };
            var http = new ThrowingHttp();
            var core = new SignInCore(new SignInCoreOptions { BackendBaseUrl = BaseUrl }, new FakeBrowser(_ => { }), http, storage);

            core.ForgetSession();

            Assert.Equal(0, http.Calls);
            Assert.Null(storage.Token);
            Assert.False(core.IsSignedIn);
        }

        [Fact]
        public void AuthorizationHeadersThrowsNotSignedInWhenSignedOut()
        {
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl },
                new FakeBrowser(_ => { }),
                new ThrowingHttp(),
                new MemoryStorage());

            EnlittSignInException error = Assert.Throws<EnlittSignInException>(() => core.AuthorizationHeaders());

            Assert.Equal("not_signed_in", error.Code);
        }

        [Fact]
        public void LoadsTheStoredTokenAtConstructionAndSendsItAsTheHeader()
        {
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = BaseUrl },
                new FakeBrowser(_ => { }),
                new ThrowingHttp(),
                new MemoryStorage { Token = "stored-token" });

            Assert.True(core.IsSignedIn);
            Assert.Equal("stored-token", core.AuthorizationHeaders()["Enlitt-Session"]);
        }

        [Fact]
        public async Task NoToStringContainsTheTokenCodeOrVerifier()
        {
            var http = new StubHttp(request => request.Url.EndsWith("/pairing", StringComparison.Ordinal)
                ? (200, "{\"pairing_id\":\"secret-pairing-id\",\"user_code\":\"BCDF-GHJK\",\"verification_uri\":\"https://game.example.com/enlitt/client/pair\",\"expires_in\":600,\"interval\":0}")
                : (200, "{\"session_token\":\"secret-token-123\"}"));
            var options = new SignInCoreOptions { BackendBaseUrl = BaseUrl };
            var core = new SignInCore(options, new FakeBrowser(_ => { }), http, new MemoryStorage());

            PairingInfo info = await core.StartPairingAsync();
            await info.WaitAsync();
            string verifier = System.Text.RegularExpressions.Regex.Match(
                http.Requests.Last().Json, "\"code_verifier\":\"([^\"]+)\"").Groups[1].Value;
            PkcePair pkce = SignInCore.CreatePkce();
            var failure = new EnlittSignInException("invalid_grant", "The sign-in code was not accepted. Try signing in again.");

            string[] texts =
            {
                core.ToString(),
                options.ToString(),
                info.ToString(),
                pkce.ToString(),
                failure.ToString(),
            };
            foreach (string text in texts)
            {
                Assert.DoesNotContain("secret-token-123", text);
                Assert.DoesNotContain("secret-pairing-id", text);
                Assert.DoesNotContain(verifier, text);
                Assert.DoesNotContain(pkce.Verifier, text);
            }

            Assert.Equal("secret-token-123", core.SessionToken);
        }

        [Theory]
        [InlineData("http://game.example.com/enlitt/client")]
        [InlineData("game.example.com/enlitt")]
        [InlineData("")]
        [InlineData("https://game.example.com/enlitt?x=1")]
        [InlineData("https://user:pw@game.example.com/enlitt")]
        public void RejectsAnUnusableBackendBaseUrl(string baseUrl)
        {
            EnlittSignInException error = Assert.Throws<EnlittSignInException>(() => new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = baseUrl },
                new FakeBrowser(_ => { }),
                new ThrowingHttp(),
                new MemoryStorage()));

            Assert.Equal("configuration", error.Code);
        }

        [Theory]
        [InlineData("http://127.0.0.1:3000/enlitt/client")]
        [InlineData("http://localhost:3000/enlitt/client")]
        [InlineData("https://game.example.com/enlitt/client")]
        public void AcceptsHttpsAndLocalHttpBackends(string baseUrl)
        {
            var core = new SignInCore(
                new SignInCoreOptions { BackendBaseUrl = baseUrl },
                new FakeBrowser(_ => { }),
                new ThrowingHttp(),
                new MemoryStorage());

            Assert.False(core.IsSignedIn);
        }
    }

    public sealed class MiniJsonTests
    {
        [Fact]
        public void ParsesScalarMembersAndSkipsNestedValues()
        {
            Dictionary<string, string?>? json = MiniJson.TryParseObject(
                " {\"a\":\"x\\\"y\\u0041\",\"n\":600,\"z\":null,\"o\":{\"k\":[1,{\"q\":\"]\"}]},\"b\":true} ");

            Assert.NotNull(json);
            Assert.Equal("x\"yA", json!["a"]);
            Assert.Equal("600", json["n"]);
            Assert.Null(json["z"]);
            Assert.Equal("true", json["b"]);
            Assert.False(json.ContainsKey("o"));
        }

        [Theory]
        [InlineData("")]
        [InlineData("not json")]
        [InlineData("[1,2]")]
        [InlineData("{\"a\":}")]
        [InlineData("{\"a\":\"x\"")]
        [InlineData("{\"a\":\"x\"} trailing")]
        public void ReturnsNullForAnythingButOneObject(string text)
        {
            Assert.Null(MiniJson.TryParseObject(text));
        }
    }
}
