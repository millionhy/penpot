// The global offscreen render queue and the offscreen-to-visible blit.
//
// Both pieces started in pass-common.ts, which the $APP paths (the workspace
// and the thumbnail worker) still use. They hold no $APP reference, and the
// engine paths (the viewer and the one-shot frame render) import them from
// here, so the engine never pulls the compiled-runtime helpers in.
//
// The queue is one process-wide chain: every pass, whichever runtime drives
// it, holds the single wasm GL context, so two passes must never interleave.

// enqueue-wasm-render!: one offscreen render starts only when the previous
// finished. The chain itself never stays rejected.
let queue: Promise<unknown> = Promise.resolve();

export function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

// draw-bitmap!: GPU-side blit of the offscreen canvas through an
// ImageBitmap (correct orientation, no CPU readback) plus the canvas id
// the handlers look for. `finish` always runs, also when the blit fails —
// the compiled original catches and continues in a scheduled task, the
// port reports the failure instead of raising.
export async function drawBitmap(
  canvas: HTMLCanvasElement,
  osCanvas: OffscreenCanvas,
  id: string,
  width: number,
  height: number,
  finish: () => void,
): Promise<void> {
  try {
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
    finish();
  } catch (cause) {
    // Match the compiled catch: the pass completes, the error is reported.
    console.error("[render-wasm] viewer canvas blit failed:", cause);
    finish();
  }
}
