// Builds the TypeScript exporter into a single ESM bundle, the shape
// `exporter/scripts/build` already ships for the CLJS tree: `target-ts/app.js`
// plus the wasm artifacts and the package files the runtime installs from.
//
// `target-ts` rather than `target` so both trees can be built side by side
// while the switch is being validated.

import { build } from "esbuild";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const outdir = process.env.PENPOT_EXPORTER_OUTDIR ?? "target-ts";
const version = process.argv[2] ?? process.env.PENPOT_VERSION;

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

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: ["src-ts/app/app.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: path.join(outdir, "app.js"),
  sourcemap: true,
});

// The bundle keeps `%version%` until the build stamps it, as the CLJS build
// did with sed.
if (version !== undefined) {
  const file = path.join(outdir, "app.js");
  const code = await readFile(file, "utf8");
  await writeFile(file, code.replaceAll("%version%", version));
}

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

const setup = `#/usr/bin/env bash
set -e;
command -v pnpm >/dev/null || { echo "error: pnpm not found in PATH" >&2; exit 1; };
pnpm install
pnpm exec playwright install chromium;
`;

const setupPath = path.join(outdir, "setup");
await writeFile(setupPath, setup);
await chmod(setupPath, 0o755);