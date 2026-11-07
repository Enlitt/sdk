import { defineConfig } from "tsup";

/**
 * The CLI ships as one self-contained ESM file. `@enlitt/protocol` is a
 * devDependency that is bundled in (`noExternal`), so the packed tarball has no
 * runtime dependency and `npx enlitt` works with nothing else installed.
 */
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@enlitt/protocol"],
  // Declarations are not needed: the package exposes a binary, not a library.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" }
});
