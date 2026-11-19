// Builds the TypeScript exporter into a single ESM bundle, the shape
// `exporter/scripts/build` already ships for the CLJS tree: `app.js` plus the
// wasm artifacts and the package files the runtime installs from.
//
// Runs from the exporter directory. Set PENPOT_EXPORTER_OUTDIR to build
// somewhere else; `--watch` rebuilds on change and skips the version stamp.

import { build, context } from "esbuild";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const outdir = process.env.PENPOT_EXPORTER_OUTDIR ?? "target";
const watch = process.argv.includes("--watch");
const version =
  process.env.PENPOT_VERSION ?? process.argv.slice(2).find((arg) => !arg.startsWith("-"));

// Mirrors `gfontsFile` in src-ts/app/fonts.ts. The TS build reads the font
// catalogue from disk at runtime, where the CLJS build compiled it in.
const GFONTS_FILE = path.join("..", "common", "resources", "fonts", "gfonts.2025.11.28.json");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source, target, { required = false } = {}) {
  if (!(await exists(source))) {
    if (required) {
      console.error(`error: missing ${source}; run pnpm run build:wasm first`);
      process.exitCode = 1;
    } else {
      console.warn(`warning: ${source} not found, skipped`);
    }
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

function options() {
  return {
    entryPoints: ["src-ts/app/app.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: path.join(outdir, "app.js"),
    sourcemap: true,
  };
}

// The bundle keeps `%version%` until the build stamps it, as the CLJS build
// did with sed. Only release builds get a stamp; a watch build keeps the
// placeholder, which parses as develop.
async function stampVersion() {
  if (version === undefined) return;

  const file = path.join(outdir, "app.js");
  const code = await readFile(file, "utf8");
  await writeFile(file, code.replaceAll("%version%", version));
}

await rm(outdir, { recursive: true, force: true });

await copyIfPresent(
  path.join("resources", "wasm", "render-wasm.js"),
  path.join(outdir, "resources", "wasm", "render-wasm.js"),
  { required: true },
);
await copyIfPresent(
  path.join("resources", "wasm", "render-wasm.wasm"),
  path.join(outdir, "resources", "wasm", "render-wasm.wasm"),
  { required: true },
);
await copyIfPresent(GFONTS_FILE, path.join(outdir, "resources", "fonts", path.basename(GFONTS_FILE)));

// The runtime resolves its dependencies from the copy, exactly like the CLJS
// build: the bundle keeps `deps.ts` loading them lazily through node_modules.
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  await copyFile(file, path.join(outdir, file));
}

const setup = `#!/usr/bin/env bash
set -e;
command -v pnpm >/dev/null || { echo "error: pnpm not found in PATH" >&2; exit 1; };
pnpm install
pnpm exec playwright install chromium;
`;

const setupPath = path.join(outdir, "setup");
await writeFile(setupPath, setup);
await chmod(setupPath, 0o755);

if (watch) {
  const ctx = await context(options());
  await ctx.watch();
  console.log(`watching src-ts into ${outdir}`);
} else {
  await build(options());
  await stampVersion();
}
