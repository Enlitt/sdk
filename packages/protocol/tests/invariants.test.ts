import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ENLITT_ERROR_CODE_NAMES } from "../src/errors.js";

/**
 * The single-owner invariant, enforced as a check rather than as prose.
 *
 * `specs/TODO.md` invariant 7 says a second copy of the error-code table is a
 * defect even when the two copies agree, "because they will not stay
 * agreeing". Review is the only thing enforcing that today. This test lives in
 * the owning package on purpose: the owner of a table is the right place for
 * the test that nothing else has copied it.
 *
 * What it looks for is a copy that can go stale silently. Two kinds of literal
 * cannot, and are exempt below with the reason at each: a literal in a test
 * file, which is the independent assertion of the wire value and would assert
 * nothing if it read the record instead, and a code the file itself anchors in
 * an `as const satisfies readonly EnlittErrorCode[]` declaration, which the
 * compiler already checks against the record.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PROTOCOL_SOURCE = join(REPOSITORY_ROOT, "packages", "protocol");

const SCANNED_ROOTS = ["apps", "packages"];
/**
 * Workspaces that are SDK consumers, not Enlitt components.
 *
 * The first-party chatbot (`apps/chatbot`, `specs/Chatbot.md`) is built the way
 * any business would build an app on the SDK. Its own `ChatErrorCode` table is
 * a separate, app-level vocabulary for what its UI shows, and some of its names
 * (`not_found`, for one) happen to equal Enlitt codes. Those strings are not a
 * copy of this table: they never travel on the Enlitt wire and must not change
 * when an Enlitt code is renamed. The invariant is about Enlitt's own
 * components, so the scan stops at the consumer boundary.
 */
const SDK_CONSUMER_WORKSPACES = new Set([join("apps", "chatbot")]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".open-next",
  ".wrangler",
  ".turbo"
]);

/**
 * A test file names a code as a literal *on purpose*, and that is not a second
 * copy of the table.
 *
 * The thing a test of a stable code has to assert is the wire value a client
 * will actually see. Reading that value from the record and then comparing it
 * to the record would be a tautology: it would pass for every possible value
 * the record could hold, including a renamed one, so it would assert nothing
 * and a rename that broke every deployed client would stay green. The literal
 * in a test is the independent second opinion that makes the rename fail
 * loudly — which is the opposite of the drift this invariant exists to catch.
 *
 * Production code has no such need: it raises a code, it does not pin one, so
 * a literal there is exactly the unchecked copy this invariant bans.
 */
function isTestFile(path: string): boolean {
  if (/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(path)) return true;
  return path.split(sep).includes("tests") || path.split(sep).includes("__tests__");
}

/**
 * A file that closes a code list with `as const satisfies readonly
 * EnlittErrorCode[]` has already had those codes checked against the record by
 * the compiler, so a string-literal ban adds nothing for *those* codes in
 * *that* file.
 *
 * `satisfies` makes every element a key of `ENLITT_ERROR_CODES`. An invented
 * code, a typo, and a code later retired from the record are each a compile
 * error at the declaration, which is a stronger guarantee than this substring
 * scan gives and is the guarantee the scan is only a proxy for. What such an
 * array carries that the record cannot is its *element order* — a gate order, a
 * refusal precedence — which is the whole reason it is a literal list rather
 * than a list of `ENLITT_ERROR_CODE.x` references; rewriting it would cost the
 * type check nothing and lose nothing, so it would gain nothing.
 *
 * The exemption covers the declaration and nothing else: the array body is
 * removed from the text before the scan, so the rest of the file is still read
 * in full. An earlier revision exempted each anchored code throughout its whole
 * file, which was sound — the derived union types every return site, so a
 * retired code stops the file compiling at the declaration — but it was wider
 * than the argument it rested on, and it was silently covering two plain
 * literals in `admission.ts` that had nothing to do with element order. Those
 * now reference the record, and the exemption is narrow enough that a new one
 * could not hide behind the array again.
 *
 * It is deliberately per-declaration, not a blanket pass. A file with no such
 * array — `apps/backend/src/finance/subscriptions.ts`, say — gets nothing from
 * this, and in an anchored file every occurrence outside the array still
 * counts.
 */
const COMPILER_CHECKED_CODE_ARRAY =
  /\[([^[\]]*)\]\s*as const satisfies readonly EnlittErrorCode\[\]/g;

function withCompilerAnchoredArraysRemoved(source: string): string {
  return source.replace(
    COMPILER_CHECKED_CODE_ARRAY,
    "[] as const satisfies readonly EnlittErrorCode[]"
  );
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (SDK_CONSUMER_WORKSPACES.has(relative(REPOSITORY_ROOT, path))) continue;
      files.push(...(await collectTypeScriptFiles(path)));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Occurrences that are not copies of the table.
 *
 * The check is a substring search, so a code whose name is ordinary English
 * can collide with a string that means something else entirely. Each entry
 * here must say why the occurrence is not a second copy of the mapping.
 * Keeping them enumerated is the point: an unexplained collision fails.
 */
const NOT_A_COPY_OF_THE_TABLE: readonly { readonly file: string; readonly code: string }[] = [
  // The OAuth 2.0 authorization-response `error=access_denied` (RFC 6749
  // §4.1.2.1) on a redirect to the business's callback. It is the OAuth
  // vocabulary, not the Enlitt envelope code that `POST /v1/cli/token` uses.
  { file: "apps/backend/src/account/auth.ts", code: "access_denied" },
  // The business-hosted client sign-in handoff (specs/PROTOCOLS.md, the
  // `<base>/token` and `<base>/complete` routes). Those routes are served by
  // the business's own backend, not by Enlitt, and answer in the OAuth device
  // and authorization-response vocabulary (RFC 8628 §3.5, RFC 6749 §4.1.2.1)
  // that the game kit reads. The names coincide with the CLI device-flow codes
  // in the record but are a separate wire, so they are not a copy of the table.
  { file: "packages/sdk/src/server/client-sign-in.ts", code: "authorization_pending" },
  { file: "packages/sdk/src/server/client-sign-in.ts", code: "access_denied" },
  { file: "packages/sdk/src/server/client-sign-in.ts", code: "expired_token" }
];

describe("the error-code table has exactly one owner", () => {
  it("finds no stable code written as a string literal outside packages/protocol", async () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) {
      files.push(...(await collectTypeScriptFiles(join(REPOSITORY_ROOT, root))));
    }

    const offenders: string[] = [];
    for (const file of files) {
      if (file.startsWith(PROTOCOL_SOURCE + sep)) continue;
      if (isTestFile(file)) continue;
      const source = await readFile(file, "utf8");
      const scanned = withCompilerAnchoredArraysRemoved(source);
      for (const code of ENLITT_ERROR_CODE_NAMES) {
        // A quoted occurrence is a copy of the table. An unquoted one is a
        // reference through the record's own keys, which is the intended use.
        if (!scanned.includes(`"${code}"`) && !scanned.includes(`'${code}'`)) continue;
        const path = relative(REPOSITORY_ROOT, file);
        const exempt = NOT_A_COPY_OF_THE_TABLE.some(
          (entry) => entry.file === path && entry.code === code
        );
        if (!exempt) offenders.push(`${path}: ${code}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
