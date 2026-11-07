/**
 * `packages/sdk/src/server/index.ts`.
 *
 * `specs/SDK-side routing.md` states this file's public export list
 * exhaustively and requires it to re-export exactly that list and add no
 * behaviour of its own. This test parses the module's own `export { ... }
 * from "..."` statements to recover every declared export name — including
 * type-only ones, which are erased at runtime and so cannot be observed by
 * importing the module — and checks that set against the specced list
 * exactly, so a future addition or removal fails here. It then imports the
 * compiled module and checks that its runtime (value) exports are exactly
 * the declared names that are not `type`-only, guarding against a value
 * mistakenly re-exported as `type` (silently dropped at runtime) or a type
 * mistakenly re-exported as a value.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = resolve(HERE, "index.ts");

/**
 * The exhaustive list from `specs/SDK-side routing.md`,
 * `### packages/sdk/src/server/index.ts`. `resolveBusinessAuthorizationHeader`
 * is deliberately absent per that spec.
 */
const SPECCED_EXPORTS = [
  // `../vercel/index.js`
  "enlitt",
  "ENLITT_STANDARD_MODEL",
  "EnlittTarget",
  "EnlittProviderOptions",
  "EnlittPrice",
  "PremiumPriceContext",
  "perToken",
  // `../core/index.js`: construction options, premium, usage, session, errors
  "EnlittOptions",
  "EnlittRateLimitRetryOptions",
  "withPremiumCharge",
  "WithPremiumChargeOptions",
  "PremiumChargeHandle",
  "PremiumChargeFunction",
  "PremiumTerminalFacts",
  "usage",
  "UsageAvailability",
  "EnlittSession",
  "enlittSession",
  "ENLITT_SESSION_COOKIE_NAME",
  "ENLITT_SESSION_HEADER_NAME",
  "enlittSessionMiddleware",
  "runWithEnlittSession",
  "getEnlittSession",
  // every error class
  "EnlittAuthenticationError",
  "EnlittAuthorizationError",
  "EnlittConfigurationError",
  "EnlittError",
  "EnlittInsufficientCreditsError",
  "EnlittLimitExceededError",
  "EnlittLoginRequiredError",
  "EnlittRateLimitError",
  "EnlittSubscriptionInactiveError",
  // `./callback.js`
  "createLoginStartHandler",
  "createCallbackHandler",
  "createLogoutHandler",
  "CallbackConfig",
  "StateRecord",
  "StateStore",
  // `./client-sign-in.js`
  "createClientSignInHandler",
  "createMemoryClientSignInStore",
  "ClientSignInConfig",
  "ClientSignInStore"
].sort();

interface ParsedExport {
  readonly name: string;
  readonly isType: boolean;
}

/**
 * Recovers every named export from a source file composed entirely of
 * `export { ... } from "...";` re-export statements (this file's shape, per
 * the spec: "re-exports, and adds no behavior of its own"). Handles `type`
 * markers and `as` aliases so the recovered name is always the name a
 * consumer would import.
 */
function parseReExports(source: string): ParsedExport[] {
  const parsed: ParsedExport[] = [];
  const blockPattern = /export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let block: RegExpExecArray | null;
  while ((block = blockPattern.exec(source)) !== null) {
    const body = block[1] ?? "";
    for (const rawEntry of body.split(",")) {
      const entry = rawEntry.trim();
      if (entry.length === 0) {
        continue;
      }
      const isType = /^type\s+/.test(entry);
      const withoutType = isType ? entry.replace(/^type\s+/, "") : entry;
      const parts = withoutType.split(/\s+as\s+/);
      const lastPart = parts[parts.length - 1] ?? withoutType;
      const exportedName = lastPart.trim();
      parsed.push({ name: exportedName, isType });
    }
  }
  return parsed;
}

describe("the module's public surface", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");
  const declared = parseReExports(source);

  it("declares only `export { ... } from \"...\"` re-exports, per the spec's 'adds no behavior of its own'", () => {
    // No other export form (export const/function/class/default, or a bare
    // `export * from`) is permitted, since none of those appear in the
    // specced surface's derivation and a bare `export *` could silently
    // widen it. This also guards the regex-based parse above: if it ever
    // stopped matching every export statement, this count would go to zero
    // and the exhaustiveness assertion below would be vacuous.
    expect(declared.length).toBeGreaterThan(0);
    const remainder = source
      .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(remainder).not.toMatch(/\bexport\b/);
  });

  it("re-exports exactly the specced list", () => {
    const declaredNames = declared.map((entry) => entry.name).sort();
    expect(declaredNames).toEqual(SPECCED_EXPORTS);
  });

  it("does not export resolveBusinessAuthorizationHeader — its absence is deliberate", () => {
    expect(declared.some((entry) => entry.name === "resolveBusinessAuthorizationHeader")).toBe(false);
  });

  it("has no duplicate export names", () => {
    const names = declared.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes at runtime exactly the declared value (non-type) exports", async () => {
    const mod: Record<string, unknown> = await import("./index.js");
    const expectedValueNames = declared
      .filter((entry) => !entry.isType)
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(mod).sort()).toEqual(expectedValueNames);
    for (const name of expectedValueNames) {
      expect(mod[name]).toBeDefined();
    }
  });
});
