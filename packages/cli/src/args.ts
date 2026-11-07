/**
 * Hand-written argument tokenizer, in the same pattern as
 * `apps/admin-cli/src/commands.ts`: no parsing dependency, exact errors.
 *
 * Global flags (`--json`, `--env`, `--help`/`-h`, `--version`) are pulled out
 * first, wherever they appear. The command is then the longest command name
 * that prefixes the remaining words, and its own flags are parsed against the
 * command's declared flag table. Every malformed line is a `usage_error`
 * (exit `2`) raised before any effect.
 */
import { usageError } from "./output.js";

/** `bool` takes no value, `value` takes exactly one, `list` may repeat. */
export type FlagKind = "bool" | "value" | "list";

/** What `--help` shows for one flag. */
export interface FlagDoc {
  /** The value placeholder, such as `<id>`; omitted for a boolean flag. */
  readonly value?: string;
  /** One line saying what the flag does. */
  readonly description: string;
  /** What applies when the flag is absent, when there is something to say. */
  readonly default?: string;
}

/** The part of a command definition the tokenizer needs. */
export interface CommandSpec {
  /** The command words, such as `["key", "create"]`. */
  readonly name: readonly string[];
  readonly summary: string;
  /** One usage line, shown by `--help`. */
  readonly usage: string;
  readonly flags: Readonly<Record<string, FlagKind>>;
  /** Per-flag text for `--help`; a flag without an entry is listed bare. */
  readonly flagDocs?: Readonly<Record<string, FlagDoc>>;
  /** Positional argument names, in order; the first `requiredPositionals` are required. */
  readonly positionals: readonly string[];
  readonly requiredPositionals: number;
}

export interface GlobalFlags {
  readonly json: boolean;
  /** The raw `--env` value, validated by `main`. */
  readonly env: string | undefined;
}

/** The parsed flags and positionals of one command line. */
export class ParsedArgs {
  constructor(
    readonly positionals: readonly string[],
    private readonly values: ReadonlyMap<string, string | true | string[]>
  ) {}

  /** A value flag, or undefined when absent. */
  value(name: string): string | undefined {
    const found = this.values.get(name);
    return typeof found === "string" ? found : undefined;
  }

  /** A boolean flag. */
  bool(name: string): boolean {
    return this.values.get(name) === true;
  }

  /** A repeatable flag's values in order; empty when absent. */
  list(name: string): readonly string[] {
    const found = this.values.get(name);
    return Array.isArray(found) ? found : [];
  }

  /** True when the flag was given at all, whatever its kind. */
  has(name: string): boolean {
    return this.values.has(name);
  }
}

export type ParsedLine<C extends CommandSpec> =
  | { readonly kind: "help"; readonly globals: GlobalFlags; readonly command?: C }
  | { readonly kind: "version"; readonly globals: GlobalFlags }
  | {
      readonly kind: "command";
      readonly globals: GlobalFlags;
      readonly command: C;
      readonly args: ParsedArgs;
    };

/** True when `--` is followed by a flag-looking token that cannot be a value. */
function looksLikeLongFlag(token: string): boolean {
  return token.startsWith("--");
}

/** Pulls the global flags out of `argv`, leaving the command words and its flags. */
function extractGlobals(argv: readonly string[]): {
  globals: GlobalFlags;
  help: boolean;
  version: boolean;
  rest: string[];
} {
  let json = false;
  let help = false;
  let version = false;
  let env: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--json") json = true;
    else if (token === "--help" || token === "-h") help = true;
    else if (token === "--version") version = true;
    else if (token === "--env" || token.startsWith("--env=")) {
      if (env !== undefined) throw usageError("--env given twice");
      if (token === "--env") {
        const next = argv[index + 1];
        if (next === undefined || looksLikeLongFlag(next)) throw usageError("--env needs a value");
        env = next;
        index += 1;
      } else {
        env = token.slice("--env=".length);
      }
    } else rest.push(token);
  }
  return { globals: { json, env }, help, version, rest };
}

/** Finds the command whose name is the longest prefix of `words`. */
function findCommand<C extends CommandSpec>(
  words: readonly string[],
  commands: readonly C[]
): C | undefined {
  let best: C | undefined;
  for (const command of commands) {
    const matches = command.name.every((word, index) => words[index] === word);
    if (matches && (best === undefined || command.name.length > best.name.length)) best = command;
  }
  return best;
}

function parseCommandArgs(command: CommandSpec, tokens: readonly string[]): ParsedArgs {
  const values = new Map<string, string | true | string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!looksLikeLongFlag(token)) throw usageError(`unknown flag ${token}`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const kind = command.flags[name];
    if (kind === undefined)
      throw usageError(`unknown flag --${name} for \`enlitt ${command.name.join(" ")}\``);
    if (kind === "bool") {
      if (equals !== -1) throw usageError(`--${name} takes no value`);
      if (values.has(name)) throw usageError(`--${name} given twice`);
      values.set(name, true);
      continue;
    }
    let value: string;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      const next = tokens[index + 1];
      if (next === undefined || looksLikeLongFlag(next))
        throw usageError(`--${name} needs a value`);
      value = next;
      index += 1;
    }
    if (kind === "list") {
      const existing = values.get(name);
      if (Array.isArray(existing)) existing.push(value);
      else values.set(name, [value]);
    } else {
      if (values.has(name)) throw usageError(`--${name} given twice`);
      values.set(name, value);
    }
  }
  if (positionals.length > command.positionals.length) {
    throw usageError(`unexpected argument "${positionals[command.positionals.length]!}"`);
  }
  if (positionals.length < command.requiredPositionals) {
    const missing = command.positionals[positionals.length]!;
    throw usageError(`missing <${missing}> for \`enlitt ${command.name.join(" ")}\``);
  }
  return new ParsedArgs(positionals, values);
}

/**
 * Parses a whole command line against the command table. Throws a
 * `usage_error` for anything malformed; a bare `enlitt` yields `help`.
 */
export function parseCommandLine<C extends CommandSpec>(
  argv: readonly string[],
  commands: readonly C[]
): ParsedLine<C> {
  const { globals, help, version, rest } = extractGlobals(argv);
  if (version) return { kind: "version", globals };
  const command = findCommand(rest, commands);
  if (help || rest.length === 0) {
    return command === undefined ? { kind: "help", globals } : { kind: "help", globals, command };
  }
  if (command === undefined) {
    const first = rest[0]!;
    throw usageError(
      first.startsWith("-") ? `unknown flag ${first}` : `unknown command "${rest.join(" ")}"`
    );
  }
  const args = parseCommandArgs(command, rest.slice(command.name.length));
  return { kind: "command", globals, command, args };
}
