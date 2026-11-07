/**
 * Entry point of the CLI: builds the run context from injected effects, parses
 * the command line, runs one command, and renders the one error path.
 *
 * Every effect (network, clock, terminal, git, browser) arrives through
 * `CliDeps`, so tests run without a network, a clock, a TTY, or a real git.
 */
import { parseCommandLine } from "./args.js";
import type { CommandSpec, FlagDoc } from "./args.js";
import { COMMANDS } from "./commands.js";
import { CliError, describeError, Output, SecretRegistry, usageError } from "./output.js";
import type { OutputStream } from "./output.js";
import { CLI_VERSION } from "./version.js";

/** Every effect the CLI performs. */
export interface CliDeps {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly homedir: string;
  readonly platform: NodeJS.Platform;
  readonly hostname: string;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean };
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly git: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
}

export type CliEnvironment = "production" | "staging";

/** The state one command run shares. */
export interface CliContext {
  readonly deps: CliDeps;
  readonly env: CliEnvironment;
  readonly apiOrigin: string;
  readonly json: boolean;
  readonly out: Output;
  readonly secrets: SecretRegistry;
}

const ORIGINS: Readonly<Record<CliEnvironment, string>> = {
  production: "https://api.enlitt.com",
  staging: "https://staging-api.enlitt.com"
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function resolveEnvironment(value: string | undefined): CliEnvironment {
  if (value === undefined || value === "production") return "production";
  if (value === "staging") return "staging";
  throw usageError("--env must be production or staging");
}

/** `ENLITT_CLI_API_ORIGIN` replaces the origin; it must be https, or http on loopback. */
function resolveOrigin(environment: CliEnvironment, env: CliDeps["env"]): string {
  const override = env.ENLITT_CLI_API_ORIGIN;
  if (override === undefined || override === "") return ORIGINS[environment];
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw usageError("ENLITT_CLI_API_ORIGIN is not a valid URL");
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (!secure && !loopback) {
    throw usageError("ENLITT_CLI_API_ORIGIN must be https, or http on a loopback host");
  }
  return url.origin;
}

/** One `--help` line for a flag: name, value placeholder, description, and default. */
function flagLine(
  name: string,
  kind: string,
  doc: FlagDoc | undefined
): { left: string; right: string } {
  const placeholder = kind === "bool" ? "" : ` ${doc?.value ?? "<value>"}`;
  const repeatable = kind === "list" ? " (repeatable)" : "";
  const defaultText = doc?.default === undefined ? "" : ` (default: ${doc.default})`;
  return {
    left: `--${name}${placeholder}`,
    right: `${doc?.description ?? ""}${repeatable}${defaultText}`.trim()
  };
}

function commandHelp(command: CommandSpec): string {
  const lines = Object.entries(command.flags).map(([name, kind]) =>
    flagLine(name, kind, command.flagDocs?.[name])
  );
  const width = Math.max(0, ...lines.map((line) => line.left.length));
  const flags = lines.map((line) => `  ${line.left.padEnd(width + 2)}${line.right}`.trimEnd());
  return [
    `${command.summary}`,
    "",
    `Usage: enlitt ${command.usage}`,
    ...(flags.length > 0 ? ["", "Flags:", ...flags] : [])
  ].join("\n");
}

/**
 * The environment named by `--env` in raw argv, or production. Used only to
 * word an error raised before parsing finishes; a bad value is reported by
 * `resolveEnvironment` later.
 */
function peekEnvironment(argv: readonly string[]): CliEnvironment {
  const index = argv.indexOf("--env");
  const value =
    index === -1
      ? argv.find((token) => token.startsWith("--env="))?.slice("--env=".length)
      : argv[index + 1];
  return value === "staging" ? "staging" : "production";
}

function generalHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.join(" ").length));
  const rows = COMMANDS.map(
    (command) => `  ${command.name.join(" ").padEnd(width + 2)}${command.summary}`
  );
  return [
    `enlitt ${CLI_VERSION}: the Enlitt business terminal client`,
    "",
    "Usage: enlitt <command> [flags]",
    "",
    "Commands:",
    ...rows,
    "",
    "Global flags:",
    "  --json                      print one JSON document on stdout",
    "  --env production|staging    choose the API (default production)",
    "  --help, -h                  show help",
    "  --version                   show the version",
    "",
    "Run `enlitt <command> --help` for a command's flags."
  ].join("\n");
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const secrets = new SecretRegistry();
  const debug = deps.env.ENLITT_CLI_DEBUG === "1";
  // Until parsing succeeds, `--json` anywhere in argv decides how an error renders.
  let environment: CliEnvironment = peekEnvironment(argv);
  let out = new Output(deps, argv.includes("--json"), secrets, environment);
  try {
    const parsed = parseCommandLine(argv, COMMANDS);
    out = new Output(deps, parsed.globals.json, secrets, environment);
    if (parsed.kind === "version") {
      deps.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    if (parsed.kind === "help") {
      deps.stdout.write(
        `${parsed.command === undefined ? generalHelp() : commandHelp(parsed.command)}\n`
      );
      return 0;
    }
    environment = resolveEnvironment(parsed.globals.env);
    const ctx: CliContext = {
      deps,
      env: environment,
      apiOrigin: resolveOrigin(environment, deps.env),
      json: parsed.globals.json,
      out,
      secrets
    };
    return await parsed.command.run(parsed.args, ctx);
  } catch (error) {
    const { body, exitCode } = describeError(error, debug, environment);
    out.error(body);
    return error instanceof CliError ? exitCode : 1;
  }
}
