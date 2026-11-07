// Post-build step: give CommonJS consumers their own declaration files.
//
// tsc emits ESM-flavoured `.d.ts` files (relative specifiers end in `.js`).
// TypeScript treats a `.d.ts` under a `"type": "module"` package as ESM, so a
// `require()` consumer would get ESM types ("false-esm"). tsup's dts bundler
// cannot emit `.d.cts` under the pinned TypeScript 7, so we copy every `.d.ts`
// to a `.d.cts` and rewrite relative `.js` specifiers to `.cjs`, which makes
// the CJS declaration graph resolve only to other `.d.cts` files.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** Recursively lists every `.d.ts` file below `dir`. */
function declarationFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return declarationFiles(path);
    return path.endsWith(".d.ts") ? [path] : [];
  });
}

// Matches the quoted specifier of `from "./x.js"` and `import("./x.js")`.
const relativeJsSpecifier = /(from\s+|import\()(["'])(\.{1,2}\/[^"']*)\.js\2/g;

for (const file of declarationFiles(dist)) {
  const source = readFileSync(file, "utf8");
  const rewritten = source
    .replace(relativeJsSpecifier, "$1$2$3.cjs$2")
    // The map comment would point at the .d.ts map; the copy has none.
    .replace(/^\/\/# sourceMappingURL=.*$/m, "");
  writeFileSync(file.replace(/\.d\.ts$/, ".d.cts"), rewritten);
}
