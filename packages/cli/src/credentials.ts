/**
 * The CLI credential file and the config directory it lives in.
 *
 * The file holds the CLI token, so it is written atomically with mode `0600`
 * inside a `0700` directory, and a file readable by group or other is refused
 * on read. `loadCredential`, `saveCredential`, and `deleteCredential` are the
 * only readers and writers; the token never reaches a caller that prints.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CliContext } from "./main.js";
import { CliError } from "./output.js";

/** What the credential file stores (`specs/SDK-side routing.md` "credentials.ts"). */
export interface StoredCredential {
  readonly version: 1;
  readonly api_origin: string;
  readonly token: string;
  readonly credential_id: string;
  readonly business: { readonly id: string; readonly name: string };
  readonly login_email: string;
  readonly token_expires_at: string;
}

/** `${XDG_CONFIG_HOME:-~/.config}/enlitt`, or `%APPDATA%\enlitt` on Windows. */
export function configDirectory(ctx: CliContext): string {
  const { env, homedir, platform } = ctx.deps;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir, "AppData", "Roaming"), "enlitt");
  }
  const base = env.XDG_CONFIG_HOME;
  return join(base !== undefined && base !== "" ? base : join(homedir, ".config"), "enlitt");
}

/** Path of the credential file for this run's environment. */
export function credentialPath(ctx: CliContext): string {
  return join(configDirectory(ctx), `cli-${ctx.env}.json`);
}

/** Path of the pending device-authorization file for this run's environment. */
export function pendingPath(ctx: CliContext): string {
  return join(configDirectory(ctx), `cli-${ctx.env}.pending.json`);
}

/** Creates the config directory with mode `0700` (POSIX) and returns it. */
export async function ensureConfigDirectory(ctx: CliContext): Promise<string> {
  const directory = configDirectory(ctx);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `mkdir` honors the umask and leaves an existing directory alone, so set the mode explicitly.
  if (ctx.deps.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

/**
 * Writes `contents` to `path` atomically: a temp file in the same directory
 * with mode `0600`, then a rename. A reader never sees a partial file.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Refuses a file that group or other can read, on POSIX only. */
export async function assertPrivateFile(ctx: CliContext, path: string): Promise<void> {
  if (ctx.deps.platform === "win32") return;
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    throw new CliError(
      "insecure_credential_file",
      `${path} is readable by other users (mode ${(mode & 0o777).toString(8)}).`,
      { action: `Run \`chmod 600 ${path}\`, then retry.` }
    );
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const business = record.business as Record<string, unknown> | null | undefined;
  return (
    record.version === 1 &&
    typeof record.api_origin === "string" &&
    typeof record.token === "string" &&
    typeof record.credential_id === "string" &&
    typeof record.login_email === "string" &&
    typeof record.token_expires_at === "string" &&
    typeof business === "object" &&
    business !== null &&
    typeof business.id === "string" &&
    typeof business.name === "string"
  );
}

/**
 * Loads this environment's credential, or null when the CLI is not logged in:
 * no file, a corrupt file, another API origin, or an expired token. A file with
 * loose permissions is an `insecure_credential_file` error, never null, so the
 * developer is told rather than silently logged out.
 */
export async function loadCredential(ctx: CliContext): Promise<StoredCredential | null> {
  const path = credentialPath(ctx);
  let text: string;
  try {
    await assertPrivateFile(ctx, path);
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isStoredCredential(parsed)) return null;
  if (parsed.api_origin !== ctx.apiOrigin) return null;
  const expiresAt = Date.parse(parsed.token_expires_at);
  if (Number.isNaN(expiresAt) || expiresAt <= ctx.deps.now().getTime()) return null;
  ctx.secrets.add(parsed.token);
  return parsed;
}

/** Like `loadCredential`, but a missing credential is the `not_logged_in` error. */
export async function requireCredential(ctx: CliContext): Promise<StoredCredential> {
  const credential = await loadCredential(ctx);
  if (credential === null) {
    throw new CliError("not_logged_in", "You are not logged in to Enlitt.");
  }
  return credential;
}

/** Writes the credential file atomically with mode `0600`. */
export async function saveCredential(ctx: CliContext, credential: StoredCredential): Promise<void> {
  ctx.secrets.add(credential.token);
  await ensureConfigDirectory(ctx);
  await writePrivateFile(credentialPath(ctx), `${JSON.stringify(credential, null, 2)}\n`);
}

/** Deletes the credential file. Succeeds when there is none. */
export async function deleteCredential(ctx: CliContext): Promise<void> {
  await rm(credentialPath(ctx), { force: true });
}
