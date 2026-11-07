/**
 * `packages/sdk/src/server/secrets.ts`.
 *
 * The surface is one function, and most of what is worth testing here is what
 * the module refuses to do: hand back a bare secret, reach the network without
 * one, put one in an error, or appear in a browser bundle.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnlittConfigurationError } from "../core/errors.js";
import { resolveBusinessAuthorizationHeader } from "./secrets.js";

const ENV_KEY = "ENLITT_SECRET_KEY";
const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_SRC = resolve(HERE, "..");

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Walk the relative-import graph from one entry file, so a test can ask what a
 * bundle for that entry would actually contain rather than trusting the entry
 * file alone.
 */
function importGraph(entry: string): { file: string; source: string }[] {
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

describe("resolveBusinessAuthorizationHeader", () => {
  it("returns exactly one Bearer value for an explicitly configured key", () => {
    const header = resolveBusinessAuthorizationHeader({ secretKey: "enl_live_explicit" });

    expect(header).toBe("Bearer enl_live_explicit");
    // One credential, not a list: a second value here would be a second
    // identity the server might authenticate as.
    expect(header.split(",")).toHaveLength(1);
    expect(header.match(/Bearer/g)).toHaveLength(1);
  });

  it("falls back to the ENLITT_SECRET_KEY environment variable", () => {
    process.env[ENV_KEY] = "enl_live_from_env";

    expect(resolveBusinessAuthorizationHeader({})).toBe("Bearer enl_live_from_env");
  });

  it("prefers an explicit key over the environment fallback", () => {
    process.env[ENV_KEY] = "enl_live_from_env";

    expect(resolveBusinessAuthorizationHeader({ secretKey: "enl_live_explicit" })).toBe(
      "Bearer enl_live_explicit"
    );
  });

  it("throws locally, before any network call, when no secret resolves", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(() => resolveBusinessAuthorizationHeader({})).toThrow(/no usable Enlitt secret key/);
    // The point of failing here: an absent credential must never become an
    // unauthenticated request that a caller could treat as permission to fall
    // through to a direct, business-funded provider call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("raises EnlittConfigurationError, not a bare Error, for every local failure", () => {
    // The type is part of the contract every caller sees — `enlitt()` promises
    // it for a missing or invalid secret — so it has to be right here rather
    // than translated at one caller's boundary, or the callback handlers would
    // report the identical misconfiguration as something else entirely.
    expect(() => resolveBusinessAuthorizationHeader({})).toThrow(EnlittConfigurationError);
    expect(() => resolveBusinessAuthorizationHeader({ secretKey: "" })).toThrow(EnlittConfigurationError);

    let thrown: unknown;
    try {
      resolveBusinessAuthorizationHeader({ secretKey: "enl_live_pasted\n" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as EnlittConfigurationError).code).toBe("configuration_invalid");
    expect((thrown as EnlittConfigurationError).providerInvoked).toBe(false);
    expect((thrown as EnlittConfigurationError).retryable).toBe(false);
  });

  it("rejects an unusable configured key rather than silently using the environment", () => {
    process.env[ENV_KEY] = "enl_live_from_env";

    // An explicitly supplied value is the identity the call site asked for.
    // Falling back here would authenticate as somebody else.
    expect(() => resolveBusinessAuthorizationHeader({ secretKey: "" })).toThrow();
    expect(() => resolveBusinessAuthorizationHeader({ secretKey: "enl_live_pasted\n" })).toThrow();
    expect(() => resolveBusinessAuthorizationHeader({ secretKey: "enl live spaced" })).toThrow();
  });

  it("never puts any part of the secret in the thrown error's message or fields", () => {
    // Unusable only because of the trailing newline, so the secret itself is
    // fully present in the input and would show up if it were echoed back.
    const secret = "enl_live_zq7wenutterlyunique";
    let thrown: unknown;
    try {
      resolveBusinessAuthorizationHeader({ secretKey: `${secret}\n` });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const surfaces = [
      (thrown as Error).message,
      (thrown as Error).stack ?? "",
      String(thrown),
      JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))
    ].join("\n");

    // No fragment of it, not merely no exact copy.
    for (let start = 0; start + 6 <= secret.length; start += 1) {
      expect(surfaces).not.toContain(secret.slice(start, start + 6));
    }
  });

  it("asserts the environment before it resolves anything", async () => {
    process.env[ENV_KEY] = "enl_live_from_env";
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});

    // Resolution would have succeeded from the environment; the browser
    // refusal is what comes back instead, which is only possible if the
    // assertion runs first.
    expect(() => resolveBusinessAuthorizationHeader({ secretKey: "enl_live_explicit" })).toThrow(
      /browser environment/
    );
    expect(() => resolveBusinessAuthorizationHeader({})).toThrow(/browser environment/);
    expect(() => resolveBusinessAuthorizationHeader({})).toThrow(EnlittConfigurationError);

    // And a browser import fails on evaluation, before any call at all.
    vi.resetModules();
    await expect(import("./secrets.js")).rejects.toThrow(/browser environment/);
  });
});

describe("the module's public surface", () => {
  it("exports one function and no path to a bare secret", async () => {
    const mod: Record<string, unknown> = await import("./secrets.js");

    expect(Object.keys(mod).sort()).toEqual(["resolveBusinessAuthorizationHeader"]);
    // Deleted deliberately: resolving a key and forgetting to use it was a
    // reachable mistake while these existed.
    expect(mod.resolveSecretKey).toBeUndefined();
    expect(mod.createBusinessAuthorizationHeader).toBeUndefined();
    expect(mod.assertServerEnvironment).toBeUndefined();

    // Every exported value that returns a string returns a header, not a key.
    process.env[ENV_KEY] = "enl_live_surface";
    for (const value of Object.values(mod)) {
      expect(typeof value).toBe("function");
      const returned: unknown = (value as (config: { secretKey?: string }) => unknown)({});
      expect(returned).toBe("Bearer enl_live_surface");
    }
  });
});

describe("the package-export boundary", () => {
  it("routes the server subpath away from browser bundles", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(SDK_SRC, "..", "package.json"), "utf8")
    );
    const exportsMap = (manifest as { exports: Record<string, Record<string, string>> }).exports;

    // Diverted to a module that throws at import, not to the browser entry:
    // both keep this file out of the bundle, but a bundle that resolved
    // `./server` for the browser asked for the server surface and is better
    // told so at the import than handed a module that silently lacks it.
    expect(exportsMap["./server"]?.browser).toBe("./dist/server-unavailable.js");
    // The browser subpath has no `browser` condition to divert, so it must
    // simply never reach this file at all — asserted below.
    expect(exportsMap["./browser"]).toBeDefined();
  });

  it("fails loudly when the server subpath's browser target is evaluated", async () => {
    await expect(import("../server-unavailable.js")).rejects.toThrow(/server-only entry point/);
  });

  it("keeps this file and ENLITT_SECRET_KEY handling out of every browser entry", () => {
    for (const entry of ["browser.ts", "index.ts"]) {
      const graph = importGraph(entry);

      expect(graph.map(({ file }) => file)).not.toContain(resolve(SDK_SRC, "server/secrets.ts"));
      for (const { file, source } of graph) {
        expect(`${file}: ${source}`).not.toContain(ENV_KEY);
        expect(source).not.toContain("process.env");
        expect(source).not.toMatch(/from\s+"\.{1,2}\/server/);
      }
    }
  });
});
