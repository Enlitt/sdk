using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Enlitt.SignIn.Tests
{
    /// <summary>A browser that hands the opened URL to a test-provided action instead of opening anything.</summary>
    internal sealed class FakeBrowser : IBrowser
    {
        private readonly Action<string> _onOpen;

        public FakeBrowser(Action<string> onOpen)
        {
            _onOpen = onOpen;
        }

        public List<string> Opened { get; } = new List<string>();

        public void Open(string url)
        {
            Opened.Add(url);
            _onOpen(url);
        }
    }

    /// <summary>In-memory token storage.</summary>
    internal sealed class MemoryStorage : ITokenStorage
    {
        public string? Token { get; set; }

        public string? Load() => Token;

        public void Save(string token) => Token = token;

        public void Clear() => Token = null;
    }

    /// <summary>One recorded request of <see cref="StubHttp"/>.</summary>
    internal sealed class RecordedRequest
    {
        public RecordedRequest(string url, string json, IReadOnlyDictionary<string, string> headers)
        {
            Url = url;
            Json = json;
            Headers = headers;
        }

        public string Url { get; }

        public string Json { get; }

        public IReadOnlyDictionary<string, string> Headers { get; }
    }

    /// <summary>An HTTP stub that records requests and answers from a test-provided function.</summary>
    internal sealed class StubHttp : ISignInHttp
    {
        private readonly Func<RecordedRequest, (int Status, string Body)> _respond;

        public StubHttp(Func<RecordedRequest, (int Status, string Body)> respond)
        {
            _respond = respond;
        }

        public List<RecordedRequest> Requests { get; } = new List<RecordedRequest>();

        public Task<(int Status, string Body)> PostJsonAsync(
            string url,
            string json,
            IReadOnlyDictionary<string, string> headers,
            CancellationToken ct)
        {
            var request = new RecordedRequest(url, json, headers);
            lock (Requests)
            {
                Requests.Add(request);
            }

            return Task.FromResult(_respond(request));
        }
    }

    /// <summary>An HTTP client whose every call fails like a dead network.</summary>
    internal sealed class ThrowingHttp : ISignInHttp
    {
        public int Calls { get; private set; }

        public Task<(int Status, string Body)> PostJsonAsync(
            string url,
            string json,
            IReadOnlyDictionary<string, string> headers,
            CancellationToken ct)
        {
            Calls++;
            throw new System.IO.IOException("network down");
        }
    }

    /// <summary>A deep-link source the test raises by hand.</summary>
    internal sealed class FakeDeepLinks : IDeepLinkSource
    {
        public event Action<string>? Received;

        public int Subscribers => Received?.GetInvocationList().Length ?? 0;

        public void Raise(string url) => Received?.Invoke(url);
    }
}
