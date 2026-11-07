import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { SDK_VERSION } from "./transport.js";

// SDK_VERSION is bumped by hand (see its comment in transport.ts); this keeps a
// release from shipping an `X-Enlitt-SDK-Version` header that names the wrong build.
it("SDK_VERSION equals the package.json version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  expect(SDK_VERSION).toBe(manifest.version);
});
