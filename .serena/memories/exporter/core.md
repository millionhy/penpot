# Exporter Architecture and Workflow

`exporter/`: TypeScript/Node headless export service. Depends on `common/`; uses Playwright plus export JS deps for SVG/PDF/assets.

## Layout and commands

- Source: `exporter/src-ts/` (TypeScript; the CLJS tree and its shadow-cljs build were removed in G2.9); config: `package.json`, `tsconfig.json`, `vitest.config.ts`; runtime helpers/assets: `scripts/`.
- From `exporter/`: setup `./scripts/setup`; watch `pnpm run watch` or `pnpm run watch:app` (esbuild into `target/app.js`); production build `pnpm run build`; tests `pnpm run test` / `pnpm run test:quiet` / `pnpm run test:watch` (vitest over `src-ts/**/*.test.ts`). No CLJ lint or format step: the exporter owns no Clojure sources.
- Because exporter consumes `common/`, shared file/shape/model changes may need exporter verification even when the immediate change is not under `exporter/`.
- Cross-cutting testing principles and anti-patterns: `mem:testing`.
- Exporter test conventions and CI: `mem:exporter/testing`.

## HTTP and browser pool

- POST body limit is about 60 MB. Exporter supports `application/transit+json`; request params merge query params and body params.
- Map response bodies are Transit JSON and force HTTP 200; nil 200 bodies become 204.
- Auth token comes from cookie `auth-token`, then uploads use Bearer auth plus the management shared key.
- Each export job gets a fresh Playwright browser context. On success, the context closes and the browser returns to the pool; on error, the browser is destroyed instead of reused.
- Borrow validates browser connection. Pool acquire timeout is about 10s; font loading timeout logs a warning and continues after about 15s.

## Export batching and async behavior

- `prepare-exports` groups entries by `[scale type]` and partitions groups into chunks of 50. Each partition uses file/page/share/name from its first item, so be careful if entries might cross those boundaries.
- Single-export response is used only when multiple export is not forced and there is exactly one prepared export containing exactly one object.
- Multi-object export can run async: when `wait` is false it returns a resource immediately and publishes progress/end/error to Redis by profile topic; when `wait` is true it waits for upload and returns the uploaded resource.
- Frame export returns a resource immediately and publishes Redis updates; it does not follow the same `wait` option path.
- ZIP entry names are sanitized and duplicates receive numeric suffixes.

## Render details

- Bitmap export differs for WASM vs non-WASM render paths: WASM forces Playwright `deviceScaleFactor` to 1 and passes scale through the render URL; non-WASM uses `deviceScaleFactor = scale`.
- WebP is produced by taking a PNG screenshot and converting it with ImageMagick.
- SVG export rasterizes text foreignObjects to PNG, converts through PPM/color masks/potrace, and reassembles SVG paths. It also replaces non-breaking spaces for SVG compatibility and drops empty defs/paths.
- PDF export injects `@page` sizing through raw browser `evaluate` JavaScript; that code cannot rely on CLJS runtime helpers.
- Temporary resources schedule local deletion, then uploads POST to `/api/management/methods/upload-tempfile` with `X-Shared-Key: exporter <management-key>` and Bearer auth.

## Headless WASM path (TypeScript)

- `PENPOT_INTERNAL_URI` and `PENPOT_PUBLIC_URI` must point at the frontend nginx origin (devenv `http://localhost:9001`), not the backend (`:6060`). Fonts (`/internal/gfonts/font/*`, `/fonts/*`) and assets (`/assets/by-id/*`) are served by nginx; pointing at the backend still returns 200 but silently produces font-less SVG/PDF (no error in the job).
- wasm memory protocol: every consumer call (`_set_*_fill`, `_add_shape_stroke_fill`, ...) takes the whole `BUFFERU8` via `mem::bytes()`, so one allocation serves exactly one call. Incrementally built lists (stroke fills) need one `FILL_U8_SIZE` allocation per item, like `common/src/app/common/render_wasm/api/props.cljs`; packing several records into one block leaves the buffer `Some` and the next `_alloc_bytes` returns `[Critical] Bytes already allocated`, which aborts the worker (Rust panic that cannot unwind).
- A stroke without paint writes no fill record and allocates nothing; the renderer keeps its default.
- Page scenes arrive as tagged Transit records (`~#shape`, `~#matrix`, `~#point`, `~#rect`); `transit.ts` readers unwrap each tag to its plain map.
- Integration check against the local stack: build with `node esbuild.config.mjs`, run `target/app.js` with the nginx URIs, and export the `my board` frame (`file e5420a7e-43de-81e9-8008-f6ca99c229d1`, 750×485) as svg/png/pdf. Expected residual differences vs the CLJS product: fonts resolve to SourceSansPro + WorkSans only, PDF MediaBox uses points at 1:1, SVG emits fewer `g` wrappers, text rasterisation differs slightly.
