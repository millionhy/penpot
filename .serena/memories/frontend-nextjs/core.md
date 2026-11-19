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
- `engine/upload.ts` + `engine/objects.ts` own the shape upload: 104-byte base props, a section mask, then `[u32 payload_len][payload]` records in one `_set_shapes_batch` per chunk (Rust takes the buffer, never free it). FLEX must be written before LAYOUT-ITEM. `setObjects` walks zero-uuid root (else parent-not-in-map tops), uploads sync below 100 shapes or 512-shape chunks with yields on the async path, and drives `beginShapesLoading`/`_begin_loading` … `_end_loading`/`_set_view_end`/`resetViewInteraction`/`requestRender("set-objects-complete")`. The svg-attr and path/bool-content tail goes through `_use_shape`; `serializeShape`/`serializeShapesBatch` run `applySvgDerived` first and return the derived copy.
- `engine/fills.ts` record sizes: solid 4, gradient 156, image 36, fill 160, stroke header 36. `_add_shape_*_stroke` does NOT consume the pending allocation (only `_add_shape_stroke_fill` does), so a stroke without paint must call `_free_bytes`; the CLJS original leaked it.
- `engine/text.ts`: paragraph record `[u32 span_count][12B attrs][64B span + 8×160B fills][utf8]`; `setShapeTextContent` clears, sets the vertical align, stores fonts through `prepareFonts`, writes the paragraphs and calls `_update_shape_text_layout`. `engine/fonts.ts` maps `gfont-`/`custom-` ids to uuids and owns `storeFont`/`storeFontUrl`/`isFontUploaded`/`updateTextLayout`.
- `engine/svg.ts` + `engine/svg-derived.ts`: matrix/transform/style/color helpers; defs lookup, linear/radial gradients, blur and drop shadow. `applySvgDerived` runs the filters first, then resolves the fills, and never touches the renderer.
- `engine/layouts.ts`: flex data 12 args, grid data 11, tracks 8 bytes, cells 40. An empty track/cell list still calls its setter (Rust reads zero entries); `setShapeLayout` clears first, then writes flex or grid.
- `engine/image.ts` + `engine/host.ts`: image header 36 bytes (`shape uuid | image uuid | thumbnail u32 | bytes`), `loadImage` registers the url, skips the fetch on a cache hit and never rejects. `writeHostAttrs` replays `set-object-host-attrs` and returns the thumbnail/full promises plus the font handle; `skipLayout`/`skipFillsStrokes` avoid the double write after a cold batch.
- `engine/modifiers.ts`: modifier entries 40 bytes, structure and propagate inputs 44, propagate output `count + 10×u32` freed after reading. All entry points guard on `ready()`; only `setModifiers` requests the render. An unknown structure modifier type throws instead of letting the Rust `unreachable!` trap.
- `engine/colors.ts` `hexToArgbU32` expands 3/4-digit shorthand and returns unsigned ARGB; the compiled helper reads `#fff` as `0x00000FFF`.
- Slices must not run the CLJS module and the TS engine at the same time: switch a whole subsystem, then remove the old calls.

## Porting rules

- Port by subsystem from `frontend/src/app/render_wasm/api.cljs`, keeping the original call order; delete the `.cljs` once the TS path replaces it.
- The exporter already ported the same portable layer under `exporter/src-ts/app/wasm/`; use it as reference (node-oriented, `.js` import specifiers), but keep this module's port separate.
