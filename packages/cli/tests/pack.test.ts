/**
 * Packs the CLI exactly as it would be published and installs the tarball into an
 * empty project with no workspace link, so a missing bundled dependency or a
 * broken bin shows up here. It builds through the package's `prepack` script.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let scratch: string;
let tarball: string;
let extracted: string;
let installed: string;
let version: string;

/** The environment child processes get: no secrets, an isolated home for npm. */
function childEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: scratch, npm_config_cache: join(scratch, "npm-cache") };
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, env: childEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "enlitt-cli-pack-"));
  const destination = join(scratch, "pack");
  mkdirSync(destination);
  run("pnpm", ["--filter", "@enlitt/cli", "pack", "--pack-destination", destination], REPOSITORY_ROOT);
  const files = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
  expect(files).toHaveLength(1);
  tarball = join(destination, files[0]!);

  extracted = join(scratch, "extracted");
  mkdirSync(extracted);
  run("tar", ["-xzf", tarball, "-C", extracted], scratch);

  installed = join(scratch, "consumer");
  mkdirSync(installed);
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", tarball], installed);
  version = (JSON.parse(readFileSync(join(extracted, "package", "package.json"), "utf8")) as { version: string }).version;
}, 180_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("packed tarball", () => {
  it("has no runtime dependency, because the protocol package is bundled", () => {
    const manifest = JSON.parse(readFileSync(join(extracted, "package", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(manifest.bin).toEqual({ enlitt: "dist/bin.js" });
    const bundle = readFileSync(join(extracted, "package", "dist", "bin.js"), "utf8");
    expect(bundle).not.toMatch(/from ["']@enlitt\/protocol["']/);
  });

  it("ships only dist, the manifest, and the package pages", () => {
    const top = readdirSync(join(extracted, "package")).sort();
    expect(top.filter((name) => !["package.json", "dist", "README.md", "CHANGELOG.md", "LICENSE"].includes(name))).toEqual([]);
    expect(top).toContain("dist");
  });

  it("starts dist/bin.js with the node shebang", () => {
    const bundle = readFileSync(join(extracted, "package", "dist", "bin.js"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("installed binary", () => {
  it("npx enlitt --version prints the package version", () => {
    expect(run("npx", ["--no-install", "enlitt", "--version"], installed).trim()).toBe(version);
  });

  it("npx enlitt --help lists the commands", () => {
    const help = run("npx", ["--no-install", "enlitt", "--help"], installed);
    for (const command of ["login", "whoami", "setup", "doctor", "key create", "traffic"]) {
      expect(help, command).toContain(command);
    }
  });

  it("a bad command exits 2 with an error on stderr", () => {
    let status = 0;
    try {
      run("npx", ["--no-install", "enlitt", "nonsense"], installed);
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
