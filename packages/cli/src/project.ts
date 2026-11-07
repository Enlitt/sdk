/**
 * `enlitt.json`: the project link. It records which application a project
 * expects and is safe to commit, because it never holds a secret, key ID, or
 * token. `doctor` compares it with what Enlitt has registered.
 */
import { randomBytes } from "node:crypto";
import { access, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import type { CliContext } from "./main.js";
import { CliError } from "./output.js";

export const PROJECT_FILE_NAME = "enlitt.json";
export const DEFAULT_ENV_FILE = ".env.local";

export interface ProjectFile {
  readonly applicationId: string;
  readonly environment: "test" | "live";
  readonly redirectUris: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly envFile: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The languages `setup` tells apart; it only picks the env file and the docs page. */
export type ProjectLanguage = "node" | "python" | "dotnet";

/** True when `directory` holds a .NET project or solution file (`*.csproj`, `*.sln`). */
async function hasDotnetFile(directory: string): Promise<boolean> {
  try {
    const names = await readdir(directory);
    return names.some((name) => name.endsWith(".csproj") || name.endsWith(".sln"));
  } catch {
    return false;
  }
}

/**
 * True when `directory` holds any project root marker: `package.json`,
 * `pyproject.toml`, `requirements.txt`, a `*.csproj` or `*.sln` file, or `.git`.
 */
async function hasRootMarker(directory: string): Promise<boolean> {
  for (const marker of ["package.json", "pyproject.toml", "requirements.txt", ".git"]) {
    if (await exists(join(directory, marker))) return true;
  }
  return hasDotnetFile(directory);
}

/**
 * The project root: the nearest ancestor of `cwd` (`cwd` itself included)
 * holding any root marker, else `cwd` itself.
 */
export async function findProjectRoot(ctx: CliContext): Promise<string> {
  let directory = ctx.deps.cwd;
  for (;;) {
    if (await hasRootMarker(directory)) return directory;
    if (dirname(directory) === directory || directory === parse(directory).root) break;
    directory = dirname(directory);
  }
  return ctx.deps.cwd;
}

/**
 * The language of the project at `root`. It reads only the root, in a fixed
 * order: `package.json` is `node`, then `pyproject.toml` or `requirements.txt`
 * is `python`, then a `*.csproj` or `*.sln` file is `dotnet`, else `node`.
 * The first match wins, so a Node-built frontend inside a Python repository
 * still means its developer reads the Node docs. Never written to `enlitt.json`.
 */
export async function detectLanguage(root: string): Promise<ProjectLanguage> {
  if (await exists(join(root, "package.json"))) return "node";
  if (
    (await exists(join(root, "pyproject.toml"))) ||
    (await exists(join(root, "requirements.txt")))
  ) {
    return "python";
  }
  if (await hasDotnetFile(root)) return "dotnet";
  return "node";
}

/** The env file `setup` writes when neither `--env-file` nor `enlitt.json` names one. */
export function defaultEnvFileFor(language: ProjectLanguage): string {
  return language === "node" ? DEFAULT_ENV_FILE : ".env";
}

function invalid(field: string, problem: string): CliError {
  return new CliError("invalid_project_file", `${PROJECT_FILE_NAME}: ${field} ${problem}.`, {
    action: `Fix or delete ${PROJECT_FILE_NAME}, or rerun \`enlitt setup\`.`
  });
}

function stringList(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalid(field, "must be an array of strings");
  }
  return value;
}

/** Validates parsed JSON as a project file, naming the first offending field. */
function validateProject(value: unknown): ProjectFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("the file", "must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const known = ["applicationId", "environment", "redirectUris", "allowedOrigins", "envFile"];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw invalid(key, "is not a known field");
  }
  const { applicationId, environment, envFile } = record;
  if (typeof applicationId !== "string" || applicationId === "") {
    throw invalid("applicationId", "must be a non-empty string");
  }
  if (environment !== "test" && environment !== "live")
    throw invalid("environment", 'must be "test" or "live"');
  if (typeof envFile !== "string" || envFile === "")
    throw invalid("envFile", "must be a non-empty string");
  return {
    applicationId,
    environment,
    redirectUris: stringList(record, "redirectUris"),
    allowedOrigins: stringList(record, "allowedOrigins"),
    envFile
  };
}

/** Reads `enlitt.json` from the project root; null when the project is not linked. */
export async function readProject(ctx: CliContext): Promise<ProjectFile | null> {
  const path = join(await findProjectRoot(ctx), PROJECT_FILE_NAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("the file", "is not valid JSON");
  }
  return validateProject(parsed);
}

/** Writes `enlitt.json` atomically at the project root. */
export async function writeProject(ctx: CliContext, project: ProjectFile): Promise<void> {
  const path = join(await findProjectRoot(ctx), PROJECT_FILE_NAME);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
