// The workspace face of the engine's modifier protocol (G4.6b).
//
// The compiled canvas reached the set-modifiers / set-modifiers-start /
// set-modifiers-end / clean-modifiers entry points through the internal
// module because the `$APP` wrappers were inlined away. The engine exposes
// them as first-class functions, so this file only keeps the names and the
// reset sequence the gesture code already uses.
//
// The buffer discipline lives in `engine/modifiers.ts`: the whole override
// map travels in one allocation, `setModifiers` requests the render, and an
// empty set is a no-op rather than a clear (that is `cleanModifiers`).

import {
  cleanModifiers as cleanEngineModifiers,
  setModifiers,
  setModifiersEnd,
  setModifiersStart,
  type Matrix6,
} from "@/lib/render-wasm/engine";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

export type { Matrix6 };

// Enter interactive transform mode: fast mode plus the atlas backdrop, so
// tiles are not rasterized sequentially mid-gesture. Pairs with endModifiers;
// the CLJS toggles it once per gesture.
export function startModifiers(app: WorkspaceApp): void {
  setModifiersStart(app.module);
}

// Leave interactive transform mode. Any pending async render scheduled under
// it is cancelled; the caller triggers the full-quality render once the
// gesture ends (a geometry push or a plain request-render).
export function endModifiers(app: WorkspaceApp): void {
  setModifiersEnd(app.module);
}

// Drop every active modifier: the overrides stop applying and the shapes snap
// back to their base geometry in the next render. No render is requested here,
// mirroring app.render-wasm.api/clean-modifiers.
export function cleanModifiers(app: WorkspaceApp): void {
  cleanEngineModifiers(app.module);
}

// The cancellation path of a gesture (Escape, pointercancel, failed commit):
// end the interactive mode, drop the overrides and request the render that
// shows the base geometry again.
export function resetModifierPreview(app: WorkspaceApp): void {
  endModifiers(app);
  cleanModifiers(app);
  app.loop.requestRender("clean-modifiers");
}

// Push one preview frame: the per-shape transform overrides. `entries` maps
// shape id -> matrix and MUST be the whole move set (the wasm side replaces
// its modifier map). The engine requests the render.
export function configureModifiers(
  app: WorkspaceApp,
  entries: ReadonlyArray<readonly [string, Matrix6]>,
): void {
  setModifiers(app.module, entries, app.loop);
}
