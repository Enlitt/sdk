import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { CLI_VERSION } from "./version.js";

it("CLI_VERSION equals the package.json version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(CLI_VERSION).toBe(manifest.version);
});
