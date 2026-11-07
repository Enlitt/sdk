// Enlitt sign-in kit: the thin Unity layer.
//
// It wires the engine-independent SignInCore (EnlittSignInCore.cs) to Unity:
// Application.OpenURL as the browser, UnityWebRequest as the HTTP client,
// PlayerPrefs as the default token storage, and Application.deepLinkActivated
// as the deep-link source. All sign-in logic lives in the core.
#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace Enlitt.SignIn
{
    /// <summary>Settings of <see cref="EnlittSignIn"/>.</summary>
    public sealed class EnlittSignInOptions
    {
        /// <summary>
        /// The game backend's client sign-in base: the absolute <c>&lt;appOrigin&gt;&lt;basePath&gt;</c>,
        /// for example <c>https://game.example.com/enlitt/client</c>.
        /// </summary>
        public string BackendBaseUrl { get; set; } = "";

        /// <summary>
        /// The deep-link URL the backend returns to on Android and iOS, for example <c>com.example.game://signin</c>.
        /// It must also be listed in the server's <c>returnUrls</c>. Leave it empty to use the loopback flow everywhere.
        /// </summary>
        public string? ReturnUrl { get; set; }

        /// <summary>How long one sign-in may take. Defaults to 10 minutes.</summary>
        public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(10);

        /// <summary>
        /// Where the session token is kept. Defaults to <see cref="PlayerPrefsTokenStorage"/>, which is not
        /// encrypted; pass a platform keychain storage for anything sensitive.
        /// </summary>
        public ITokenStorage? TokenStorage { get; set; }
    }

    /// <summary>
    /// Stores the session token in <c>PlayerPrefs</c> under the key <c>enlitt.session</c>.
    /// <c>PlayerPrefs</c> is NOT encrypted: on PC it is the registry or a plist readable by anyone with access to
    /// the player's account. Implement <see cref="ITokenStorage"/> over a platform keychain for stronger protection.
    /// </summary>
    public sealed class PlayerPrefsTokenStorage : ITokenStorage
    {
        /// <summary>The <c>PlayerPrefs</c> key the token is stored under.</summary>
        public const string Key = "enlitt.session";

        /// <summary>Returns the stored token, or <c>null</c> when there is none.</summary>
        /// <returns>The stored token, or <c>null</c>.</returns>
        public string? Load()
        {
            string value = PlayerPrefs.GetString(Key, "");
            return value.Length == 0 ? null : value;
        }

        /// <summary>Stores the token and flushes <c>PlayerPrefs</c> to disk.</summary>
        /// <param name="token">The opaque session token.</param>
        public void Save(string token)
        {
            PlayerPrefs.SetString(Key, token);
            PlayerPrefs.Save();
        }

        /// <summary>Removes the stored token.</summary>
        public void Clear()
        {
            PlayerPrefs.DeleteKey(Key);
            PlayerPrefs.Save();
        }

        /// <summary>Returns a fixed description that omits the token.</summary>
        /// <returns>A fixed string.</returns>
        public override string ToString() => "PlayerPrefsTokenStorage";
    }

    /// <summary>Opens URLs with <c>Application.OpenURL</c>. Must be used from the main thread.</summary>
    internal sealed class UnityBrowser : IBrowser
    {
        public void Open(string url)
        {
            Application.OpenURL(url);
        }
    }

    /// <summary>
    /// Delivers <c>Application.deepLinkActivated</c> URLs, plus <c>Application.absoluteURL</c> to a new listener
    /// so a game launched cold by the deep link still sees it. It listens to Unity only while someone is subscribed.
    /// </summary>
    internal sealed class UnityDeepLinkSource : IDeepLinkSource
    {
        private Action<string>? _received;

        public event Action<string> Received
        {
            add
            {
                if (_received == null)
                {
                    Application.deepLinkActivated += OnDeepLinkActivated;
                }

                _received += value;

                // A cold launch by deep link only sets absoluteURL. A stale value from an earlier link is harmless:
                // the core ignores any URL whose state is not the current sign-in's.
                string launchUrl = Application.absoluteURL;
                if (!string.IsNullOrEmpty(launchUrl))
                {
                    value(launchUrl);
                }
            }

            remove
            {
                _received -= value;
                if (_received == null)
                {
                    Application.deepLinkActivated -= OnDeepLinkActivated;
                }
            }
        }

        private void OnDeepLinkActivated(string url)
        {
            _received?.Invoke(url);
        }
    }

    /// <summary>Posts JSON with <c>UnityWebRequest</c> and awaits it as a <see cref="Task"/>.</summary>
    internal sealed class UnityWebRequestHttp : ISignInHttp
    {
        public Task<(int Status, string Body)> PostJsonAsync(
            string url,
            string json,
            IReadOnlyDictionary<string, string> headers,
            CancellationToken ct)
        {
            var completion = new TaskCompletionSource<(int Status, string Body)>();
            if (ct.IsCancellationRequested)
            {
                completion.SetCanceled();
                return completion.Task;
            }

            var request = new UnityWebRequest(url, "POST")
            {
                uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(json)),
                downloadHandler = new DownloadHandlerBuffer(),
            };
            request.SetRequestHeader("Content-Type", "application/json");
            foreach (KeyValuePair<string, string> header in headers)
            {
                request.SetRequestHeader(header.Key, header.Value);
            }

            // UnityWebRequest.Abort must run on the main thread, but a timeout cancels on a timer thread.
            SynchronizationContext? mainThread = SynchronizationContext.Current;
            bool finished = false;
            CancellationTokenRegistration registration = ct.Register(() =>
            {
                void Abort()
                {
                    if (!finished)
                    {
                        request.Abort();
                    }
                }

                if (mainThread != null)
                {
                    mainThread.Post(_ => Abort(), null);
                }
                else
                {
                    Abort();
                }
            });

            UnityWebRequestAsyncOperation operation = request.SendWebRequest();
            operation.completed += _ =>
            {
                finished = true;
                registration.Dispose();
                try
                {
                    if (ct.IsCancellationRequested)
                    {
                        completion.TrySetCanceled(ct);
                    }
                    else if (request.result == UnityWebRequest.Result.ConnectionError
                        || request.result == UnityWebRequest.Result.DataProcessingError)
                    {
                        // A protocol error (HTTP 4xx/5xx) is a normal answer; only transport failures throw.
                        completion.TrySetException(new IOException(request.error));
                    }
                    else
                    {
                        completion.TrySetResult(((int)request.responseCode, request.downloadHandler.text ?? ""));
                    }
                }
                finally
                {
                    request.Dispose();
                }
            };
            return completion.Task;
        }
    }

    /// <summary>
    /// Signs players in to a game that uses an Enlitt server SDK. It is a secret-free client of the sign-in handler
    /// in the game's backend: it opens the browser, redeems the one-time code at the backend, stores the session
    /// token, and adds the <c>Enlitt-Session</c> header to the game's own requests. It never talks to Enlitt.
    /// </summary>
    public sealed class EnlittSignIn
    {
        private readonly SignInCore _core;
        private readonly bool _useDeepLink;

        /// <summary>Creates the kit and loads any stored session.</summary>
        /// <param name="options">The backend address and optional deep link, timeout and storage.</param>
        /// <exception cref="EnlittSignInException">With code <c>configuration</c> when the options are unusable.</exception>
        public EnlittSignIn(EnlittSignInOptions options)
        {
            if (options == null)
            {
                throw new ArgumentNullException(nameof(options));
            }

            var coreOptions = new SignInCoreOptions
            {
                BackendBaseUrl = options.BackendBaseUrl,
                ReturnUrl = string.IsNullOrEmpty(options.ReturnUrl) ? null : options.ReturnUrl,
                Timeout = options.Timeout,
            };
            _core = new SignInCore(
                coreOptions,
                new UnityBrowser(),
                new UnityWebRequestHttp(),
                options.TokenStorage ?? new PlayerPrefsTokenStorage(),
                new UnityDeepLinkSource());
            RuntimePlatform platform = Application.platform;
            _useDeepLink = coreOptions.ReturnUrl != null
                && (platform == RuntimePlatform.Android || platform == RuntimePlatform.IPhonePlayer);
        }

        /// <summary>True when a session token is held.</summary>
        public bool IsSignedIn => _core.IsSignedIn;

        /// <summary>
        /// Signs the player in through the browser. It uses the deep link on Android and iOS when
        /// <see cref="EnlittSignInOptions.ReturnUrl"/> is set, and a loopback listener everywhere else.
        /// Call it from the main thread. WebGL is refused: a WebGL game is a web page and uses the web cookie flow.
        /// </summary>
        /// <param name="ct">Cancels the sign-in.</param>
        /// <returns>A task that completes when the session is stored.</returns>
        /// <exception cref="EnlittSignInException">With the code describing why sign-in failed.</exception>
        public Task SignInAsync(CancellationToken ct = default)
        {
            if (Application.platform == RuntimePlatform.WebGLPlayer)
            {
                return Task.FromException(new EnlittSignInException(
                    SignInErrorCode.Configuration,
                    "WebGL games are web pages and use the web cookie flow, not this kit."));
            }

            return _useDeepLink ? _core.SignInWithRedirectAsync(ct) : _core.SignInWithLoopbackAsync(ct);
        }

        /// <summary>
        /// Starts a pairing for a device without a usable browser: show the returned code and page to the
        /// player, then await <see cref="PairingInfo.WaitAsync"/>.
        /// </summary>
        /// <param name="ct">Cancels the request.</param>
        /// <returns>The code to show and the means to wait for confirmation.</returns>
        public Task<PairingInfo> StartPairingAsync(CancellationToken ct = default)
        {
            return _core.StartPairingAsync(ct);
        }

        /// <summary>Asks the backend to revoke the session, ignoring failures, and always clears the stored token.</summary>
        /// <param name="ct">Cancels the revoke request.</param>
        /// <returns>A task that completes once the local session is cleared.</returns>
        public Task SignOutAsync(CancellationToken ct = default)
        {
            return _core.SignOutAsync(ct);
        }

        /// <summary>
        /// Clears the stored session with no request. Call it when the game backend reports that the session is
        /// no longer valid, for example with HTTP 401.
        /// </summary>
        public void ForgetSession()
        {
            _core.ForgetSession();
        }

        /// <summary>
        /// Adds the <c>Enlitt-Session</c> header to a request for the game's own backend. Never use it on a request
        /// to any other host.
        /// </summary>
        /// <param name="request">The request to authorize.</param>
        /// <exception cref="EnlittSignInException">With code <c>not_signed_in</c> when signed out.</exception>
        public void Authorize(UnityWebRequest request)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            foreach (KeyValuePair<string, string> header in _core.AuthorizationHeaders())
            {
                request.SetRequestHeader(header.Key, header.Value);
            }
        }

        /// <summary>Returns a fixed description that omits the session token.</summary>
        /// <returns>A short description.</returns>
        public override string ToString() => "EnlittSignIn(signedIn=" + (IsSignedIn ? "true" : "false") + ")";
    }
}
