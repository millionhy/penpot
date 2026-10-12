// One-shot frame-to-bitmap render: the shell-side rebuild of the compiled
// frontend's app.main.render-viewer-wasm/render-to-canvas. Closure inlined
// that whole namespace (nothing of it lands on $APP, verified against the
// compiled artifact and at runtime), so this drives the same flow through
// the public app.render-wasm.api primitives, in the same order the compiled
// code runs them:
//
//   init-canvas-context(offscreen) → initialize-viewport(force-sync,
//   on-render) → [on-render] wasm UI overlay off → render-sync-shape
//   (the actual final render) → blit through createImageBitmap →
//   clear-canvas
//
// Differences from the compiled original, documented:
// - The original serializes one-shot renders through enqueue-wasm-render!
//   (a promise chain over @wasm-render-queue). The module-level chain below
//   does the same; a failed link never blocks the next one.
// - The original also flips wasm/disable-request-render? around the pass;
//   that atom is closure-private. The pass is short and the viewport holds
//   no render loop while it runs (it rebuilds on the completion event).
// - The original resets viewer-snapshot (the reusable offscreen canvas of
//   the workspace thumbnails). The shell never fills that snapshot, so
//   there is nothing to reset.
// - The original blits via draw-bitmap! (createImageBitmap + rAF, because
//   Firefox+NVIDIA cannot drawImage a managed OffscreenCanvas directly);
//   the same steps live in drawBitmap below, including the
//   "#screenshot-<id>" marker the CLJS original sets on the canvas.

import { arrayMap, call, keyword, KEY, type RendererApp } from "./interop";

// The four big-endian u32 words of a uuid string, the shape the wasm ABI
// takes. Mirrors uuid/get-u32 (getUnsignedParts in
// common/src/app/common/uuid_impl.js): every 8 hex digits of the
// dashless string read as one big-endian u32.
export function uuidToU32(id: string): [number, number, number, number] {
  const hex = id.replace(/-/g, "");
  return [
    Number.parseInt(hex.slice(0, 8), 16),
    Number.parseInt(hex.slice(8, 16), 16),
    Number.parseInt(hex.slice(16, 24), 16),
    Number.parseInt(hex.slice(24, 32), 16),
  ];
}

// enqueue-wasm-render!: a new one-shot render starts only when the previous
// finished. The chain itself never stays rejected.
let queue: Promise<unknown> = Promise.resolve();

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

// render-sync-shape (app.render-wasm.api): push the final render of `id`
// synchronously, so the offscreen canvas holds the frame when the blit
// reads it. This is the step that actually paints the one-shot pass — the
// initialize-viewport render-callback contract expects the caller to
// render (without a callback the compiler falls back to request-render).
function renderSyncShape(app: RendererApp, id: string): void {
  const [a, b, c, d] = uuidToU32(id);
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._render_sync_shape(a, b, c, d);
  // The compiled render-sync-shape ends with set! wasm/internal-frame-id
  // nil; every access to that var compiles to a $APP property read/write,
  // so the assignment here is the exact equivalent.
  app[KEY.internalFrameId] = null;
}

// draw-bitmap!: GPU-side blit of the offscreen canvas through an
// ImageBitmap (correct orientation, no CPU readback) plus the canvas id
// the handlers look for.
async function drawBitmap(
  canvas: HTMLCanvasElement,
  osCanvas: OffscreenCanvas,
  id: string,
  width: number,
  height: number,
): Promise<void> {
  const bitmap = await createImageBitmap(osCanvas);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, width, height);
      ctx?.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      canvas.id = `screenshot-${id}`;
      resolve();
    });
  });
}

async function renderFrame(
  app: RendererApp,
  objects: unknown,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: { x: number; y: number },
  scale: number,
): Promise<void> {
  const width = canvas.width;
  const height = canvas.height;
  const osCanvas = new OffscreenCanvas(width, height);
  if (!call(app, KEY.initCanvasContext, osCanvas)) {
    throw new Error("render-wasm: frame render could not create a GL context");
  }

  await new Promise<void>((resolve, reject) => {
    // on-render fires exactly once (set-objects-sync's process-pending
    // completion callback); the latch guards a double fire all the same.
    let fired = false;
    const onRender = (): void => {
      if (fired) return;
      fired = true;
      void (async () => {
        try {
          call(app, KEY.setRulersFrameVisible, false);
          call(app, KEY.setRulersVisible, false);
          renderSyncShape(app, frameId);
          await drawBitmap(canvas, osCanvas, frameId, width, height);
          // The compiled pass ends with clear-canvas (context kept:
          // lose-browser-context? false), handing the shared wasm runtime
          // back; the viewport rebuilds on the completion event.
          call(
            app,
            KEY.clearCanvas,
            arrayMap(app, [[keyword(app, "lose-browser-context?"), false]]),
          );
          resolve();
        } catch (cause) {
          reject(cause);
        }
      })();
    };

    // initialize-viewport reads only :x/:y from the bounds (the padded
    // origin lands in _set_view).
    const bounds = arrayMap(app, [
      [keyword(app, "x"), origin.x],
      [keyword(app, "y"), origin.y],
    ]);
    call(
      app,
      KEY.initializeViewport,
      objects,
      scale,
      bounds,
      arrayMap(app, [
        [keyword(app, "background-opacity"), 0],
        [keyword(app, "force-sync"), true],
        [keyword(app, "on-render"), onRender],
      ]),
    );
  });
}

// The one-shot wasm render of a frame into `canvas` (whose physical size
// the caller must set first). Serialized globally; resolves once the
// bitmap landed and the shared context was torn down.
export function renderFrameToCanvas(
  app: RendererApp,
  objects: unknown,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: { x: number; y: number },
  scale: number,
): Promise<void> {
  return enqueueRender(() => renderFrame(app, objects, frameId, canvas, origin, scale));
}
