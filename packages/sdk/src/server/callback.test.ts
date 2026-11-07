/**
 * `packages/sdk/src/server/callback.ts`. No database, no network — `fetch` is
 * stubbed per test and the `StateStore` is an in-memory fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCallbackHandler, createLoginStartHandler, createLogoutHandler } from "./callback.js";
import type { CallbackConfig, StateRecord, StateStore } from "./callback.js";
import { ENLITT_SESSION_COOKIE_NAME } from "../core/session.js";
import { ENLITT_API_VERSION, ENLITT_VERSION_HEADER } from "@enlitt/protocol";

/** Mirrors the private alphabet in `callback.ts`, for the distribution test. */
const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const STATE_LENGTH = 32;

const APP_ORIGIN = "https://app.example.com";
const ENLITT_ORIGIN = "https://api.enlitt.test";
const REDIRECT_URI = "https://app.example.com/auth/callback";
const CLIENT_ID = "client-123";
const SECRET_KEY = "enl_live_business_secret";
const SUBJECT = "sub_verified_application_user";

class MemoryStateStore implements StateStore {
  private readonly map = new Map<string, StateRecord>();

  async set(state: string, record: StateRecord, _ttlMs: number): Promise<void> {
    this.map.set(state, record);
  }

  async get(state: string): Promise<StateRecord | null> {
    return this.map.get(state) ?? null;
  }

  async consume(state: string): Promise<StateRecord | null> {
    const record = this.map.get(state) ?? null;
    this.map.delete(state);
    return record;
  }
}

function baseConfig(overrides: Partial<CallbackConfig> = {}): CallbackConfig {
  return {
    clientId: CLIENT_ID,
    secretKey: SECRET_KEY,
    redirectUri: REDIRECT_URI,
    enlittOrigin: ENLITT_ORIGIN,
    appOrigin: APP_ORIGIN,
    defaultReturnTo: "/home",
    stateStore: new MemoryStateStore(),
    ...overrides
  };
}

function locationOf(response: Response): URL {
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  return new URL(location!);
}

function setCookieHeaders(response: Response): string[] {
  // `Headers` folds repeated `set-cookie` entries under Node's Fetch
  // implementation; `getSetCookie()` is the one API that still separates them.
  const withGetSetCookie = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const single = response.headers.get("set-cookie");
  return single === null ? [] : [single];
}

async function stateFor(store: StateStore, record: Omit<StateRecord, "createdAt" | "expiresAt"> & Partial<StateRecord>): Promise<string> {
  const state = `fixed-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await store.set(
    state,
    { createdAt: now, expiresAt: now + 60_000, ...record },
    60_000
  );
  return state;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {})
  ];
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* createLoginStartHandler                                                    */
/* -------------------------------------------------------------------------- */

describe("createLoginStartHandler", () => {
  it("redirects carrying the exact clientId and redirectUri", async () => {
    const handler = createLoginStartHandler(baseConfig());
    const response = await handler(new Request("https://app.example.com/login"));

    expect(response.status).toBe(303);
    const location = locationOf(response);
    expect(location.origin).toBe(ENLITT_ORIGIN);
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("state")).not.toBeNull();
  });

  it("issues distinct, unpredictable state values across repeated starts", async () => {
    const handler = createLoginStartHandler(baseConfig());
    const states = new Set<string>();

    for (let i = 0; i < 500; i += 1) {
      const response = await handler(new Request("https://app.example.com/login"));
      const state = locationOf(response).searchParams.get("state");
      expect(state).not.toBeNull();
      expect(state).toHaveLength(STATE_LENGTH);
      states.add(state!);
    }

    expect(states.size).toBe(500);
  });

  it("draws state characters uniformly over the declared alphabet (not a modulo-biased reduction)", async () => {
    const handler = createLoginStartHandler(baseConfig());
    const sampleCount = 4_000;
    const counts = new Map<string, number>();
    for (const char of STATE_ALPHABET) counts.set(char, 0);

    for (let i = 0; i < sampleCount; i += 1) {
      const response = await handler(new Request("https://app.example.com/login"));
      const state = locationOf(response).searchParams.get("state")!;
      expect(state).toMatch(new RegExp(`^[${STATE_ALPHABET}]{${STATE_LENGTH}}$`));
      for (const char of state) counts.set(char, (counts.get(char) ?? 0) + 1);
    }

    const totalChars = sampleCount * STATE_LENGTH;
    const expected = totalChars / STATE_ALPHABET.length;
    // Pearson chi-squared goodness-of-fit against a uniform distribution over
    // 62 categories (df = 61). A plain `byte % 62` reduction over-represents
    // the first `256 % 62 = 8` symbols and would blow this statistic far past
    // any reasonable critical value; a rejection-sampled draw should land
    // comfortably under it. The 0.0001-significance critical value for df=61
    // is about 122; 400 leaves generous margin against sampling noise while
    // still catching a real bias of this size.
    let chiSquared = 0;
    for (const observed of counts.values()) {
      chiSquared += (observed - expected) ** 2 / expected;
    }
    expect(chiSquared).toBeLessThan(400);
  });
});

/* -------------------------------------------------------------------------- */
/* createCallbackHandler                                                      */
/* -------------------------------------------------------------------------- */

function successfulExchangeFetch(token = "opaque-session-token", expiresIn?: number): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(
      JSON.stringify(expiresIn === undefined ? { session_token: token, subject: SUBJECT } : { session_token: token, subject: SUBJECT, expires_in: expiresIn }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
}

describe("createCallbackHandler", () => {
  it("awaits the verified sign-in hook and preserves the application's session cookie", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, { returnTo: "/chat" });
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const onSignIn = vi.fn(async (identity: { readonly subject: string }, response: Response) => {
      expect(identity).toEqual({ subject: SUBJECT });
      expect(response.headers.has("set-cookie")).toBe(false);
      // A local session is application-owned; it is never the subject itself.
      await Promise.resolve();
      response.headers.append("set-cookie", "app_session=local-session; Path=/; HttpOnly; Secure; SameSite=Lax");
    });
    const handler = createCallbackHandler(baseConfig({ stateStore: store, onSignIn }));
    // A caller-supplied subject must never override the exchange's identity.
    const request = new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc&subject=attacker`);
    const response = await handler(request);
    expect(response.status).toBe(303);
    expect(locationOf(response).pathname).toBe("/chat");
    expect(setCookieHeaders(response)).toEqual([
      "app_session=local-session; Path=/; HttpOnly; Secure; SameSite=Lax",
      "enlitt_session=opaque-session-token; Path=/; HttpOnly; Secure; SameSite=Lax"
    ]);
    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get(ENLITT_VERSION_HEADER)).toBe(ENLITT_API_VERSION);
    expect(await response.text()).toBe("");
    expect(locationOf(response).href).not.toContain(SUBJECT);
    await handler(request);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 42, "", "not a subject", "s".repeat(256)])(
    "does not sign in or call the hook for malformed subject %s",
    async (subject) => {
      const store = new MemoryStateStore();
      const state = await stateFor(store, {});
      const onSignIn = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session_token: "token", subject })));
      const handler = createCallbackHandler(baseConfig({ stateStore: store, onSignIn }));
      const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc&subject=forged`));
      expect(setCookieHeaders(response)).toEqual([]);
      expect(onSignIn).not.toHaveBeenCalled();
    }
  );

  it.each(["invalid-state", "canceled", "failed-exchange"])("never calls the sign-in hook after %s", async (failure) => {
    const store = new MemoryStateStore();
    const state = failure === "invalid-state" ? "unknown" : await stateFor(store, {});
    const onSignIn = vi.fn();
    const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig({ stateStore: store, onSignIn }));
    const query = failure === "canceled" ? "error=access_denied" : "code=abc";
    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&${query}`));
    expect(setCookieHeaders(response)).toEqual([]);
    expect(onSignIn).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(failure === "failed-exchange" ? 1 : 0);
  });

  it("propagates local user/session setup failures before setting the Enlitt cookie", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    const cause = new Error("Local user database unavailable");
    let pendingResponse: Response | undefined;
    vi.stubGlobal("fetch", successfulExchangeFetch());
    const handler = createCallbackHandler(baseConfig({
      stateStore: store,
      onSignIn: async (_identity, response) => {
        pendingResponse = response;
        throw cause;
      }
    }));
    await expect(handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`))).rejects.toBe(cause);
    expect(pendingResponse?.headers.has("set-cookie")).toBe(false);
  });

  it("reads future exchange fields tolerantly without forwarding them to the hook", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    const onSignIn = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session_token: "token", subject: SUBJECT, future: true })));
    const handler = createCallbackHandler(baseConfig({ stateStore: store, onSignIn }));
    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));
    expect(onSignIn.mock.calls[0]![0]).toEqual({ subject: SUBJECT });
    expect(setCookieHeaders(response)).toHaveLength(1);
  });

  it("refuses a missing state before any exchange, with no cookie set", async () => {
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig());

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?code=abc`));

    expect(response.status).toBe(303);
    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown state before any exchange, with no cookie set", async () => {
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig());

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=never-issued&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an expired state before any exchange, with no cookie set", async () => {
    const store = new MemoryStateStore();
    const now = Date.now();
    const state = "expired-state";
    await store.set(state, { createdAt: now - 120_000, expiresAt: now - 1 }, 1);
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a replayed state on the second use, with no cookie set the second time", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    vi.stubGlobal("fetch", successfulExchangeFetch());
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const first = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));
    expect(setCookieHeaders(first).length).toBe(1);

    const second = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));
    expect(locationOf(second).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(second)).toHaveLength(0);
  });

  it("refuses a state issued for a different business (a foreign state store), with no cookie set", async () => {
    const storeA = new MemoryStateStore();
    const storeB = new MemoryStateStore();
    const stateFromA = await stateFor(storeA, {});
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const handlerB = createCallbackHandler(baseConfig({ stateStore: storeB }));

    const response = await handlerB(new Request(`${APP_ORIGIN}/auth/callback?state=${stateFromA}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authenticates the exchange with the business secret and sets exactly one HttpOnly, Secure, SameSite=Lax cookie on appOrigin", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, { returnTo: "/dashboard" });
    const fetchSpy = successfulExchangeFetch("super-secret-token", 3600);
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=the-code`));

    expect(response.status).toBe(303);
    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/dashboard`);

    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0]!;
    expect(cookie).toMatch(/^enlitt_session=super-secret-token;/);
    // Asserted against the shared constant, not a literal: `callback.ts` mints
    // this cookie and the session middleware reads it, so a test that restated
    // the name would go on passing after the two ends drifted apart.
    expect(cookie.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestedUrl, requestInit] = fetchSpy.mock.calls[0]!;
    expect(new URL(requestedUrl as string | URL).origin).toBe(ENLITT_ORIGIN);
    const headers = new Headers((requestInit as RequestInit).headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);

    // The token appears nowhere but the cookie: not in the redirect URL, not
    // in the response body (there is none), not in anything logged.
    expect(locationOf(response).toString()).not.toContain("super-secret-token");
    const body = await response.text();
    expect(body).toBe("");
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("sends the exchange to enlittApiOrigin when given, while login-start keeps the dashboard host", async () => {
    // A same-zone Cloudflare Worker cannot reach the route-bound backend behind
    // `enlittOrigin/auth/*`, so the server-to-server exchange must be able to
    // target the API host on its own.
    const apiOrigin = "https://api.enlitt.test";
    const store = new MemoryStateStore();
    const config = baseConfig({ stateStore: store, enlittApiOrigin: apiOrigin });

    const start = await createLoginStartHandler(config)(new Request(`${APP_ORIGIN}/auth/login`));
    expect(locationOf(start).origin).toBe(ENLITT_ORIGIN);

    const state = await stateFor(store, {});
    const fetchSpy = successfulExchangeFetch("token", 3600);
    vi.stubGlobal("fetch", fetchSpy);
    await createCallbackHandler(config)(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=c`));
    const [requestedUrl] = fetchSpy.mock.calls[0]!;
    expect(new URL(requestedUrl as string | URL).toString()).toBe(`${apiOrigin}/auth/oauth2/token`);
  });

  it("refuses a malformed enlittApiOrigin when the handler is built", () => {
    expect(() => createCallbackHandler(baseConfig({ enlittApiOrigin: "not a url" }))).toThrow(/enlittApiOrigin/);
  });

  it("rejects a returnTo on another origin in favor of defaultReturnTo", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, { returnTo: "https://evil.com/steal" });
    vi.stubGlobal("fetch", successfulExchangeFetch());
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
  });

  it("rejects a scheme-relative //evil.com target in favor of defaultReturnTo", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, { returnTo: "//evil.com/steal" });
    vi.stubGlobal("fetch", successfulExchangeFetch());
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
  });

  it("rejects an encoded traversal in favor of defaultReturnTo", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, { returnTo: "/a%2f..%2f..%2fadmin" });
    vi.stubGlobal("fetch", successfulExchangeFetch());
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
  });

  it("yields a signed-out response with no cookie when Enlitt reports an error", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    const fetchSpy = successfulExchangeFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&error=access_denied`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // After a live `state`, a signed-out outcome goes to the stored `returnTo`,
  // not `defaultReturnTo`: client sign-in's `complete` page depends on being
  // reached so it can tell the waiting game the sign-in was cancelled.
  it.each(["canceled", "exchange_failed"] as const)(
    "sends a %s login to the stored returnTo with no cookie",
    async (failure) => {
      const store = new MemoryStateStore();
      const state = await stateFor(store, { returnTo: "/enlitt/client/complete?h=abc" });
      const fetchSpy = vi.fn(async () => new Response("nope", { status: 400 }));
      vi.stubGlobal("fetch", fetchSpy);
      const handler = createCallbackHandler(baseConfig({ stateStore: store }));
      const query = failure === "canceled" ? "error=access_denied" : "code=abc";

      const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&${query}`));

      expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/enlitt/client/complete?h=abc`);
      expect(setCookieHeaders(response)).toHaveLength(0);
      if (failure === "canceled") expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("yields a signed-out response with no cookie when the exchange fails (non-ok response)", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 }))
    );
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it("yields a signed-out response with no cookie when the exchange errors (network failure)", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it("yields a signed-out response with no cookie when the exchange returns a malformed body", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 }))
    );
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc`));

    expect(locationOf(response).toString()).toBe(`${APP_ORIGIN}/home`);
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it("never honors a token supplied in the callback request itself", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    // The exchange succeeds and returns its own, different token; the
    // request also carries an attacker-supplied one that must never surface.
    const fetchSpy = successfulExchangeFetch("real-exchange-token");
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(
      new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc&session_token=attacker-token&token=attacker-token`)
    );

    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^enlitt_session=real-exchange-token;/);
    expect(cookies[0]).not.toContain("attacker-token");
  });

  it("never honors a request-supplied token when the exchange itself fails", async () => {
    const store = new MemoryStateStore();
    const state = await stateFor(store, {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    );
    const handler = createCallbackHandler(baseConfig({ stateStore: store }));

    const response = await handler(
      new Request(`${APP_ORIGIN}/auth/callback?state=${state}&code=abc&session_token=attacker-token`)
    );

    expect(setCookieHeaders(response)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* createLogoutHandler                                                       */
/* -------------------------------------------------------------------------- */

describe("createLogoutHandler", () => {
  it("clears the cookie and requests Enlitt-side revocation, with the token traveling in the body, not the URL", async () => {
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createLogoutHandler(baseConfig());

    const request = new Request(`${APP_ORIGIN}/auth/logout`, {
      headers: { cookie: "enlitt_session=to-revoke" }
    });
    const response = await handler(request);

    expect(response.status).toBe(303);
    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^enlitt_session=;/);
    expect(cookies[0]).toMatch(/Max-Age=0/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestedUrl, requestInit] = fetchSpy.mock.calls[0]!;
    expect(new URL(requestedUrl as string | URL).toString()).not.toContain("to-revoke");
    const init = requestInit as RequestInit;
    const bodyText = typeof init.body === "string" ? init.body : (init.body as URLSearchParams).toString();
    expect(bodyText).toContain("to-revoke");
  });

  it("sends the revocation to enlittApiOrigin when given", async () => {
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createLogoutHandler(baseConfig({ enlittApiOrigin: "https://api.enlitt.test" }));
    await handler(new Request(`${APP_ORIGIN}/auth/logout`, { headers: { cookie: "enlitt_session=t" } }));
    const [requestedUrl] = fetchSpy.mock.calls[0]!;
    expect(new URL(requestedUrl as string | URL).toString()).toBe("https://api.enlitt.test/auth/oauth2/revoke");
  });

  it("clears the cookie without contacting Enlitt when there was no session cookie", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const handler = createLogoutHandler(baseConfig());

    const response = await handler(new Request(`${APP_ORIGIN}/auth/logout`));

    expect(fetchSpy).not.toHaveBeenCalled();
    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^enlitt_session=;/);
  });
});
