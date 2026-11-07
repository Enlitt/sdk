import { describe, expect, it } from "vitest";

import { parseCommandLine } from "./args.js";
import { COMMANDS } from "./commands.js";
import { CliError } from "./output.js";

function usageCode(argv: string[]): string {
  try {
    parseCommandLine(argv, COMMANDS);
  } catch (error) {
    if (error instanceof CliError) return `${error.code}:${error.exitCode}`;
    throw error;
  }
  return "parsed";
}

describe("every command in the surface parses", () => {
  const lines: string[][] = [
    ["login", "--label", "laptop", "--no-browser", "--no-wait", "--timeout", "30"],
    ["login", "--wait"],
    ["reauth", "--no-browser", "--wait", "--timeout", "5"],
    ["logout"],
    ["whoami", "--json"],
    ["status"],
    ["business", "info", "--from", "2026-01-01", "--to", "2026-01-31"],
    ["traffic", "--app", "app_1", "--days", "7"],
    ["traffic", "--from", "2026-01-01", "--to", "2026-01-31"],
    ["app", "list"],
    ["app", "show"],
    ["app", "show", "app_1"],
    ["app", "create", "--name", "n", "--environment", "test", "--redirect-uri", "https://a.example/cb", "--redirect-uri", "https://b.example/cb", "--origin", "https://a.example", "--icon-url", "https://a.example/i.png", "--description", "d", "--link", "--confirm"],
    ["app", "update", "app_1", "--name", "n", "--add-redirect-uri", "https://a.example/cb", "--remove-origin", "https://a.example", "--clear-icon-url", "--clear-description"],
    ["key", "list", "--app", "app_1", "--scope", "model"],
    ["key", "create", "--app", "app_1", "--name", "n", "--write-env", ".env.local", "--replace", "--var", "X"],
    ["key", "create", "--scope", "reporting", "--name", "n", "--reveal"],
    ["key", "rotate", "key_1", "--write-env", ".env.local", "--confirm"],
    ["key", "revoke", "key_1", "--confirm"],
    ["setup", "--app", "app_1", "--name", "n", "--environment", "live", "--redirect-uri", "https://a.example/cb", "--origin", "https://a.example", "--env-file", ".env", "--replace-secret"],
    ["doctor", "--app", "app_1", "--env-file", ".env", "--callback-url", "https://a.example/cb", "--callback-url", "https://b.example/cb"]
  ];
  it.each(lines)("%s", (...argv) => {
    expect(usageCode(argv)).toBe("parsed");
  });

  it("parses --env and --json anywhere, plus --help and --version", () => {
    expect(parseCommandLine(["--json", "whoami", "--env", "staging"], COMMANDS)).toMatchObject({
      kind: "command",
      globals: { json: true, env: "staging" }
    });
    expect(parseCommandLine(["whoami", "--env=staging"], COMMANDS).globals.env).toBe("staging");
    expect(parseCommandLine(["--version"], COMMANDS).kind).toBe("version");
    expect(parseCommandLine(["key", "create", "-h"], COMMANDS)).toMatchObject({ kind: "help" });
    expect(parseCommandLine([], COMMANDS).kind).toBe("help");
  });
});

describe("malformed lines are usage errors with exit 2", () => {
  const bad: [string, string[]][] = [
    ["unknown command", ["frobnicate"]],
    ["unknown flag", ["whoami", "--nope"]],
    ["short flag", ["whoami", "-x"]],
    ["missing flag value", ["login", "--label"]],
    ["value given to a boolean", ["login", "--no-wait=1"]],
    ["duplicate flag", ["login", "--label", "a", "--label", "b"]],
    ["extra positional", ["key", "revoke", "a", "b"]],
    ["missing positional", ["key", "revoke"]],
    ["--env without a value", ["whoami", "--env"]],
    ["--env twice", ["whoami", "--env", "staging", "--env", "production"]]
  ];
  it.each(bad)("%s", (_name, argv) => {
    expect(usageCode(argv)).toBe("usage_error:2");
  });
});
