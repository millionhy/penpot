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
- From `exporter/`: `pnpm run check-fmt:clj` checks the CLJS fallback sources under `src/`; `pnpm run lint:clj` lints them.
- CI runs `pnpm run test:quiet` for this module (`mem:scripts/ci`).