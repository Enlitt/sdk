/**
 * `project.ts`: project root discovery and language detection.
 *
 * Runs against real temporary directories; only `ctx.deps.cwd` is read by
 * `findProjectRoot`, so a minimal context is enough.
 */
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CliContext } from "./main.js";
import { defaultEnvFileFor, detectLanguage, findProjectRoot } from "./project.js";

/** A fresh empty directory containing a nested `src/app` working directory. */
async function freshTree(): Promise<{ root: string; nested: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enlitt-project-")));
  const nested = join(root, "src", "app");
  await mkdir(nested, { recursive: true });
  return { root, nested };
}

function contextAt(cwd: string): CliContext {
  return { deps: { cwd } } as unknown as CliContext;
}

describe("findProjectRoot", () => {
  const markers: readonly { name: string; create: (root: string) => Promise<void> }[] = [
    { name: "package.json", create: (root) => writeFile(join(root, "package.json"), "{}\n") },
    { name: "pyproject.toml", create: (root) => writeFile(join(root, "pyproject.toml"), "") },
    { name: "requirements.txt", create: (root) => writeFile(join(root, "requirements.txt"), "") },
    { name: "App.csproj", create: (root) => writeFile(join(root, "App.csproj"), "") },
    { name: "App.sln", create: (root) => writeFile(join(root, "App.sln"), "") },
    { name: ".git", create: (root) => mkdir(join(root, ".git")) }
  ];

  for (const marker of markers) {
    it(`treats ${marker.name} as a root marker found from a nested cwd`, async () => {
      const { root, nested } = await freshTree();
      await marker.create(root);
      expect(await findProjectRoot(contextAt(nested))).toBe(root);
    });
  }

  it("prefers the nearest marker, including cwd itself", async () => {
    const { root, nested } = await freshTree();
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(nested, "requirements.txt"), "");
    expect(await findProjectRoot(contextAt(nested))).toBe(nested);
  });
});

describe("detectLanguage", () => {
  it("follows its order: package.json beats pyproject.toml beats a .NET file", async () => {
    const { root } = await freshTree();
    expect(await detectLanguage(root)).toBe("node");
    await writeFile(join(root, "App.sln"), "");
    expect(await detectLanguage(root)).toBe("dotnet");
    await writeFile(join(root, "requirements.txt"), "");
    expect(await detectLanguage(root)).toBe("python");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "pyproject.toml"), "");
    expect(await detectLanguage(root)).toBe("node");
  });

  it("recognises each of pyproject.toml, requirements.txt, *.csproj, and *.sln alone", async () => {
    for (const [file, language] of [
      ["pyproject.toml", "python"],
      ["requirements.txt", "python"],
      ["App.csproj", "dotnet"],
      ["App.sln", "dotnet"]
    ] as const) {
      const { root } = await freshTree();
      await writeFile(join(root, file), "");
      expect(await detectLanguage(root)).toBe(language);
    }
  });

  it("reads only the root, not nested directories", async () => {
    const { root, nested } = await freshTree();
    await writeFile(join(nested, "package.json"), "{}\n");
    expect(await detectLanguage(root)).toBe("node");
    await writeFile(join(root, "requirements.txt"), "");
    expect(await detectLanguage(root)).toBe("python");
  });
});

describe("defaultEnvFileFor", () => {
  it("uses .env.local for node and .env otherwise", () => {
    expect(defaultEnvFileFor("node")).toBe(".env.local");
    expect(defaultEnvFileFor("python")).toBe(".env");
    expect(defaultEnvFileFor("dotnet")).toBe(".env");
  });
});
