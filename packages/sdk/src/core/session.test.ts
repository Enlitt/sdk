import { describe, expect, it } from "vitest";
import {
  ENLITT_SESSION_COOKIE_NAME,
  ENLITT_SESSION_HEADER_NAME,
  enlittSession,
  enlittSessionMiddleware,
  getEnlittSession,
  runWithEnlittSession,
  type EnlittSession
} from "./session.js";
import { EnlittConfigurationError } from "./errors.js";

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  return new Request("https://business.example/api/whatever", { headers });
}

async function okNext(): Promise<Response> {
  return new Response("ok");
}

describe("enlittSessionMiddleware / runWithEnlittSession", () => {
  it("establishes a context holding the exact cookie token", async () => {
    const middleware = enlittSessionMiddleware();
    let observed: EnlittSession | null = null;
    await middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=abc123`), async () => {
      observed = getEnlittSession();
      return okNext();
    });
    expect(observed).toEqual({ token: "abc123" });
  });

  it("establishes a context holding null when there is no cookie", async () => {
    const middleware = enlittSessionMiddleware();
    let observed: EnlittSession | null | "unset" = "unset";
    await middleware(requestWithCookie(null), async () => {
      observed = getEnlittSession();
      return okNext();
    });
    expect(observed).toBeNull();
  });

  it("never rejects a request, cookie or not", async () => {
    const middleware = enlittSessionMiddleware();
    await expect(middleware(requestWithCookie(null), okNext)).resolves.toBeInstanceOf(Response);
    await expect(
      middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=abc123`), okNext)
    ).resolves.toBeInstanceOf(Response);
  });

  it("defaults to ENLITT_SESSION_COOKIE_NAME", async () => {
    const middleware = enlittSessionMiddleware();
    let observed: EnlittSession | null = null;
    await middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=default-token`), async () => {
      observed = getEnlittSession();
      return okNext();
    });
    expect(observed).toEqual({ token: "default-token" });
  });

  it("honors a custom cookieName", async () => {
    const middleware = enlittSessionMiddleware({ cookieName: "biz_session" });
    let observed: EnlittSession | null = null;
    await middleware(requestWithCookie("biz_session=custom-token"), async () => {
      observed = getEnlittSession();
      return okNext();
    });
    expect(observed).toEqual({ token: "custom-token" });

    // A cookie under the default name is ignored when a custom name is configured.
    let observedDefault: EnlittSession | null = { token: "sentinel" };
    await middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=abc123`), async () => {
      observedDefault = getEnlittSession();
      return okNext();
    });
    expect(observedDefault).toBeNull();
  });

  it("clears the context when the request ends", () => {
    expect(() => getEnlittSession()).toThrow(EnlittConfigurationError);
  });

  it("never lets concurrent requests observe each other's sessions", async () => {
    const middleware = enlittSessionMiddleware();
    const results: (EnlittSession | null)[] = [];

    async function handle(token: string, delayMs: number): Promise<Response> {
      return middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=${token}`), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        results.push(getEnlittSession());
        return okNext();
      });
    }

    await Promise.all([handle("first", 20), handle("second", 5), handle("third", 10)]);

    expect(results).toEqual(
      expect.arrayContaining([{ token: "first" }, { token: "second" }, { token: "third" }])
    );
  });

  it("does not leak a session into an async continuation started outside its request", async () => {
    const middleware = enlittSessionMiddleware();
    let leaked: EnlittSession | null | "unset" = "unset";

    await runWithEnlittSession(null, async () => {
      await middleware(requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=inner-token`), async () =>
        okNext()
      );
      // Back in the outer null-session context after the inner request finished.
      leaked = getEnlittSession();
      return okNext();
    });

    expect(leaked).toBeNull();
  });

  it("performs no network call or validation: an expired-looking token still reaches the context unexamined", async () => {
    const middleware = enlittSessionMiddleware();
    let observed: EnlittSession | null = null;
    await middleware(
      requestWithCookie(`${ENLITT_SESSION_COOKIE_NAME}=this-looks-expired-or-garbage`),
      async () => {
        observed = getEnlittSession();
        return okNext();
      }
    );
    expect(observed).toEqual({ token: "this-looks-expired-or-garbage" });
  });
});

describe("getEnlittSession / enlittSession — the three states", () => {
  it("throws EnlittConfigurationError when there is no context at all", () => {
    expect(() => getEnlittSession()).toThrow(EnlittConfigurationError);
  });

  it("a missing middleware never returns null", () => {
    let threw = false;
    try {
      getEnlittSession();
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(EnlittConfigurationError);
    }
    expect(threw).toBe(true);
  });

  it("returns null for a context holding no session", () => {
    const result = runWithEnlittSession(null, () => getEnlittSession());
    expect(result).toBeNull();
  });

  it("returns the session unparsed for a context holding one", () => {
    const session = enlittSession("opaque-token-value");
    const result = runWithEnlittSession(session, () => getEnlittSession());
    expect(result).toEqual({ token: "opaque-token-value" });
    expect(result).toBe(session);
  });

  it("enlittSession() exposes no field beyond the opaque token", () => {
    const session = enlittSession("just-a-token");
    expect(Object.keys(session)).toEqual(["token"]);
  });

  it("enlittSession() validates only that the token is a non-empty bounded string", () => {
    expect(() => enlittSession("")).toThrow(EnlittConfigurationError);
    expect(() => enlittSession("x".repeat(5000))).toThrow(EnlittConfigurationError);
    expect(enlittSession("fine").token).toBe("fine");
  });

  it("never parses, decodes, or inspects the token", () => {
    const weird = "not.a.jwt-but-{looks:'structured'}";
    expect(enlittSession(weird).token).toBe(weird);
  });
});

describe("session privacy", () => {
  it("never surfaces the token value in a thrown configuration error", () => {
    let error: unknown;
    try {
      getEnlittSession();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnlittConfigurationError);
    expect(String((error as Error).message)).not.toMatch(/token-value|abc123/);
  });

  it("enlittSession() rejection messages never echo the rejected value", () => {
    const secret = "super-secret-token-should-not-appear-in-error-xyz";
    try {
      enlittSession(secret + "!".repeat(5000));
      throw new Error("expected enlittSession to throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});

describe("header source (opt-in)", () => {
  /** Runs the middleware over a request and returns the session it installed. */
  async function sessionSeenBy(
    options: Parameters<typeof enlittSessionMiddleware>[0],
    headers: Record<string, string>
  ): Promise<EnlittSession | null> {
    let observed: EnlittSession | null = null;
    await enlittSessionMiddleware(options)(
      new Request("https://business.example/api/whatever", { headers }),
      async () => {
        observed = getEnlittSession();
        return okNext();
      }
    );
    return observed;
  }

  it("names the header Enlitt-Session", () => {
    expect(ENLITT_SESSION_HEADER_NAME).toBe("Enlitt-Session");
  });

  it("with header: true, the header wins over a cookie", async () => {
    const session = await sessionSeenBy(
      { header: true },
      {
        [ENLITT_SESSION_HEADER_NAME]: "from-header",
        cookie: `${ENLITT_SESSION_COOKIE_NAME}=from-cookie`
      }
    );
    expect(session).toEqual({ token: "from-header" });
  });

  it("with header: true, an absent or empty header falls back to the cookie", async () => {
    const cookie = `${ENLITT_SESSION_COOKIE_NAME}=from-cookie`;
    expect(await sessionSeenBy({ header: true }, { cookie })).toEqual({ token: "from-cookie" });
    expect(
      await sessionSeenBy({ header: true }, { [ENLITT_SESSION_HEADER_NAME]: "", cookie })
    ).toEqual({
      token: "from-cookie"
    });
  });

  it("with header: true, an over-long header gives a null context", async () => {
    const session = await sessionSeenBy(
      { header: true },
      { [ENLITT_SESSION_HEADER_NAME]: "x".repeat(5000) }
    );
    expect(session).toBeNull();
  });

  it("with the default options, a request carrying only the header has a null context", async () => {
    expect(
      await sessionSeenBy(undefined, { [ENLITT_SESSION_HEADER_NAME]: "from-header" })
    ).toBeNull();
    expect(
      await sessionSeenBy({ header: false }, { [ENLITT_SESSION_HEADER_NAME]: "from-header" })
    ).toBeNull();
  });
});
