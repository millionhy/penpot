# Frontend Next.js (Strangler Shell)

`frontend-nextjs/`: Next.js 15 app that replaces `frontend/` route by route. Talks to the Clojure backend over Transit RPC; never modify `backend/` for it.

## Layout and commands

- `app/` routes and views, `components/` UI, `lib/` headless logic (no JSX, so vitest runs in a plain node environment), `lib/render-wasm/` renderer bridge and TS ports, `packages/api-types/` generated contract types.
- From `frontend-nextjs/`: `pnpm dev` (port 3450), `pnpm test` (vitest, `lib/**/*.test.ts`), `pnpm typecheck`, `pnpm build`.
- Tests are node-env: anything that needs a DOM or WebGL is verified in a browser against a running backend, not in vitest.
- Cross-cutting testing principles: `mem:testing`.

## Canvas runtime

- The canvas, viewer and dashboard thumbnails still run on the compiled ClojureScript in `public/js/main.js` + `shared.js` (not committed; built by the `frontend/` container). `lib/render-wasm/bridge.ts` loads both with `webpackIgnore` after defining `shadow$bridge`, `dynamicImport`, the version globals and hidden `#app`/`#modal` hosts.
- `$APP` is the compiled namespace object; `lib/render-wasm/interop.ts` holds the munged `KEY` table and the CLJS calling conventions (multi-arity extraction, PersistentArrayMap, uuid words). Do not "fix" the `$0` segments in keys.
- `lib/render-wasm/engine/` (G4) is the TypeScript replacement for `app.render-wasm.api` and `common.render-wasm`: `loadModule` owns the one artifact instance (256 MB heap, never two), `call` maps `_read_error_code` 1/2 to `wasm-non-blocking`/`wasm-panic`, `enums.ts` inlines the serializer discriminants.
- The artifact is built with `-sENVIRONMENT=web,worker,node`, so node tests may instantiate it and call `_init_headless`; the browser path uses `_init` with a GL canvas.
- `engine/canvas.ts` owns the GL session (`currentCanvasContext`): `initCanvasContext` registers the emscripten context, runs `_init`/`_set_render_options`/route params/`_set_browser`, marks the engine live and syncs the size; `clearCanvas` frees GPU objects, runs `_clean_up`, loses/deletes the context, resets state and never throws. Context loss only marks the engine lost and calls `onContextLost`; recovery is the app's job.
- Guards are part of the port: `live()` for reload-internal calls (`resize-viewbox`, render options, rulers, background) and `ready()` for application-driven ones (`set-view-box`, `set-viewer-viewport!`, `view-interaction-*`).
- `engine/render-loop.ts` (`RenderLoop`) holds the render state: one pending rAF, a monotonic seq that invalidates queued frames, partial/viewport-ready continuation, 100 ms `render-finish` debounce, `SYNC-TILES` on interaction end, and the page-transition freeze with a dirty flag. `requestRender` uses `live()`; `setViewBox` uses `ready()`.
- `initializeViewport` takes `setObjects` as a callback: the upload slice plugs in without changing the call order (stop → background → `_set_view` → `_init_shapes_pool` → upload).
- `engine/colors.ts` `hexToArgbU32` expands 3/4-digit shorthand and returns unsigned ARGB; the compiled helper reads `#fff` as `0x00000FFF`.
- Slices must not run the CLJS module and the TS engine at the same time: switch a whole subsystem, then remove the old calls.

## Porting rules

- Port by subsystem from `frontend/src/app/render_wasm/api.cljs`, keeping the original call order; delete the `.cljs` once the TS path replaces it.
- The exporter already ported the same portable layer under `exporter/src-ts/app/wasm/`; use it as reference (node-oriented, `.js` import specifiers), but keep this module's port separate.
