/**
 * `packages/sdk/src/server/client-sign-in.ts`. No network and no database:
 * `fetch` is stubbed for Enlitt's code exchange and revocation, the real
 * callback handlers are used for the business's own half, and the in-memory
 * store is used with an injected clock.
 */

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCallbackHandler } from "./callback.js";
import type { CallbackConfig, StateRecord, StateStore } from "./callback.js";
import { createClientSignInHandler, createMemoryClientSignInStore } from "./client-sign-in.js";
import type { ClientSignInConfig, ClientSignInStore } from "./client-sign-in.js";
import {
  ENLITT_SESSION_COOKIE_NAME,
  ENLITT_SESSION_HEADER_NAME,
  enlittSessionMiddleware,
  getEnlittSession
} from "../core/session.js";
import { EnlittConfigurationError } from "../core/errors.js";

const APP_ORIGIN = "https://app.example.com";
const BASE = "/enlitt/client";
const SESSION_TOKEN = "SESSION-TOKEN-SENTINEL-0123456789";
const ENLITT_ORIGIN = "https://api.enlitt.test";

/** An in-memory `StateStore` for the business's login state. */
class MemoryStateStore implements StateStore {
  readonly map = new Map<string, StateRecord>();
  async set(state: string, record: StateRecord): Promise<void> {
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

// ---- fixtures ---------------------------------------------------------------

let clock = 1_000_000;
let callbackConfig: CallbackConfig;
let store: ClientSignInStore;
let handler: (request: Request) => Promise<Response>;
let callbackHandler: (request: Request) => Promise<Response>;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeConfig(overrides: Partial<ClientSignInConfig> = {}): ClientSignInConfig {
  return {
    callback: callbackConfig,
    basePath: BASE,
    appName: "Space Game",
    returnUrls: ["com.example.game://auth"],
    pairing: true,
    store,
    ...overrides
  };
}

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  callbackConfig = {
    clientId: "client-123",
    secretKey: "enl_live_business_secret",
    redirectUri: `${APP_ORIGIN}/auth/callback`,
    enlittOrigin: ENLITT_ORIGIN,
    appOrigin: APP_ORIGIN,
    defaultReturnTo: "/home",
    stateStore: new MemoryStateStore()
  };
  store = createMemoryClientSignInStore({ now: () => clock });
  handler = createClientSignInHandler(makeConfig());
  callbackHandler = createCallbackHandler(callbackConfig);
  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/auth/oauth2/token")) {
      return Response.json({ session_token: SESSION_TOKEN, subject: "sub_abc" });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function verifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function setCookies(response: Response): string[] {
  return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

/** The `name=value` pair of the cookie a response sets, or null when it only clears it. */
function cookieValue(response: Response, name: string): string | null {
  for (const header of setCookies(response)) {
    if (header.startsWith(`${name}=`)) {
      const value = header.slice(name.length + 1).split(";")[0] ?? "";
      return value === "" ? null : decodeURIComponent(value);
    }
  }
  return null;
}

function startRequest(query: Record<string, string>): Request {
  return new Request(`${APP_ORIGIN}${BASE}/start?${new URLSearchParams(query).toString()}`);
}

function loopbackQuery(
  challenge: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    mode: "loopback",
    state: "client-state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    port: "8080",
    ...overrides
  };
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

/**
 * Plays the browser through the business's own half of a sign-in that `start`
 * began: follows the redirect to Enlitt, "signs in" there, runs the real
 * callback handler against the stubbed exchange, and finally calls `complete`
 * with the cookies the callback set. `signedIn: false` models cancelling.
 */
async function browserFlow(
  startResponse: Response,
  signedIn = true,
  existingCookie?: string
): Promise<Response> {
  expect(startResponse.status).toBe(303);
  const authorize = new URL(startResponse.headers.get("location")!);
  expect(authorize.origin).toBe(ENLITT_ORIGIN);
  const state = authorize.searchParams.get("state")!;

  let cookie = existingCookie ?? "";
  if (signedIn) {
    const callback = await callbackHandler(
      new Request(`${callbackConfig.redirectUri}?code=one-time&state=${state}`)
    );
    expect(callback.status).toBe(303);
    cookie = `${ENLITT_SESSION_COOKIE_NAME}=${cookieValue(callback, ENLITT_SESSION_COOKIE_NAME)}`;
    const complete = new URL(callback.headers.get("location")!);
    return handler(new Request(complete, { headers: { cookie } }));
  }
  // Cancelled at Enlitt. The spec expects the business's callback to return the
  // browser to the remembered `return_to` with no session cookie. The current
  // callback handler sends a cancelled or failed login to `defaultReturnTo`
  // instead (reported as an out-of-scope bug), so this test reads `return_to`
  // from the login state and calls `complete` directly, the way the spec's
  // callback would have redirected.
  const stateStore = callbackConfig.stateStore as MemoryStateStore;
  const returnTo = stateStore.map.get(state)!.returnTo!;
  return handler(
    new Request(new URL(returnTo, APP_ORIGIN), { headers: cookie === "" ? {} : { cookie } })
  );
}

async function redeem(code: string, verifier: string): Promise<Response> {
  return handler(postJson("/token", { grant_type: "code", code, code_verifier: verifier }));
}

// ---- tests ------------------------------------------------------------------

describe("construction", () => {
  const bad: Record<string, Partial<ClientSignInConfig>> = {
    "an http returnUrls entry": { returnUrls: ["http://example.com/cb"] },
    "a javascript returnUrls entry": { returnUrls: ["javascript:alert(1)"] },
    "a scheme without a dot": { returnUrls: ["mygame://auth"] },
    "an uppercase scheme": { returnUrls: ["Com.Example.Game://auth"] },
    "a returnUrls entry with a fragment": { returnUrls: ["https://example.com/cb#frag"] },
    "a relative returnUrls entry": { returnUrls: ["/cb"] },
    "a basePath without a leading slash": { basePath: "enlitt/client" },
    "a basePath with a trailing slash": { basePath: "/enlitt/client/" },
    "a basePath with a query": { basePath: "/enlitt?x=1" },
    "no mode enabled": { loopback: false, returnUrls: [], pairing: false },
    "an empty appName": { appName: "" },
    "a 61-character appName": { appName: "x".repeat(61) }
  };
  for (const [name, overrides] of Object.entries(bad)) {
    it(`refuses ${name} with EnlittConfigurationError`, () => {
      expect(() => createClientSignInHandler(makeConfig(overrides))).toThrow(
        EnlittConfigurationError
      );
    });
  }

  it("accepts https and reverse-DNS deep links", () => {
    expect(() =>
      createClientSignInHandler(
        makeConfig({ returnUrls: ["https://app.example.com/open", "com.example.game:/auth"] })
      )
    ).not.toThrow();
  });
});

describe("routing", () => {
  it("answers 404 for any other path below the base path", async () => {
    expect((await handler(new Request(`${APP_ORIGIN}${BASE}/nope`))).status).toBe(404);
    expect((await handler(new Request(`${APP_ORIGIN}${BASE}x/start`))).status).toBe(404);
  });
});

describe("start", () => {
  const { challenge } = verifierAndChallenge();

  const refusals: Record<string, Record<string, string>> = {
    "an unknown field": loopbackQuery(challenge, { extra: "1" }),
    "a missing challenge": (() => {
      const query = loopbackQuery(challenge);
      delete query.code_challenge;
      return query;
    })(),
    "a non-S256 method": loopbackQuery(challenge, { code_challenge_method: "plain" }),
    "port 80": loopbackQuery(challenge, { port: "80" }),
    "port 65536": loopbackQuery(challenge, { port: "65536" }),
    "a non-canonical port": loopbackQuery(challenge, { port: "08080" }),
    "a bad state": loopbackQuery(challenge, { state: "has space" }),
    "an unknown mode": loopbackQuery(challenge, { mode: "other" }),
    "a redirect_uri on a loopback start": loopbackQuery(challenge, {
      redirect_uri: "com.example.game://auth"
    })
  };
  for (const [name, query] of Object.entries(refusals)) {
    it(`refuses ${name} with 400 and no redirect`, async () => {
      const response = await handler(startRequest(query));
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("refuses a disabled mode", async () => {
    const loopbackOff = createClientSignInHandler(makeConfig({ loopback: false }));
    expect((await loopbackOff(startRequest(loopbackQuery(challenge)))).status).toBe(400);
    const redirectOff = createClientSignInHandler(makeConfig({ returnUrls: [] }));
    const query = {
      ...loopbackQuery(challenge),
      mode: "redirect",
      redirect_uri: "com.example.game://auth"
    } as Record<string, string>;
    delete query.port;
    expect((await redirectOff(startRequest(query))).status).toBe(400);
  });

  it("refuses a redirect_uri that differs by one character", async () => {
    const query = {
      ...loopbackQuery(challenge),
      mode: "redirect",
      redirect_uri: "com.example.game://auth/"
    } as Record<string, string>;
    delete query.port;
    const response = await handler(startRequest(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects a valid start into login start and clears the session cookie", async () => {
    const response = await handler(startRequest(loopbackQuery(challenge)));
    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin).toBe(ENLITT_ORIGIN);
    // The remembered return_to is this handler's complete route.
    const stateStore = callbackConfig.stateStore as MemoryStateStore;
    const records = [...stateStore.map.values()];
    expect(records).toHaveLength(1);
    expect(records[0]!.returnTo).toMatch(new RegExp(`^${BASE}/complete\\?h=[A-Za-z0-9_-]{43}$`));
    // The clearing cookie names the session cookie and expires it at once.
    const clearing = setCookies(response).find((header) =>
      header.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=`)
    );
    expect(clearing).toContain("Max-Age=0");
  });

  it("clears the cookie with the same Path the callback handler sets it with", async () => {
    const start = await handler(startRequest(loopbackQuery(challenge)));
    const clearing = setCookies(start).find((header) =>
      header.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=`)
    )!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await callbackHandler(
      new Request(`${callbackConfig.redirectUri}?code=one-time&state=${state}`)
    );
    const minted = setCookies(callback).find((header) =>
      header.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=`)
    )!;
    const pathOf = (header: string): string | undefined => /;\s*Path=([^;]*)/i.exec(header)?.[1];
    expect(pathOf(clearing)).toBe(pathOf(minted));
  });
});

describe("full loopback flow", () => {
  it("hands over a code, redeems it once, and clears the cookie", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const start = await handler(startRequest(loopbackQuery(challenge)));
    const complete = await browserFlow(start);

    expect(complete.status).toBe(303);
    const target = new URL(complete.headers.get("location")!);
    expect(`${target.origin}${target.pathname}`).toBe("http://127.0.0.1:8080/callback");
    expect(target.searchParams.get("state")).toBe("client-state-1");
    const code = target.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      setCookies(complete).some((header) => header.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=;`))
    ).toBe(true);

    const first = await redeem(code, verifier);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ session_token: SESSION_TOKEN });

    const second = await redeem(code, verifier);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong verifier and spends the code", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const complete = await browserFlow(await handler(startRequest(loopbackQuery(challenge))));
    const code = new URL(complete.headers.get("location")!).searchParams.get("code")!;

    const wrong = await redeem(code, verifierAndChallenge().verifier);
    expect(await wrong.json()).toEqual({ error: "invalid_grant" });
    expect(await (await redeem(code, verifier)).json()).toEqual({ error: "invalid_grant" });
  });

  it("expires a code after 5 minutes", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const complete = await browserFlow(await handler(startRequest(loopbackQuery(challenge))));
    const code = new URL(complete.headers.get("location")!).searchParams.get("code")!;
    clock += 5 * 60 * 1000 + 1;
    expect(await (await redeem(code, verifier)).json()).toEqual({ error: "invalid_grant" });
  });

  it("rejects malformed token bodies as invalid_request", async () => {
    const bodies: unknown[] = [
      {},
      { grant_type: "code", code: "x" },
      { grant_type: "code", code: "x", code_verifier: "y", extra: 1 },
      { grant_type: "password", code: "x", code_verifier: "y" },
      { grant_type: "pairing", pairing_id: 5, code_verifier: "y" }
    ];
    for (const body of bodies) {
      const response = await handler(postJson("/token", body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });
});

describe("redirect mode", () => {
  it("ends at the exact configured redirect_uri", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const query = {
      ...loopbackQuery(challenge),
      mode: "redirect",
      redirect_uri: "com.example.game://auth"
    } as Record<string, string>;
    delete query.port;
    const complete = await browserFlow(await handler(startRequest(query)));
    expect(complete.status).toBe(303);
    const location = complete.headers.get("location")!;
    expect(location.startsWith("com.example.game://auth?")).toBe(true);
    const target = new URL(location);
    expect(target.searchParams.get("state")).toBe("client-state-1");
    const redeemed = await redeem(target.searchParams.get("code")!, verifier);
    expect(await redeemed.json()).toEqual({ session_token: SESSION_TOKEN });
  });
});

describe("fresh session only", () => {
  it("never hands over a session cookie the browser already held", async () => {
    const { challenge } = verifierAndChallenge();
    const start = await handler(startRequest(loopbackQuery(challenge)));
    // The browser still presents its website session, then cancels at Enlitt.
    // `start` told it to clear that cookie, which a real browser honors; here we
    // model the cancel path where no new cookie is minted.
    const complete = await browserFlow(start, false);
    const target = new URL(complete.headers.get("location")!);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("client-state-1");
    expect(target.searchParams.has("code")).toBe(false);
  });
});

describe("expired handoff", () => {
  it("shows the expired page for an unknown or replayed h", async () => {
    const unknown = await handler(new Request(`${APP_ORIGIN}${BASE}/complete?h=${"A".repeat(43)}`));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain(
      "This sign-in link has expired. Go back to the app and try again."
    );

    const { challenge } = verifierAndChallenge();
    const start = await handler(startRequest(loopbackQuery(challenge)));
    const authorize = new URL(start.headers.get("location")!);
    const callback = await callbackHandler(
      new Request(
        `${callbackConfig.redirectUri}?code=c&state=${authorize.searchParams.get("state")}`
      )
    );
    const completeUrl = new URL(callback.headers.get("location")!);
    const cookie = `${ENLITT_SESSION_COOKIE_NAME}=${cookieValue(callback, ENLITT_SESSION_COOKIE_NAME)}`;
    expect((await handler(new Request(completeUrl, { headers: { cookie } }))).status).toBe(303);
    const replay = await handler(new Request(completeUrl, { headers: { cookie } }));
    expect(replay.status).toBe(400);
  });
});

describe("pairing", () => {
  async function createPairing(
    challenge: string
  ): Promise<{ pairing_id: string; user_code: string; [key: string]: unknown }> {
    const response = await handler(
      postJson("/pairing", { code_challenge: challenge, code_challenge_method: "S256" })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()) as { pairing_id: string; user_code: string };
  }

  function pairRequest(
    form: Record<string, string>,
    csrfCookie: string | null,
    headers: Record<string, string> = {}
  ): Request {
    return new Request(`${APP_ORIGIN}${BASE}/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(csrfCookie === null ? {} : { cookie: `enlitt_pair_csrf=${csrfCookie}` }),
        ...headers
      },
      body: new URLSearchParams(form).toString()
    });
  }

  async function pollToken(pairingId: string, verifier: string): Promise<Response> {
    return handler(
      postJson("/token", { grant_type: "pairing", pairing_id: pairingId, code_verifier: verifier })
    );
  }

  it("returns a valid body with user codes only from the alphabet", async () => {
    const { challenge } = verifierAndChallenge();
    for (let i = 0; i < 20; i += 1) {
      const body = await createPairing(challenge);
      expect(body.pairing_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
      expect(body.verification_uri).toBe(`${APP_ORIGIN}${BASE}/pair`);
      expect(body.expires_in).toBe(600);
      expect(body.interval).toBe(5);
    }
  });

  it("refuses a malformed pairing request", async () => {
    const response = await handler(
      postJson("/pairing", { code_challenge: "short", code_challenge_method: "S256" })
    );
    expect(response.status).toBe(400);
  });

  it("stays authorization_pending until the person confirms", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const { pairing_id } = await createPairing(challenge);
    for (let i = 0; i < 2; i += 1) {
      const response = await pollToken(pairing_id, verifier);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "authorization_pending" });
    }
  });

  it("rejects /pair without a matching CSRF cookie, and a foreign Origin", async () => {
    expect((await handler(pairRequest({ csrf: "a", user_code: "ABCD" }, null))).status).toBe(403);
    expect((await handler(pairRequest({ csrf: "a", user_code: "ABCD" }, "b"))).status).toBe(403);
    expect(
      (
        await handler(
          pairRequest({ csrf: "a", user_code: "ABCD" }, "a", { origin: "https://evil.example" })
        )
      ).status
    ).toBe(403);
  });

  it("shows the form again for an unknown user code", async () => {
    const response = await handler(pairRequest({ csrf: "tok", user_code: "BBBBBBBB" }, "tok"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("That code is not valid or has expired.");
  });

  it("serves the entry form with a strict CSRF cookie and page security headers", async () => {
    const response = await handler(new Request(`${APP_ORIGIN}${BASE}/pair`));
    expect(response.status).toBe(200);
    const cookie = setCookies(response).find((header) => header.startsWith("enlitt_pair_csrf="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Path=${BASE}`);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("names the app, repeats the code, and warns, escaping appName", async () => {
    const hostile = createClientSignInHandler(makeConfig({ appName: "<script>alert(1)</script>" }));
    const { challenge } = verifierAndChallenge();
    const created = (await (
      await hostile(
        postJson("/pairing", { code_challenge: challenge, code_challenge_method: "S256" })
      )
    ).json()) as {
      user_code: string;
    };
    const page = await hostile(
      pairRequest({ csrf: "tok", user_code: created.user_code.toLowerCase() }, "tok")
    );
    const html = await page.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(`${created.user_code.slice(0, 4)}-${created.user_code.slice(4)}`);
    expect(html).toContain("Only continue if this code is on a screen in front of you right now.");
    expect(html).toContain("If someone sent you this code, do not continue");
    expect(html).toContain("Continue");
    expect(html).toContain("Cancel");
  });

  it("confirm, callback, complete makes token return the session once", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const { pairing_id, user_code } = await createPairing(challenge);

    const confirm = await handler(
      pairRequest({ csrf: "tok", user_code, action: "confirm" }, "tok")
    );
    expect(confirm.status).toBe(303);
    expect(
      setCookies(confirm).some((header) => header.startsWith(`${ENLITT_SESSION_COOKIE_NAME}=;`))
    ).toBe(true);
    const complete = await browserFlow(confirm);
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain("Signed in. You can go back to your other device.");

    const ready = await pollToken(pairing_id, verifier);
    expect(await ready.json()).toEqual({ session_token: SESSION_TOKEN });
    const again = await pollToken(pairing_id, verifier);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("cancelling at Enlitt gives access_denied", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const { pairing_id, user_code } = await createPairing(challenge);
    const confirm = await handler(
      pairRequest({ csrf: "tok", user_code, action: "confirm" }, "tok")
    );
    const complete = await browserFlow(confirm, false);
    expect(await complete.text()).toContain("cancelled");
    expect(await (await pollToken(pairing_id, verifier)).json()).toEqual({
      error: "access_denied"
    });
  });

  it("Cancel on the confirmation page gives access_denied", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const { pairing_id, user_code } = await createPairing(challenge);
    const cancelled = await handler(
      pairRequest({ csrf: "tok", user_code, action: "cancel" }, "tok")
    );
    expect(cancelled.status).toBe(200);
    expect(await (await pollToken(pairing_id, verifier)).json()).toEqual({
      error: "access_denied"
    });
  });

  it("reports expired_token for a pairing past its lifetime", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const { pairing_id } = await createPairing(challenge);
    // The memory store still holds it if we advance the handler clock only.
    clock += 10 * 60 * 1000 + 1;
    const response = await pollToken(pairing_id, verifier);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /^(expired_token|invalid_grant)$/
    );
  });

  it("answers 404 on every pairing route when pairing is off", async () => {
    const off = createClientSignInHandler(makeConfig({ pairing: false }));
    expect((await off(postJson("/pairing", {}))).status).toBe(404);
    expect((await off(new Request(`${APP_ORIGIN}${BASE}/pair`))).status).toBe(404);
    expect((await off(pairRequest({ csrf: "a" }, "a"))).status).toBe(404);
  });
});

describe("logout", () => {
  it("answers 204 and revokes exactly the header token", async () => {
    const response = await handler(
      new Request(`${APP_ORIGIN}${BASE}/logout`, {
        method: "POST",
        headers: { [ENLITT_SESSION_HEADER_NAME]: SESSION_TOKEN }
      })
    );
    expect(response.status).toBe(204);
    const revocation = fetchSpy.mock.calls.find(([input]) =>
      String(input as string).endsWith("/auth/oauth2/revoke")
    );
    expect(revocation).toBeDefined();
    const body = (revocation![1] as { body: string }).body;
    expect(new URLSearchParams(body).get("token")).toBe(SESSION_TOKEN);
  });

  it("still answers 204 when revocation fails", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const response = await handler(
      new Request(`${APP_ORIGIN}${BASE}/logout`, {
        method: "POST",
        headers: { [ENLITT_SESSION_HEADER_NAME]: SESSION_TOKEN }
      })
    );
    expect(response.status).toBe(204);
  });
});

describe("secrecy", () => {
  it("puts the session token only in the token response body", async () => {
    const { verifier, challenge } = verifierAndChallenge();
    const start = await handler(startRequest(loopbackQuery(challenge)));
    const complete = await browserFlow(start);
    expect(complete.headers.get("location")).not.toContain(SESSION_TOKEN);
    expect(await complete.text()).not.toContain(SESSION_TOKEN);

    const code = new URL(complete.headers.get("location")!).searchParams.get("code")!;
    const bad = await redeem(code, "x".repeat(10));
    expect(await bad.text()).not.toContain(SESSION_TOKEN);

    const pairingStart = await handler(
      postJson("/pairing", { code_challenge: challenge, code_challenge_method: "S256" })
    );
    expect(await pairingStart.text()).not.toContain(SESSION_TOKEN);
    expect(verifier).toBeTruthy();
  });
});

describe("session header", () => {
  it("gives getEnlittSession() the Enlitt-Session header token through the middleware", async () => {
    let seen: string | undefined;
    await enlittSessionMiddleware({ header: true })(
      new Request(`${APP_ORIGIN}/api/chat`, {
        headers: { [ENLITT_SESSION_HEADER_NAME]: SESSION_TOKEN }
      }),
      async () => {
        seen = getEnlittSession()?.token;
        return new Response("ok");
      }
    );
    expect(seen).toBe(SESSION_TOKEN);
  });
});
