/**
 * The one writer of a project's environment file, and the only code that ever
 * holds a raw API key.
 *
 * Safety rules, all enforced here and nowhere else:
 * - the file must stay inside the project root;
 * - a file tracked by git is refused before anything is written;
 * - an untracked, unignored file is added to the root `.gitignore` first;
 * - an existing key is never overwritten unless `replace` is set;
 * - the write is atomic, and the mode is `0600` when the value is a secret.
 *
 * Return values and errors carry the file and the variable name only, never a
 * value.
 */
import { randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CliContext } from "./main.js";
import { CliError, usageError } from "./output.js";
import { findProjectRoot } from "./project.js";

export interface UpsertInput {
  /** Resolved against the project root; must stay inside it. */
  readonly file: string;
  readonly name: string;
  readonly value: string;
  /** When false, an existing `name=` line is refused as `env_key_exists`. */
  readonly replace: boolean;
  /** When true the resulting file mode is `0600`. */
  readonly secret: boolean;
}

export interface UpsertResult {
  /** The file's path relative to the project root. */
  readonly file: string;
  /** True when an existing line was replaced. */
  readonly replaced: boolean;
  /** True when the file is covered by `.gitignore`, already or because of this call. */
  readonly gitignored: boolean;
  /** False when the line already held this exact value and nothing was written. */
  readonly changed: boolean;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The alphabet the API key and client ID use, so no value ever needs quoting. */
const VALUE_PATTERN = /^[A-Za-z0-9_.:/-]*$/;

interface Target {
  readonly root: string;
  readonly absolute: string;
  /** Root-relative path with the platform separator. */
  readonly relative: string;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * The real location of `path` after following symlinks in its deepest existing
 * ancestor, so a symlinked directory cannot smuggle a write out of the root.
 */
async function realLocation(path: string): Promise<string> {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

async function resolveTarget(ctx: CliContext, file: string): Promise<Target> {
  const root = await findProjectRoot(ctx);
  const absolute = resolve(root, file);
  if (!isInside(root, absolute)) {
    throw usageError(`${file} is outside the project root; use a file inside the project.`);
  }
  const realRoot = await realpath(root);
  if (!isInside(realRoot, await realLocation(absolute))) {
    throw usageError(`${file} resolves outside the project root; use a file inside the project.`);
  }
  return { root, absolute, relative: relative(root, absolute) };
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

interface GitState {
  readonly inWorkTree: boolean;
  readonly tracked: boolean;
  readonly ignored: boolean;
}

/** Asks git about the file. When git is absent or this is no work tree, everything is false. */
async function gitState(ctx: CliContext, target: Target): Promise<GitState> {
  const tree = await ctx.deps.git(["rev-parse", "--is-inside-work-tree"], target.root);
  if (tree.code !== 0 || tree.stdout.trim() !== "true") return { inWorkTree: false, tracked: false, ignored: false };
  const path = posixPath(target.relative);
  const tracked = (await ctx.deps.git(["ls-files", "--error-unmatch", "--", path], target.root)).code === 0;
  const ignored = (await ctx.deps.git(["check-ignore", "-q", "--", path], target.root)).code === 0;
  return { inWorkTree: true, tracked, ignored };
}

function trackedError(file: string): CliError {
  return new CliError("env_file_tracked", `${file} is tracked by git, so a secret must not be written to it.`);
}

/** Adds `/<path>` to the root `.gitignore` once. Creates the file if needed. */
async function ensureGitignored(target: Target): Promise<void> {
  const ignorePath = join(target.root, ".gitignore");
  const entry = `/${posixPath(target.relative)}`;
  const existing = (await readIfExists(ignorePath)) ?? "";
  if (existing.split(/\r?\n/).includes(entry)) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(ignorePath, `${separator}${entry}\n`);
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function lineMatcher(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
}

/** Extracts a dotenv value: strips matching quotes, or a trailing ` # comment`. */
function parseValue(raw: string): string {
  const text = raw.trim();
  const first = text[0];
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1);
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

/** The value of the last `name=` line, which is the one dotenv loaders keep. */
function findValue(contents: string, name: string): string | undefined {
  const matcher = lineMatcher(name);
  let found: string | undefined;
  for (const line of contents.split("\n")) {
    const match = matcher.exec(line.replace(/\r$/, ""));
    if (match) found = parseValue(line.replace(/\r$/, "").slice(match[0].length));
  }
  return found;
}

function validateInput(input: UpsertInput): void {
  // These are programming errors, not user errors, and must never echo the value.
  if (!NAME_PATTERN.test(input.name)) throw new Error("env-file: invalid variable name");
  if (!VALUE_PATTERN.test(input.value)) throw new Error(`env-file: the value for ${input.name} has an unsupported character`);
}

/**
 * Runs every refusal `upsertEnvValue` would, and writes nothing. Callers use it
 * before minting a secret so a key is never created when its destination is
 * already known to be unusable.
 */
export async function checkEnvTarget(
  ctx: CliContext,
  input: { readonly file: string; readonly name: string; readonly replace: boolean }
): Promise<void> {
  const target = await resolveTarget(ctx, input.file);
  const git = await gitState(ctx, target);
  if (git.tracked) throw trackedError(target.relative);
  const existing = await readIfExists(target.absolute);
  if (!input.replace && existing !== null && findValue(existing, input.name) !== undefined) {
    throw envKeyExists(target.relative, input.name);
  }
}

function envKeyExists(file: string, name: string): CliError {
  return new CliError("env_key_exists", `${file} already defines ${name}.`);
}

/** Writes or replaces `name=value`, following the safety rules in the file header. */
export async function upsertEnvValue(ctx: CliContext, input: UpsertInput): Promise<UpsertResult> {
  validateInput(input);
  const target = await resolveTarget(ctx, input.file);
  const git = await gitState(ctx, target);
  if (git.tracked) throw trackedError(target.relative);

  const existing = await readIfExists(target.absolute);
  const matcher = lineMatcher(input.name);
  const present = existing !== null && findValue(existing, input.name) !== undefined;
  if (present && !input.replace) throw envKeyExists(target.relative, input.name);

  // Ignore the file before the value lands in it, so there is no window where a
  // secret sits in an unignored file.
  let gitignored = git.ignored;
  if (git.inWorkTree && !git.ignored) {
    await ensureGitignored(target);
    gitignored = true;
  }

  const line = `${input.name}=${input.value}`;
  let next: string;
  if (existing === null) {
    next = `${line}\n`;
  } else if (present) {
    // Replace in place: every other line, comment, and blank stays byte for byte.
    next = existing
      .split("\n")
      .map((raw) => {
        const eol = raw.endsWith("\r") ? "\r" : "";
        return matcher.test(raw.replace(/\r$/, "")) ? `${line}${eol}` : raw;
      })
      .join("\n");
  } else {
    next = `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${line}\n`;
  }

  if (existing !== null && next === existing) {
    if (input.secret && ctx.deps.platform !== "win32") await chmod(target.absolute, 0o600);
    return { file: target.relative, replaced: present, gitignored, changed: false };
  }

  await mkdir(dirname(target.absolute), { recursive: true });
  let mode = input.secret ? 0o600 : 0o644;
  if (!input.secret && existing !== null) mode = (await stat(target.absolute)).mode & 0o777;
  const temporary = `${target.absolute}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, next, { mode, flag: "wx" });
    if (ctx.deps.platform !== "win32") await chmod(temporary, mode);
    await rename(temporary, target.absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { file: target.relative, replaced: present, gitignored, changed: true };
}

/** Which of `names` the file defines with a non-empty value. Presence only, never a value. */
export async function readEnvPresence(
  ctx: CliContext,
  file: string,
  names: readonly string[]
): Promise<Record<string, boolean>> {
  const target = await resolveTarget(ctx, file);
  const contents = (await readIfExists(target.absolute)) ?? "";
  const result: Record<string, boolean> = {};
  for (const name of names) {
    const value = findValue(contents, name);
    result[name] = value !== undefined && value !== "";
  }
  return result;
}

/**
 * The value of `name`, for `doctor.ts` alone. It compares the value locally and
 * never outputs it.
 */
export async function readEnvValueForCheck(
  ctx: CliContext,
  file: string,
  name: string
): Promise<string | undefined> {
  const target = await resolveTarget(ctx, file);
  const contents = await readIfExists(target.absolute);
  if (contents === null) return undefined;
  const value = findValue(contents, name);
  return value === "" ? undefined : value;
}

export interface EnvFileInspection {
  readonly exists: boolean;
  readonly tracked: boolean;
  /** Null when git is absent or the project is not a work tree. */
  readonly ignored: boolean | null;
  /** POSIX only: true when group or other can read the file. */
  readonly looseMode: boolean;
}

/** Reports the facts `doctor.ts` needs about the file without changing anything. */
export async function inspectEnvFile(ctx: CliContext, file: string): Promise<EnvFileInspection> {
  const target = await resolveTarget(ctx, file);
  let mode: number;
  try {
    mode = (await stat(target.absolute)).mode;
  } catch {
    return { exists: false, tracked: false, ignored: null, looseMode: false };
  }
  const git = await gitState(ctx, target);
  return {
    exists: true,
    tracked: git.tracked,
    ignored: git.inWorkTree ? git.ignored : null,
    looseMode: ctx.deps.platform !== "win32" && (mode & 0o077) !== 0
  };
}
