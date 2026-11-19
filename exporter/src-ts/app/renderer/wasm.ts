// app.renderer.wasm: main-thread side of the headless renderer.
//
// Renders run on pooled workers because Skia calls are synchronous and would
// block the http server and other exports. Each job keeps one worker for all
// its renders, sharing its caches and pool slot.

import * as jobs from "../jobs.js";
import * as pool from "../wasm/pool.js";

export type OnObject = (object: unknown) => void;
export type RenderFn = (params: unknown, onObject: OnObject) => Promise<void>;

// Chains thunks so a job's renders run one at a time on its worker. A failure
// is isolated: it doesn't break the chain for the next one.
export function serializer(): <T>(thunk: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();

  return <T>(thunk: () => Promise<T>) => {
    const result = queue.then(thunk, thunk);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// Runs `f`, a fn of a 2-arg render fn. Every render goes to the same worker,
// one at a time, so the cancel check runs as each render's turn comes up.
export async function withScope<T>(
  jobId: string | undefined,
  f: (render: RenderFn) => Promise<T>,
): Promise<T> {
  return pool.withWorker(async (worker) => {
    const chain = serializer();
    let live: pool.WorkerPort | undefined = worker;
    const signal = jobId === undefined ? undefined : jobs.cancelSignal(jobId);

    const options: pool.RenderOptions = {
      "cancel-buffer": signal?.buffer,
      cancelled: jobId === undefined ? undefined : () => jobs.cancelled(jobId),
    };

    if (jobId !== undefined) {
      // Between objects the worker sees the flag; inside a render only
      // terminating the thread stops it. Cleared on the way out so a later
      // cancel cannot terminate a worker that is by then somebody else's.
      jobs.onCancel(jobId, () => pool.terminate(live));
    }

    try {
      return await f((params, onObject) =>
        chain(() => pool.renderOn(worker, params, onObject, options)),
      );
    } finally {
      live = undefined;
    }
  });
}

export function render(params: Record<string, unknown>, onObject: OnObject): Promise<void> {
  const jobId = params["job-id"];
  return withScope(typeof jobId === "string" ? jobId : undefined, (renderShape) =>
    renderShape(params, onObject),
  );
}
