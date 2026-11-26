#!/usr/bin/env node
// Start the Next dev server against the backend-rust skeleton instead of the
// Clojure backend.
//
//   cargo run -p rpc          # backend-rust, 127.0.0.1:6061
//   pnpm dev:rust             # this script
//
// Both halves of the wiring must point at the same origin: PENPOT_BACKEND_ORIGIN
// drives the server-side /api rewrite, NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN drives
// the browser (WebSocket and any direct call). Assets stay on the penpot
// frontend nginx because the Rust skeleton serves no /assets, so
// PENPOT_ASSETS_ORIGIN defaults to the compose port unless the caller set it.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin = process.env.PENPOT_RUST_ORIGIN ?? "http://127.0.0.1:6061";
const port = process.env.PORT ?? "3450";

async function probe() {
  const url = new URL("/api/rpc/command/get-health", origin);
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
}

try {
  await probe();
} catch (error) {
  console.error(`backend-rust is not answering at ${origin}: ${error.message}`);
  console.error("Start it first: cd backend-rust && cargo run -p rpc");
  process.exit(1);
}

const env = {
  ...process.env,
  PENPOT_BACKEND_ORIGIN: origin,
  NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN: origin,
  PENPOT_ASSETS_ORIGIN: process.env.PENPOT_ASSETS_ORIGIN ?? "http://localhost:9001",
};

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "dev", "-p", port], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
