# Exporter Testing

- READ `mem:testing` first.
- Tests use vitest and live beside the sources: `exporter/src-ts/app/**/*.test.ts`.
- The old CLJS suite (`exporter/test/`, `cljs.test`, `exporter-tests.runner`) was removed in G2.8; `build:test` and `scripts/test-quiet.js` are gone with it.
- From `exporter/`: `pnpm run test` runs the suite (`vitest run`).
- From `exporter/`: `pnpm run test:quiet` runs it with `--silent=passed-only`, hiding per-file lines.
- From `exporter/`: `pnpm run test:watch` stays in watch mode.
- Focus one file: `pnpm run test -- src-ts/app/core.test.ts`.
- Focus one test: `pnpm run test -- -t "boots the server in the CLJS order"`.
- Tests inject their own config and never touch redis, the browser pool or the wasm runtime; keep new tests on the same injected seams (`CoreDeps`, fakes) instead of real I/O.
- On a machine where `exporter/node_modules` is a junction to another workspace's `node_modules` (common local setup), `pnpm exec` and `pnpm run` fail the hoist self-check and may try to reinstall. Call the tools directly instead: `node node_modules/vitest/vitest.mjs run` and `node node_modules/typescript/bin/tsc -p tsconfig.json`.
- CI runs `pnpm run test:quiet` for this module (`mem:scripts/ci`).