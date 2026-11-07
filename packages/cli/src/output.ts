/**
 * Rendering for the CLI: human text, `--json` documents, and the single
 * mapping from any thrown error to `{ code, message, action }`.
 *
 * Every byte that reaches stdout or stderr passes through `SecretRegistry`, so
 * even a bug elsewhere cannot print a CLI token, a device code, or a freshly
 * minted API key. The one deliberate exception is `Output.revealSecret`, which
 * backs `--reveal`.
 */

import type { CliEnvironment } from "./main.js";

/** The minimal stream surface the CLI writes to. Node's `Writable` satisfies it. */
export interface OutputStream {
  write(chunk: string): unknown;
}

const REDACTED = "[redacted]";

/** Defence in depth: CLI tokens are recognizable by prefix whatever else happens. */
const CLI_TOKEN_PATTERN = /enl_cli_[A-Za-z0-9_-]+/g;

/** Shortest value worth registering; shorter strings would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** Remembers every secret this run has held and removes them from output text. */
export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (value.length >= MIN_SECRET_LENGTH) this.values.add(value);
  }

  scrub(text: string): string {
    let result = text;
    for (const value of this.values) result = result.split(value).join(REDACTED);
    return result.replace(CLI_TOKEN_PATTERN, REDACTED);
  }
}

/**
 * A refusal or failure the CLI can describe to a person or an agent. `code` is
 * stable, `message` says what happened, and `action` says what to do next.
 * `exitCode` is `2` only for usage errors.
 */
export class CliError extends Error {
  override readonly name: string = "CliError";
  readonly code: string;
  readonly action: string | undefined;
  readonly exitCode: 1 | 2;

  constructor(code: string, message: string, options: { action?: string; exitCode?: 1 | 2 } = {}) {
    super(message);
    this.code = code;
    this.action = options.action;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** An unknown command or flag, a missing value, or a malformed value: exit `2`. */
export function usageError(message: string): CliError {
  return new CliError("usage_error", message, {
    exitCode: 2,
    action: "Run `enlitt --help` for the commands and flags."
  });
}

/**
 * The website (docs and dashboard) for an environment, per `docs/ENVIRONMENTS.md`.
 * Every URL the CLI prints for a person is built from this, never hard-coded.
 */
export function siteOrigin(environment: CliEnvironment): string {
  return environment === "staging" ? "https://staging.enlitt.com" : "https://enlitt.com";
}

/** The flag that points a printed command at staging; production is the default and needs none. */
export function envFlag(environment: CliEnvironment): string {
  return environment === "staging" ? " --env staging" : "";
}

/**
 * A command the reader can paste, as printed: `npx enlitt <args>` plus
 * `--env staging` on staging, so a printed command never acts on production by
 * accident. `args` is everything after `enlitt`.
 */
export function printedCommand(environment: CliEnvironment, args: string): string {
  return `npx enlitt ${args}${envFlag(environment)}`;
}

/**
 * Rewrites every backticked `enlitt ...` span in `text` into the printed form
 * `npx enlitt ... [--env staging]`. Call sites and the action table are written
 * without the prefix and suffix; this is the one place that adds them, at the
 * moment text is written. Spans that are not Enlitt commands (such as
 * `enlitt.json`, `--app <id>`, or an already printed `npx enlitt ...`) are untouched.
 */
export function qualifyCommands(text: string, environment: CliEnvironment): string {
  return text.replace(/`enlitt ([^`]*)`/g, (_span, args: string) => {
    const hasEnv = /(^|\s)--env(\s|=|$)/.test(args);
    return `\`${hasEnv ? `npx enlitt ${args}` : printedCommand(environment, args)}\``;
  });
}

function fallbackAction(environment: CliEnvironment): string {
  return `See ${siteOrigin(environment)}/docs/errors.md.`;
}

/** The one table mapping an error code to its next step (specs/SDK-side routing.md). */
const ERROR_ACTIONS: Readonly<Record<string, string>> = {
  not_logged_in: "Run `enlitt login`.",
  dashboard_login_required: "Run `enlitt login`.",
  reauthentication_required:
    "Run `enlitt reauth --no-wait`, ask the developer to open the printed URL and approve, run `enlitt reauth --wait`, then retry the command.",
  insufficient_permissions:
    "Your role in this business does not allow this, or the CLI cannot do it. Ask the business owner, or use the dashboard.",
  business_selection_required:
    "You no longer have access to this business. Run `enlitt login` again.",
  confirmation_required: "Ask the developer to confirm, then rerun with `--confirm`.",
  secret_destination_required: "Rerun with `--write-env <file>`.",
  env_file_tracked: "The file is committed to git. Use an untracked file such as `.env.local`.",
  env_key_exists:
    "The file already holds this key. Rerun with `--replace` only if the developer wants it overwritten.",
  insecure_credential_file: "Run `chmod 600 <path>`, then retry.",
  project_not_linked: "Run `enlitt setup` or pass `--app <id>`.",
  premium_not_enabled:
    "Premium credit is off for this app. An owner or admin can run `enlitt app premium <id> --on`.",
  network_error: "Check the network and retry."
};

/**
 * The refusal text for a business permission the signed-in role lacks
 * (`specs/SDK-side routing.md` "Roles and the local permission check"). The one
 * table keyed by permission: no role name is ever compared, `role` is only
 * printed. A permission without its own entry gets the generic message and the
 * generic `insufficient_permissions` action (`action` undefined).
 */
const PERMISSION_REFUSALS: Readonly<
  Record<string, (role: string, business: string) => { message: string; action: string }>
> = {
  "keys.manage": (role, business) => ({
    message: `Your role (${role}) in ${business} can't create, rotate, revoke, or list read-only keys. Only the business owner can.`,
    action:
      "Ask the business owner to run this command, or to create the key in the dashboard Keys page."
  }),
  "apps.manage": (role, business) => ({
    message: `Your role (${role}) in ${business} can't create or change apps.`,
    action:
      "Ask the business owner or an admin to make you a developer or admin, or to run this command."
  }),
  "premium.manage": (role, business) => ({
    message: `Your role (${role}) in ${business} can't turn premium credit on or off.`,
    action:
      "Ask the business owner or an admin to run this command, or to change it on the app's dashboard page."
  })
};

/** The message and (when the permission has its own) action for a missing permission. */
export function permissionRefusal(
  permission: string,
  role: string,
  business: string
): { message: string; action: string | undefined } {
  const own = PERMISSION_REFUSALS[permission];
  if (own !== undefined) return own(role, business);
  return { message: `Your role (${role}) in ${business} can't do this.`, action: undefined };
}

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly action: string;
}

/** Turns any thrown value into the error body and exit code the CLI reports. */
export function describeError(
  error: unknown,
  debug: boolean,
  environment: CliEnvironment = "production"
): { body: ErrorBody; exitCode: 1 | 2 } {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      body: {
        code: error.code,
        message: error.message,
        action: error.action ?? ERROR_ACTIONS[error.code] ?? fallbackAction(environment)
      }
    };
  }
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  const detail =
    debug && error instanceof Error && error.stack !== undefined
      ? `${message}\n${error.stack}`
      : message;
  return {
    exitCode: 1,
    body: { code: "internal_error", message: detail, action: fallbackAction(environment) }
  };
}

/** Writes results to stdout, progress and human errors to stderr, scrubbing both. */
export class Output {
  constructor(
    private readonly streams: { readonly stdout: OutputStream; readonly stderr: OutputStream },
    readonly json: boolean,
    private readonly secrets: SecretRegistry,
    /** The environment the printed commands must target (`--env staging` on staging). */
    private readonly environment: CliEnvironment = "production"
  ) {}

  /** Adds the run's environment to printed commands, then removes every secret. */
  private render(text: string): string {
    return this.secrets.scrub(qualifyCommands(text, this.environment));
  }

  /** Progress text, such as a URL to open. Always stderr so JSON on stdout stays clean. */
  progress(line: string): void {
    this.streams.stderr.write(`${this.render(line)}\n`);
  }

  /** A command's result: one JSON document with `--json`, human text otherwise. */
  result(data: unknown, text: string): void {
    if (this.json) {
      this.streams.stdout.write(`${this.render(JSON.stringify(data))}\n`);
      return;
    }
    const body = this.render(text);
    this.streams.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  }

  /** `--reveal` only: the single place a raw secret is deliberately printed. */
  revealSecret(label: string, secret: string): void {
    this.streams.stdout.write(`${label}: ${secret}\n`);
  }

  /** Renders a failure: a JSON document on stdout, or `error:`/`next:` lines on stderr. */
  error(body: ErrorBody): void {
    if (this.json) {
      this.streams.stdout.write(`${this.render(JSON.stringify({ error: body }))}\n`);
      return;
    }
    this.streams.stderr.write(`${this.render(`error: ${body.message}\nnext: ${body.action}`)}\n`);
  }
}

const NANO_PER_USD = 1_000_000_000n;

/**
 * Formats a canonical NANOUSD integer string as USD for human output, with at
 * least two decimals and no trailing zeros beyond them. Exact: no float.
 */
export function formatUsd(nanoUsd: string): string {
  const value = BigInt(nanoUsd);
  const whole = (value / NANO_PER_USD).toString();
  let fraction = (value % NANO_PER_USD).toString().padStart(9, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `$${whole}.${fraction}`;
}

/** Renders `label: value` rows with aligned values. */
export function formatRows(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${value}`).join("\n");
}
