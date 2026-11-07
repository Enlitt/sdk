import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  // Declarations are emitted by `tsc` rather than by tsup's bundled
  // rollup-plugin-dts, which reads TypeScript's JS API and crashes against the
  // TypeScript 7 native port this repository pins. See the `build` script.
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true
});
