import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENLITT_API_VERSION, type EnlittErrorBody } from "@enlitt/protocol";
import {
  EnlittConfigurationError,
  EnlittError,
  EnlittLoginRequiredError,
  EnlittRateLimitError
} from "./errors.js";
import { runWithEnlittSession, type EnlittSession } from "./session.js";
import {
  ENLITT_STANDARD_MODEL,
  type EnlittOptions as EntryOptions,
  type EnlittProviderOptions as EntryProviderOptions,
  type EnlittTarget as EntryTarget
} from "../server/index.js";
import {
  createInternalClient,
  reportEnlittPremiumTerminal,
  requestEnlitt,
  type EnlittRequestInit,
  type InternalEnlittClient
} from "./transport.js";

const SECRET_KEY = "sk_test_1234567890";
const SESSION: EnlittSession = { token: "session-token-abc" };

function errorBody(code: string, message = "refused"): EnlittErrorBody {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code
    }
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function baseClient(overrides: Partial<Parameters<typeof createInternalClient>[0]> = {}): InternalEnlittClient {
  return createInternalClient({
    secretKey: SECRET_KEY,
    baseUrl: "https://enlitt.example",
    session: SESSION,
    ...overrides
  });
}

function baseInit(overrides: Partial<EnlittRequestInit> = {}): EnlittRequestInit {
  return {
    path: "/v1/enlitt/operations",
    body: { mode: "premium" },
    callId: "call-id-0123456789abcdef",
    accept: "application/json",
    ...overrides
  };
}

describe("createInternalClient / resolveSession", () => {
  it("uses the explicit session when one was given", () => {
    const client = baseClient({ session: SESSION });
    expect(client.resolveSession()).toEqual(SESSION);
  });

  it("throws EnlittConfigurationError when there is no ambient context at all", () => {
    const client = createInternalClient({ secretKey: SECRET_KEY, baseUrl: "https://enlitt.example" });
    expect(() => client.resolveSession()).toThrow(EnlittConfigurationError);
  });

  it("throws EnlittLoginRequiredError with providerInvoked: false when the context holds null", () => {
    const client = createInternalClient({ secretKey: SECRET_KEY, baseUrl: "https://enlitt.example" });
    runWithEnlittSession(null, () => {
      let caught: unknown;
      try {
        client.resolveSession();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EnlittLoginRequiredError);
      expect((caught as EnlittError).providerInvoked).toBe(false);
    });
  });

  it("resolves the session from the ambient context when one is present", () => {
    const client = createInternalClient({ secretKey: SECRET_KEY, baseUrl: "https://enlitt.example" });
    runWithEnlittSession(SESSION, () => {
      expect(client.resolveSession()).toEqual(SESSION);
    });
  });

  it("folds caller rate-limit options over the SDK defaults exactly once", () => {
    const client = baseClient({ rateLimit: { maxAttempts: 9 } });
    expect(client.rateLimit.maxAttempts).toBe(9);
    expect(client.rateLimit.maxTotalWaitMs).toBeGreaterThan(0);
  });
});

describe("requestEnlitt: headers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends exactly the documented header set, with one Authorization, one X-Enlitt-User-Authorization, and Idempotency-Key equal to the call ID", async () => {
    const client = baseClient();
    await requestEnlitt(client, baseInit({ callId: "the-exact-call-id-000000000000" }));

    const [, requestOptions] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(requestOptions.headers);

    expect(headers.get("authorization")).toBe(client.businessAuthorization);
    expect(headers.get("x-enlitt-user-authorization")).toBe(`Bearer ${SESSION.token}`);
    expect(headers.get("idempotency-key")).toBe("the-exact-call-id-000000000000");
    expect(headers.get("enlitt-version")).toBe(ENLITT_API_VERSION);
    expect(headers.get("x-enlitt-sdk-version")).toBe(client.sdkVersion);

    // The whole set, not a list of named absences: an assertion that one
    // particular header is missing only holds while somebody remembers that
    // header exists, and this one catches the next unlisted header too —
    // including any capability, routing, or policy hint the server would then
    // have to reconcile against the body it was derived from.
    expect([...headers.keys()].sort()).toEqual([
      "accept",
      "authorization",
      "content-type",
      "enlitt-version",
      "idempotency-key",
      "x-enlitt-sdk-version",
      "x-enlitt-user-authorization",
      "x-request-id"
    ]);

    let authorizationCount = 0;
    let personalCount = 0;
    for (const name of headers.keys()) {
      if (name === "authorization") authorizationCount++;
      if (name === "x-enlitt-user-authorization") personalCount++;
    }
    expect(authorizationCount).toBe(1);
    expect(personalCount).toBe(1);
  });

  it("takes the personal credential only from client.resolveSession(), never from init", async () => {
    const client = baseClient({ session: { token: "only-this-token" } });
    await requestEnlitt(
      client,
      baseInit({ body: { mode: "premium", token: "attacker-supplied-token", user: "someone-else" } })
    );

    const [, requestOptions] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(requestOptions.headers);
    expect(headers.get("x-enlitt-user-authorization")).toBe("Bearer only-this-token");
  });

  it("sends an SDK version header and a bounded X-Request-Id", async () => {
    const client = baseClient();
    await requestEnlitt(client, baseInit());
    const [, requestOptions] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(requestOptions.headers);
    expect(headers.get("x-enlitt-sdk-version")).toBe(client.sdkVersion);
    expect(headers.get("x-request-id")?.length).toBeGreaterThan(0);
    expect(headers.get("x-request-id")?.length).toBeLessThan(128);
  });

  it("never follows a redirect", async () => {
    // "manual", not "error": the Cloudflare Workers runtime rejects "error"
    // with a TypeError before sending, which failed every call from a Worker.
    await requestEnlitt(baseClient(), baseInit());
    const [, requestOptions] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestOptions.redirect).toBe("manual");
  });

  it("refuses a 3xx answer as transport_failed without following it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/v1/x" } })
    );
    const error = await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("transport_failed");
    expect((error as EnlittError).message).toBe("Enlitt answered with a redirect, which the SDK never follows.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("requestEnlitt: HTTPS enforcement", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ok: true }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an http: base URL for a non-local host", async () => {
    // Enforced when the client is built, so a misconfigured deployment fails
    // before any request or provider call.
    expect(() => baseClient({ baseUrl: "http://enlitt.example" })).toThrow(EnlittConfigurationError);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("accepts http: for local host %s", async (host) => {
    const client = baseClient({ baseUrl: `http://${host}:4000` });
    await expect(requestEnlitt(client, baseInit())).resolves.toBeInstanceOf(Response);
  });

  it("accepts https: for any host", async () => {
    const client = baseClient({ baseUrl: "https://production.enlitt.example" });
    await expect(requestEnlitt(client, baseInit())).resolves.toBeInstanceOf(Response);
  });

  it("has no environment flag that relaxes HTTPS enforcement", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(() => baseClient({ baseUrl: "http://not-local.example" })).toThrow(EnlittConfigurationError);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe("requestEnlitt: redirects, bounds, and normalization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails rather than following a 3xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("unexpected redirect");
      })
    );
    const error = await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).providerInvoked).toBe(false);
  });

  it("normalizes a response whose headers exceed the bounded size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const headers = new Headers();
        headers.set("x-oversized", "a".repeat(64 * 1024));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      })
    );
    await expect(requestEnlitt(baseClient(), baseInit())).rejects.toThrow(EnlittError);
  });

  it("normalizes a response whose body exceeds the bounded size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const oversized = "a".repeat(2 * 1024 * 1024);
        return new Response(oversized, {
          status: 200,
          headers: { "content-length": String(oversized.length) }
        });
      })
    );
    await expect(requestEnlitt(baseClient(), baseInit())).rejects.toThrow(EnlittError);
  });

  it("normalizes a network failure that never produced a response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const error = await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("transport_failed");
  });

  it("normalizes a response body that cannot be parsed as JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 400 }))
    );
    const error = await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe("malformed_response");
  });

  it.each([
    ["personal_login_required", 401],
    ["invalid_api_key", 401],
    ["insufficient_permissions", 403],
    ["premium_balance_exhausted", 403],
    ["conflict_error", 409],
    ["not_found", 404]
  ])("normalizes a %s response to a typed error and never retries it", async (code, status) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, errorBody(code)));
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EnlittError);
    expect((error as EnlittError).code).toBe(code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never logs or exposes the session token in a thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, errorBody("invalid_api_key")))
    );
    let error: unknown;
    await requestEnlitt(baseClient(), baseInit()).catch((thrown: unknown) => {
      error = thrown;
    });
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(SESSION.token);
  });
});

describe("requestEnlitt: rate-limit wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries after a refusal and returns the eventual success, reporting the wait through onRateLimit", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return jsonResponse(429, errorBody("rate_limit_exceeded"), { "retry-after": "1" });
        }
        return jsonResponse(200, { ok: true });
      })
    );
    vi.spyOn(Math, "random").mockReturnValue(0);

    const onRateLimit = vi.fn();
    const client = baseClient({ rateLimit: { onRateLimit } });

    const promise = requestEnlitt(client, baseInit());
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(1, 1_000);
  });

  it("waits the deployed default when Retry-After is absent", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? jsonResponse(429, errorBody("rate_limit_exceeded")) : jsonResponse(200, { ok: true });
      })
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRateLimit = vi.fn();
    const client = baseClient({ rateLimit: { onRateLimit } });

    const promise = requestEnlitt(client, baseInit());
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(onRateLimit).toHaveBeenCalledWith(1, 1_000);
  });

  it("ends the wait at maxAttempts and rethrows the last EnlittRateLimitError, still retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "retry-after": "1" }))
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = baseClient({ rateLimit: { maxAttempts: 3, maxTotalWaitMs: 1_000_000 } });

    const promise = requestEnlitt(client, baseInit());
    const assertion = expect(promise).rejects.toBeInstanceOf(EnlittRateLimitError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    let caught: unknown;
    await promise.catch((thrown: unknown) => {
      caught = thrown;
    });
    expect((caught as EnlittRateLimitError).retryable).toBe(true);
  });

  it("performs exactly one request when maxAttempts is one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(429, errorBody("rate_limit_exceeded")));
    vi.stubGlobal("fetch", fetchMock);
    const client = baseClient({ rateLimit: { maxAttempts: 1 } });

    await expect(requestEnlitt(client, baseInit())).rejects.toBeInstanceOf(EnlittRateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ends the wait at maxTotalWaitMs even when attempts remain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "retry-after": "10" }))
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = baseClient({ rateLimit: { maxAttempts: 1_000, maxTotalWaitMs: 15_000 } });

    const promise = requestEnlitt(client, baseInit());
    const assertion = expect(promise).rejects.toBeInstanceOf(EnlittRateLimitError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("raises the caller's abort reason, not a rate-limit error, when aborted mid-wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "retry-after": "10" }))
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const controller = new AbortController();
    const client = baseClient();

    const promise = requestEnlitt(client, baseInit({ signal: controller.signal }));
    const abortReason = new Error("caller gave up");
    setTimeout(() => controller.abort(abortReason), 100);
    const assertion = expect(promise).rejects.toBe(abortReason);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("produces distinct retry instants above the advertised floor for many identically-refused calls", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, errorBody("rate_limit_exceeded"), { "retry-after": "1" }))
    );
    vi.restoreAllMocks();

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler: TimerHandler, timeout?: number) => {
      if (timeout !== undefined) {
        delays.push(timeout);
      }
      return originalSetTimeout(handler as () => void, 0);
    });

    // maxAttempts: 2 means every one of the 20 calls waits exactly once before its second, final refusal.
    const retryingClient = baseClient({ rateLimit: { maxAttempts: 2 } });
    for (let i = 0; i < 20; i++) {
      await requestEnlitt(retryingClient, baseInit()).catch(() => undefined);
    }

    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every((delay) => delay >= 1_000)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("never enters the wait for a status other than 429 rate_limit_exceeded", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(429, errorBody("conflict_error")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestEnlitt(baseClient(), baseInit())).rejects.toThrow(EnlittError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("reportEnlittPremiumTerminal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries a transient transport failure and reuses the identical body and call ID across attempts", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const seenBodies: unknown[] = [];
    const seenCallIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        attempts++;
        seenBodies.push(options.body);
        seenCallIds.push(new Headers(options.headers).get("idempotency-key") ?? "");
        if (attempts < 2) {
          throw new TypeError("fetch failed");
        }
        return jsonResponse(200, { ok: true });
      })
    );

    const init = baseInit({ path: "/v1/enlitt/operations/op_1/terminal", body: { report_id: "report-1" } });
    const promise = reportEnlittPremiumTerminal(baseClient(), init);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await promise;

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(new Set(seenBodies).size).toBe(1);
    expect(new Set(seenCallIds).size).toBe(1);
  });

  it("gives up after the bounded attempt count and reports through onTerminalReportError", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    const onTerminalReportError = vi.fn();
    const client = baseClient({ onTerminalReportError });

    const promise = reportEnlittPremiumTerminal(client, baseInit());
    const assertion = expect(promise).rejects.toBeInstanceOf(EnlittError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(onTerminalReportError).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("never retries a refusal", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(409, errorBody("conflict_error")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reportEnlittPremiumTerminal(baseClient(), baseInit())).rejects.toThrow(EnlittError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a GET with the version headers and neither an Idempotency-Key nor a body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = baseClient();
    await requestEnlitt(client, { path: "/v1/enlitt/usage", method: "GET", accept: "application/json" });

    const [url, requestOptions] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(requestOptions.headers);
    expect(url).toBe("https://enlitt.example/v1/enlitt/usage");
    expect(requestOptions.method).toBe("GET");
    expect(requestOptions.body).toBeUndefined();
    expect(headers.has("idempotency-key")).toBe(false);
    expect(headers.has("content-type")).toBe(false);
    expect(headers.get("enlitt-version")).toBe(ENLITT_API_VERSION);
  });
});

describe("package build: public surfaces", () => {
  /** Sorted own export names of a module namespace. */
  function surface(entry: Record<string, unknown>): string[] {
    return Object.keys(entry).sort();
  }

  const CORE_SURFACE = [
    "ENLITT_SESSION_COOKIE_NAME",
    "ENLITT_SESSION_HEADER_NAME",
    "EnlittAuthenticationError",
    "EnlittAuthorizationError",
    "EnlittConfigurationError",
    "EnlittError",
    "EnlittInsufficientCreditsError",
    "EnlittLimitExceededError",
    "EnlittLoginRequiredError",
    "EnlittRateLimitError",
    "EnlittSubscriptionInactiveError",
    "enlittSession",
    "enlittSessionMiddleware",
    "getEnlittSession",
    "runWithEnlittSession",
    "usage",
    "withPremiumCharge"
  ];
  const VERCEL_SURFACE = ["ENLITT_STANDARD_MODEL", "enlitt", "perToken"];

  it("@enlitt/sdk/core exports exactly its documented surface and no internal transport", async () => {
    const entry: Record<string, unknown> = await import("./index.js");
    expect(surface(entry)).toEqual([...CORE_SURFACE].sort());
    for (const hidden of ["requestEnlitt", "createInternalClient", "createSseEventStream", "runPremiumCharge"]) {
      expect(entry[hidden], hidden).toBeUndefined();
    }
  });

  it("@enlitt/sdk/vercel exports exactly its documented surface", async () => {
    const entry: Record<string, unknown> = await import("../vercel/index.js");
    expect(surface(entry)).toEqual([...VERCEL_SURFACE].sort());
  });

  it("@enlitt/sdk/server stays source compatible: the union of core and vercel plus the Account login helpers", async () => {
    const entry: Record<string, unknown> = await import("../server/index.js");
    expect(surface(entry)).toEqual(
      [
        ...CORE_SURFACE,
        ...VERCEL_SURFACE,
        "createCallbackHandler",
        "createClientSignInHandler",
        "createLoginStartHandler",
        "createLogoutHandler",
        "createMemoryClientSignInStore"
      ].sort()
    );
    expect(entry.resolveBusinessAuthorizationHeader).toBeUndefined();
  });

  it("lets a business name the factory's own types from the old server path instead of restating them", () => {
    // A compile-time assertion: a wrapper around `enlitt()` has to name these
    // in its own signature. If any stops being exported from the entry, this
    // file stops typechecking.
    const target: EntryTarget = ENLITT_STANDARD_MODEL;
    const options: EntryOptions = { secretKey: "sk_test_surface" };
    const call: EntryProviderOptions = { idempotencyKey: "a-business-supplied-key" };

    expect(target).toBe(ENLITT_STANDARD_MODEL);
    expect(options.secretKey).toBe("sk_test_surface");
    expect(call.idempotencyKey).toBe("a-business-supplied-key");
  });

  it("package.json resolves every server entry through the throwing browser condition and exports no internals", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string> | string>;
    };
    for (const subpath of ["./core", "./vercel", "./openai", "./server"]) {
      const conditions = manifest.exports[subpath] as Record<string, string>;
      expect(conditions.browser, subpath).toBe("./dist/server-unavailable.js");
    }
    expect(Object.keys(manifest.exports).sort()).toEqual(
      [".", "./browser", "./core", "./openai", "./package.json", "./server", "./vercel"].sort()
    );
  });
});

describe("package build: the dependency boundary", () => {
  /** Every non-test source file of one directory, with its text. */
  async function sourcesOf(directory: string): Promise<{ name: string; text: string }[]> {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = new URL(`../${directory}/`, import.meta.url);
    const names = (await readdir(root)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    return Promise.all(names.map(async (name) => ({ name, text: await readFile(new URL(name, root), "utf8") })));
  }

  /** Module specifiers a file imports or re-exports from (static form only). */
  function specifiersOf(text: string): string[] {
    return [...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  }

  it("core never imports a framework SDK or adapter", async () => {
    for (const { name, text } of await sourcesOf("core")) {
      for (const specifier of specifiersOf(text)) {
        expect(specifier, `core/${name} imports ${specifier}`).not.toMatch(/^(ai|@ai-sdk\/.*)$/);
        expect(specifier, `core/${name} imports ${specifier}`).not.toMatch(/vercel|openai/);
      }
    }
  });

  it("the packed core entry contains no framework reference when a build exists", async () => {
    const { readFile } = await import("node:fs/promises");
    let packed: string;
    try {
      packed = await readFile(new URL("../../dist/core.js", import.meta.url), "utf8");
    } catch {
      return; // No build output in this checkout: the source-graph test above still ran.
    }
    expect(packed).not.toMatch(/@ai-sdk|from ["']ai["']|vercel|openai/);
  });
});
