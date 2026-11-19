// Builds the TypeScript library into the single ESM bundle the package
// publishes: target/library/penpot.js. The bundle is environment agnostic, the
// way the shadow-cljs `:esm` build was: it carries the zip implementation and
// touches no node builtin.
//
// Runs from the library directory. Set PENPOT_LIBRARY_OUTDIR to build somewhere
// else; `--watch` rebuilds on change.

import { build, context } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const outdir = process.env.PENPOT_LIBRARY_OUTDIR ?? path.join("target", "library");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(await readFile("package.json", "utf8"));

// The version lives in package.json only. The define replaces the global
// `version.ts` reads, so the published manifest says `penpot-library/<version>`.
const define = {
  __PENPOT_LIBRARY_VERSION__: JSON.stringify(pkg.version),
};

function options() {
  return {
    entryPoints: ["src-ts/index.ts"],
    bundle: true,
    platform: "neutral",
    conditions: ["import", "module", "default"],
    mainFields: ["module", "main"],
    target: "es2020",
    format: "esm",
    outfile: path.join(outdir, "penpot.js"),
    sourcemap: true,
    define,
  };
}

if (watch) {
  const ctx = await context(options());
  await ctx.watch();
  console.log(`watching src-ts into ${outdir}`);
} else {
  await rm(outdir, { recursive: true, force: true });
  await build(options());
}
