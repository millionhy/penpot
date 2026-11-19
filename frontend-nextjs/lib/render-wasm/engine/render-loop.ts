// The render loop of app.render-wasm.api (G4.2): request-render, the
// progressive frame continuation, the shapes-loading deferral and the
// view-interaction bookkeeping that set-view-box drives.
//
// This is the piece with the most state, so it is a class instead of the
// scattered defonce atoms of the compiled original: pending, frame id, frame
// type, seq, shapes-loading, deferred, preserve-target and the interaction
// flag all move together and the class makes their transitions explicit.
//
// Ported invariants worth keeping in mind:
// - `requestRender` uses `live?`, not `ready?`: reload-internal renders must
//   run while `reloading?` still blocks application mutations.
// - Each scheduled frame captures the seq. `stopProgressiveRender` bumps it
//   so an already-queued rAF becomes a no-op; cancelling the handle alone is
//   not enough because the running `_render` can schedule its own follow-up
//   after the cancel.
// - `_render` answers the frame type; partial and viewport-ready mean the
//   tile pass has more work and the loop asks for another frame.
// - `setViewBox` freezes during a page transition (the tile atlas is
//   incomplete then) and records that the viewport is dirty instead.
//
// Deviation: a failing render is reported through `onError` instead of being
// rethrown into the rAF callback, where nothing could catch it.

import { call } from "./call";
import type { RenderWasmModule } from "./module";
import type { Point } from "./viewport";

// The pipeline frame types. NONE must never leak out of `_render`.
export const FRAME_TYPE = {
  none: 0,
  partial: 1,
  full: 2,
  viewportReady: 3,
} as const;

export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

// Rebuild the tile index without ending fast mode (pan/zoom pause).
export const RENDER_FLAG_SYNC_TILES = 4;

// debounce delay of `render-finish`.
export const RENDER_DEBOUNCE_MS = 100;

// Threshold below which the compiled renderer processes synchronously.
export const ASYNC_THRESHOLD = 100;

export interface RenderLoopHost {
  // The module is read lazily: a reload swaps the instance under the loop.
  module: () => RenderWasmModule | undefined;
  live: () => boolean;
  // `initialized?` of the compiled API (`ready?`). Defaults to `live`.
  ready?: () => boolean;
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancelScheduled?: (handle: number) => void;
  isPageTransition?: () => boolean;
  isGestureActive?: () => boolean;
  // `penpot:wasm:render`, dispatched after every frame.
  onRender?: (timestamp: number) => void;
  onError?: (cause: unknown) => void;
}

function defaultRequestFrame(callback: (timestamp: number) => void): number {
  return globalThis.requestAnimationFrame(callback);
}

function defaultCancelFrame(id: number): void {
  globalThis.cancelAnimationFrame(id);
}

function defaultSchedule(callback: () => void, delayMs: number): number {
  return globalThis.setTimeout(callback, delayMs) as unknown as number;
}

function defaultCancelScheduled(handle: number): void {
  globalThis.clearTimeout(handle);
}

export class RenderLoop {
  private readonly host: RenderLoopHost;

  private frameTypeValue: FrameType = FRAME_TYPE.none;
  private frameIdValue: number | undefined;
  private pendingValue = false;
  private shapesLoadingValue = false;
  private deferredValue = false;
  private preserveTargetValue = false;
  private disabledValue = false;
  private interactionActive = false;
  private viewportDirty = false;
  private seq = 0;
  private finishHandle: number | undefined;

  constructor(host: RenderLoopHost) {
    this.host = host;
  }

  // --- State (the compiled defonce atoms)

  get frameType(): FrameType {
    return this.frameTypeValue;
  }

  get frameId(): number | undefined {
    return this.frameIdValue;
  }

  isPending(): boolean {
    return this.pendingValue;
  }

  isShapesLoading(): boolean {
    return this.shapesLoadingValue;
  }

  isRenderDeferred(): boolean {
    return this.deferredValue;
  }

  isViewInteractionActive(): boolean {
    return this.interactionActive;
  }

  isViewportDirtyDuringTransition(): boolean {
    return this.viewportDirty;
  }

  // `wasm/disable-request-render?`: the compiled viewer and one-shot passes
  // flip it while they own the context.
  setDisableRequestRender(value: boolean): void {
    this.disabledValue = value;
  }

  private isReady(): boolean {
    return (this.host.ready ?? this.host.live)();
  }

  private now(): number {
    return (this.host.now ?? (() => globalThis.performance.now()))();
  }

  private module(): RenderWasmModule | undefined {
    return this.host.module();
  }

  needsMoreFrames(): boolean {
    return (
      this.frameTypeValue === FRAME_TYPE.partial ||
      this.frameTypeValue === FRAME_TYPE.viewportReady
    );
  }

  // --- Rendering

  // `internal-render`: one frame plus the follow-up request when the tile
  // pass is still partial. `flags` defaults to the current frame type, which
  // is what the no-argument arity does.
  render(timestamp: number, flags: number = this.frameTypeValue): boolean {
    if (!this.host.live()) return false;
    const module = this.module();
    if (module === undefined) return false;

    let effectiveFlags = flags;
    if (this.preserveTargetValue) {
      this.preserveTargetValue = false;
      effectiveFlags |= RENDER_FLAG_SYNC_TILES;
    }

    this.frameTypeValue = normalizeFrameType(call(module, "_render", timestamp, effectiveFlags));

    if (this.needsMoreFrames()) {
      this.requestRender("frame-type-partial");
    }

    this.host.onRender?.(timestamp);
    return true;
  }

  // render-sync / render-sync-shape / ...: the explicit, single-shot
  // counterparts. They always clear the scheduled frame handle, like the
  // compiled bodies do.
  renderSync(): boolean {
    if (!this.host.live()) return false;
    const module = this.module();
    if (module === undefined) return false;
    call(module, "_render_sync");
    this.frameIdValue = undefined;
    return true;
  }

  renderFromCache(): boolean {
    return this.invoke("_render_from_cache", 0);
  }

  renderFromBackbuffer(): boolean {
    return this.invoke("_render_from_backbuffer");
  }

  renderUiOnly(): boolean {
    return this.invoke("_render_ui_only");
  }

  renderPreview(): boolean {
    return this.invoke("_render_preview");
  }

  renderBlurredSnapshot(blurRadius: number): boolean {
    return this.invoke("_render_blurred_snapshot", blurRadius);
  }

  private invoke(name: string, ...args: unknown[]): boolean {
    if (!this.host.live()) return false;
    const module = this.module();
    if (module === undefined) return false;
    call(module, name, ...args);
    return true;
  }

  // --- request-render

  requestRender(_requester: string): boolean {
    if (!this.host.live() || this.disabledValue) return false;

    if (this.shapesLoadingValue) {
      this.deferredValue = true;
      return false;
    }

    if (this.pendingValue) return false;

    const module = this.module();
    if (module === undefined) return false;

    this.pendingValue = true;
    const seq = this.seq;
    const requestFrame = this.host.requestFrame ?? defaultRequestFrame;

    const frameId = requestFrame((timestamp) => {
      // Dropped if stopProgressiveRender ran since this was scheduled.
      if (seq !== this.seq) return;
      this.pendingValue = false;
      this.frameIdValue = undefined;
      try {
        this.render(timestamp);
      } catch (cause) {
        this.host.onError?.(cause);
      }
    });

    this.frameIdValue = frameId;
    return true;
  }

  // request-render-preserving-target: keep the previously presented frame on
  // screen while the new tiles are rasterized. The flag is one-shot: the next
  // frame consumes it and hands it to WASM as SYNC-TILES.
  requestRenderPreservingTarget(requester: string): boolean {
    this.preserveTargetValue = true;
    return this.requestRender(requester);
  }

  // Stop the pending tile pass and invalidate any follow-up it may schedule.
  stopProgressiveRender(): void {
    this.seq += 1;
    if (this.frameIdValue !== undefined) {
      (this.host.cancelFrame ?? defaultCancelFrame)(this.frameIdValue);
      this.frameIdValue = undefined;
    }
    this.pendingValue = false;
    this.frameTypeValue = FRAME_TYPE.none;
  }

  // --- Shapes loading (set-objects)

  beginShapesLoading(): void {
    this.shapesLoadingValue = true;
    const wasPending = this.pendingValue;
    this.stopProgressiveRender();
    this.deferredValue = wasPending;
  }

  endShapesLoading(): void {
    const wasLoading = this.shapesLoadingValue;
    this.shapesLoadingValue = false;
    this.deferredValue = false;
    if (wasLoading) {
      this.requestRender("set-objects:flush");
    }
  }

  // --- View interaction

  viewInteractionStart(): boolean {
    if (!this.isReady()) return false;
    if (this.host.isPageTransition?.() === true) return false;
    if (this.interactionActive) return false;

    const module = this.module();
    if (module === undefined) return false;
    call(module, "_set_view_start");
    this.interactionActive = true;
    return true;
  }

  viewInteractionEnd(): boolean {
    if (!this.isReady() || !this.interactionActive) return false;
    const module = this.module();
    if (module === undefined) return false;

    call(module, "_set_view_end");
    this.interactionActive = false;
    return true;
  }

  // finalize-view-interaction!: end the gesture and render one full-quality
  // frame that preserves the presented target. Called on plain clicks too, so
  // the interaction flag is the guard: no gesture, no render.
  finalizeViewInteraction(): boolean {
    if (!this.interactionActive || !this.isReady()) return false;
    this.viewInteractionEnd();
    this.render(this.now(), RENDER_FLAG_SYNC_TILES);
    return true;
  }

  // set-view-box: push the transform, blit the cached atlas while the new
  // tiles render, then debounce the interaction end.
  setViewBox(zoom: number, vbox: Point): boolean {
    // Frozen during a page transition: the tile atlas is empty or incomplete
    // and the cache blit would present a blank workspace.
    if (this.host.isPageTransition?.() === true) {
      this.viewportDirty = true;
      return false;
    }
    if (!this.isReady()) return false;

    const module = this.module();
    if (module === undefined) return false;

    this.viewInteractionStart();
    call(module, "_set_view", zoom, -vbox.x, -vbox.y);
    call(module, "_render_from_cache", 0);
    this.renderFinish();
    return true;
  }

  // The page-transition end handler reads and clears the dirty marker.
  consumeViewportDirty(): boolean {
    const dirty = this.viewportDirty;
    this.viewportDirty = false;
    return dirty;
  }

  // render-finish: a pan/zoom gesture keeps the interaction open and only
  // rebuilds the tiles; otherwise the interaction is finalized.
  renderFinish(): void {
    this.cancelFinish();
    const schedule = this.host.schedule ?? defaultSchedule;
    this.finishHandle = schedule(() => {
      this.finishHandle = undefined;
      if (!this.host.live()) return;
      if (this.host.isGestureActive?.() === true) {
        this.render(this.now(), RENDER_FLAG_SYNC_TILES);
      } else {
        this.finalizeViewInteraction();
      }
    }, RENDER_DEBOUNCE_MS);
  }

  // Drop the loop's timers and pending frame. Used by clear-canvas and by
  // the owner's unmount path.
  dispose(): void {
    this.cancelFinish();
    this.stopProgressiveRender();
    this.interactionActive = false;
    this.shapesLoadingValue = false;
    this.deferredValue = false;
    this.preserveTargetValue = false;
  }

  private cancelFinish(): void {
    if (this.finishHandle !== undefined) {
      (this.host.cancelScheduled ?? defaultCancelScheduled)(this.finishHandle);
      this.finishHandle = undefined;
    }
  }
}

function normalizeFrameType(value: unknown): FrameType {
  return value === FRAME_TYPE.partial ||
    value === FRAME_TYPE.full ||
    value === FRAME_TYPE.viewportReady
    ? value
    : FRAME_TYPE.none;
}