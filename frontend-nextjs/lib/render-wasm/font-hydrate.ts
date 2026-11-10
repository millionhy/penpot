// The text-font hydration for the wasm canvas (D11). The renderer draws a text
// shape only once the TTF bytes of the faces its content uses sit in the wasm
// font store; set_object carried the glyphs' text but never the bytes, so
// without this pass the canvas paints blanks.
//
// It mirrors lib/render-wasm/image-hydrate.ts (fetch once per shared id, store
// per use, a failing fetch only warns, never fails the caller) and replays the
// CLJS chain fonts.cljs/store-fonts -> store-font -> store-font-id -> fetch-font
// -> store-font-buffer -> force-update-text-layout, resolved through the pure
// half in lib/render-wasm/fonts.ts.
//
// Scope for this milestone: builtin faces resolve and store; custom faces store
// when the caller injects getCustomVariant (the team registry row carrying a
// ttf-file-id); google faces and faces with no bytes degrade to a no-op so the
// text stays blank rather than hanging the load — matching the documented
// deviation in fonts.ts.

import { config } from "@/lib/config";
import type { RendererApp } from "@/lib/render-wasm/interop";
import {
  fontFaceKey,
  getContentFonts,
  resolveFontFace,
  type CustomVariant,
  type FontFaceRef,
  type ResolveContext,
} from "@/lib/render-wasm/fonts";
import {
  forceUpdateTextLayout,
  isFontUploaded,
  storeFontFace,
} from "@/lib/render-wasm/fonts-store";

// The slice of a model shape this pass reads: a text shape's id and content.
// Kept structural so it accepts the store's WorkspaceShape without importing
// the model layer into render-wasm.
export interface TextBearingShape {
  readonly id: string;
  readonly type: string;
  readonly content?: unknown;
}

export interface FontHydrateOptions {
  // The origin font URLs resolve against; default config.publicUri ("" in dev,
  // where the /fonts and /assets Next rewrites proxy the frontend origin).
  publicUri?: string;
  // Injected for the tests; default is fetch + arrayBuffer.
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  // Resolve the custom-team registry row (its ttf-file-id) for a custom face.
  // Absent or undefined answers degrade that face like a missing asset.
  getCustomVariant?: (ref: FontFaceRef) => CustomVariant | undefined;
  // The load effect passes its mount guard so a disposed canvas stops halfway;
  // the text-commit path has none and leaves it undefined.
  isAlive?: () => boolean;
  onError?: (cause: unknown) => void;
}

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the font fetch answered ${response.status}`);
  }
  return response.arrayBuffer();
}

// The distinct faces used across the text shapes, each tagged with the shapes
// that consume it. One entry per fontFaceKey so a face shared by many shapes
// is fetched and stored once, but every shape still gets its layout re-run.
function collectFaceDemands(
  shapes: readonly TextBearingShape[],
): Map<string, { ref: FontFaceRef; shapeIds: Set<string> }> {
  const demands = new Map<string, { ref: FontFaceRef; shapeIds: Set<string> }>();
  for (const shape of shapes) {
    if (shape.type !== "text") continue;
    for (const ref of getContentFonts(shape.content)) {
      const key = fontFaceKey(ref);
      let demand = demands.get(key);
      if (demand === undefined) {
        demand = { ref, shapeIds: new Set<string>() };
        demands.set(key, demand);
      }
      demand.shapeIds.add(shape.id);
    }
  }
  return demands;
}

// Store the bytes for every face the text shapes need but the engine does not
// have yet, then re-run the layout of the shapes so the freshly-available faces
// are measured and painted. Safe to call on the whole model at load and on a
// single shape after a text commit.
export async function hydrateTextFonts(
  app: RendererApp,
  shapes: readonly TextBearingShape[],
  options: FontHydrateOptions = {},
): Promise<void> {
  const demands = collectFaceDemands(shapes);
  if (demands.size === 0) return;

  const publicUri = options.publicUri ?? config.publicUri;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const report = (cause: unknown): void => {
    if (options.onError !== undefined) options.onError(cause);
    else console.warn("[workspace] could not load a text font:", cause);
  };

  for (const { ref } of demands.values()) {
    const ctx: ResolveContext = {
      publicUri,
      customVariant: options.getCustomVariant?.(ref),
    };
    const outcome = resolveFontFace(ref, ctx);
    if (!outcome.ok) continue; // google / missing custom asset / unknown: degrade
    try {
      // isFontUploaded reads the internal module; a renderer that is present
      // but not fully initialised must degrade to a warning, not reject the
      // fire-and-forget hydrate promise, so it sits inside the guarded block.
      if (isFontUploaded(app, outcome.face)) continue; // engine already holds it
      const bytes = await fetchBytes(outcome.face.ttfUrl);
      // The fetch may outlive the canvas the load effect mounted.
      if (options.isAlive !== undefined && !options.isAlive()) return;
      storeFontFace(app, outcome.face, bytes);
    } catch (cause: unknown) {
      report(cause);
    }
  }

  // Re-run the layout whether or not a fetch stored bytes: a text commit that
  // only changed content (faces already uploaded) still needs relayout, and on
  // load the shapes were first painted blank. forceUpdateTextLayout is guarded
  // by wasm/live? so it no-ops on a not-ready renderer.
  if (options.isAlive !== undefined && !options.isAlive()) return;
  for (const { shapeIds } of demands.values()) {
    for (const id of shapeIds) forceUpdateTextLayout(app, id);
  }
}
