import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    core: "src/core/index.ts",
    vercel: "src/vercel/index.ts",
    openai: "src/openai/index.ts",
    server: "src/server/index.ts",
    "server-unavailable": "src/server-unavailable.ts"
  },
  format: ["esm", "cjs"],
  target: "es2022",
  // Declarations are emitted by `tsc` rather than by tsup's bundled
  // rollup-plugin-dts, which reads TypeScript's JS API and crashes against the
  // TypeScript 7 native port this repository pins. See the `build` script.
  dts: false,
  clean: true,
  sourcemap: true,
  // One shared copy of each module across entries, so `instanceof` on an SDK
  // error class and the session context work whichever entry a business
  // imports them from (`specs/SDK-side routing.md`).
  splitting: true,
  treeshake: true
});
