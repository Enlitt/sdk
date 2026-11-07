/**
 * `packages/sdk/src/browser/auth.ts`.
 *
 * This module is two navigations. Almost every test here is therefore about
 * what it does *not* do — no exchange, no network, no cookie, no storage, no
 * session accessor — because that reduced surface is the security property the
 * spec is buying, not an accident of an unfinished implementation.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { login, logout } from "./auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_SRC = resolve(HERE, "..");
const PAGE_HREF = "https://app.example.com/chat/thread-7?q=1";

let assign: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let cookieReads: number;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

beforeEach(() => {
  assign = vi.fn();
  fetchSpy = vi.fn();
  cookieReads = 0;
  storage = { getItem: vi.fn(), setItem: vi.fn() };

  vi.stubGlobal("window", { location: { href: PAGE_HREF, assign } });
  vi.stubGlobal("document", {
    get cookie(): string {
      cookieReads += 1;
      return "enlitt_session=leaked-token";
    }
  });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("XMLHttpRequest", class {});
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function navigatedTo(): URL {
  expect(assign).toHaveBeenCalledTimes(1);
  return new URL(String(assign.mock.calls[0]?.[0]));
}

/** The relative-import graph a browser bundle for an entry would contain. */
function browserBundleSources(entry: string): { file: string; source: string }[] {
  const seen = new Set<string>();
  const out: { file: string; source: string }[] = [];
  const queue = [resolve(SDK_SRC, entry)];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    out.push({ file, source });
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return out;
}

describe("login / logout navigation", () => {
  it("navigates to the business's own login and logout routes and nothing else", () => {
    login();
    expect(navigatedTo().toString()).toBe("https://app.example.com/auth/login");

    assign.mockClear();
    logout();
    expect(navigatedTo().toString()).toBe("https://app.example.com/auth/logout");
  });

  it("stays on the page's own origin, never on an Enlitt origin", () => {
    login();
    const target = navigatedTo();

    expect(target.origin).toBe(new URL(PAGE_HREF).origin);
    expect(target.host).not.toContain("enlitt");
  });

  it("returns nothing, because there is no session to hand back", () => {
    expect(login()).toBeUndefined();
    expect(logout()).toBeUndefined();
  });

  it("passes a destination through for the server to validate rather than acting on it", () => {
    login({ returnTo: "/chat/thread-7" });

    const target = navigatedTo();
    expect(target.pathname).toBe("/auth/login");
    expect(target.searchParams.get("return_to")).toBe("/chat/thread-7");
    // Exactly one parameter: no state, code, verifier, or token rides along.
    expect([...target.searchParams.keys()]).toEqual(["return_to"]);
  });

  it("forwards even a hostile destination verbatim, and still navigates to its own origin", () => {
    for (const hostile of ["//evil.com", "https://evil.com/steal", "/%2e%2e/%2e%2e/evil"]) {
      assign.mockClear();
      login({ returnTo: hostile });

      const target = navigatedTo();
      // Passed through unchanged: validating here as well as on the server is
      // how the two copies of the rule drift apart, and only the server's copy
      // can be trusted anyway.
      expect(target.searchParams.get("return_to")).toBe(hostile);
      // Whatever was asked for, the navigation itself is same-origin.
      expect(target.origin).toBe(new URL(PAGE_HREF).origin);
      expect(target.pathname).toBe("/auth/login");
    }
  });

  it("omits the parameter entirely when no destination is given", () => {
    logout({});
    expect([...navigatedTo().searchParams.keys()]).toEqual([]);
  });

  it("refuses to run outside a browser", () => {
    vi.stubGlobal("window", undefined);

    expect(() => login()).toThrow(/browser environment/);
    expect(() => logout()).toThrow(/browser environment/);
  });
});

describe("what this module never does", () => {
  it("performs no network request and no token exchange", () => {
    login({ returnTo: "/after" });
    logout();

    expect(fetchSpy).not.toHaveBeenCalled();
    // Two navigations, and nothing else happened.
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it("reads no cookie", () => {
    login();
    logout();

    expect(cookieReads).toBe(0);
  });

  it("touches no ordinary browser storage", () => {
    login({ returnTo: "/after" });
    logout({ returnTo: "/after" });

    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("puts no token, code, verifier, or secret in any URL it produces", () => {
    login({ returnTo: "/after" });
    logout();

    for (const call of assign.mock.calls) {
      const url = String(call[0]);
      for (const forbidden of [
        "token",
        "code",
        "verifier",
        "challenge",
        "secret",
        "Bearer",
        "leaked"
      ]) {
        expect(url).not.toContain(forbidden);
      }
    }
  });
});

describe("the module's public surface", () => {
  it("exports the two navigations and no session accessor or subscription", async () => {
    const mod: Record<string, unknown> = await import("./auth.js");

    expect(Object.keys(mod).sort()).toEqual(["login", "logout"]);
    // Their absence is the design. The session cookie is HttpOnly on the
    // business's domain precisely so a cross-site scripting flaw cannot read
    // it, which also means this file cannot; anything here that appeared to
    // return a session could only do so by weakening that cookie or by
    // inventing a second, readable copy of a credential.
    for (const absent of [
      "getSession",
      "onSessionChange",
      "createBrowserAuth",
      "handleCallback",
      "exchangeCode",
      "getToken"
    ]) {
      expect(mod[absent]).toBeUndefined();
    }
  });

  it("takes no session, so a business dashboard session cannot be presented as a personal one", () => {
    // Neither function accepts a credential at all: the only parameter is the
    // navigation options object.
    expect(login).toHaveLength(1);
    expect(logout).toHaveLength(1);

    const businessSession = {
      type: "business",
      principalId: "biz_1",
      sessionId: "sess_1",
      token: "business-dashboard-token"
    };

    // Passing one anyway changes nothing about where the visitor goes, and
    // none of it reaches the URL. Application login always resolves a personal
    // account on Enlitt's side, and this file has nothing to say about it.
    login(businessSession as unknown as { returnTo?: string });

    const target = navigatedTo();
    expect(target.toString()).toBe("https://app.example.com/auth/login");
    expect(target.search).toBe("");
  });
});

describe("the browser bundle", () => {
  it("contains no credential machinery at all", () => {
    const graph = browserBundleSources("browser.ts");

    expect(graph.map(({ file }) => file)).toContain(resolve(SDK_SRC, "browser/auth.ts"));

    for (const { file, source } of graph) {
      const labelled = `${file}\n${source}`;
      for (const forbidden of [
        "ENLITT_SECRET_KEY",
        "secretKey",
        "client_secret",
        "code_verifier",
        "code_challenge",
        "access_token",
        "session_token",
        "grant_type",
        "Authorization",
        "document.cookie",
        "localStorage",
        "sessionStorage",
        "fetch(",
        "crypto"
      ]) {
        expect(labelled).not.toContain(forbidden);
      }
      // And no reach into the server half, whose modules read the secret.
      expect(source).not.toMatch(/from\s+"\.{1,2}\/server/);
    }
  });
});
