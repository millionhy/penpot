// app.wasm.pool: pool of headless render workers.
//
// Mirrors app.browser: a pool whose objects are `worker_threads` instead of
// browsers, so acquisition and eviction behave the same way for both render
// backends. A worker is expensive to build (it boots its own render-wasm
// module), hence the pooling.
//
// Acquisition is not capped by a timeout: the admission scheduler is the
// backpressure, and the idle watchdog guarantees a wedged worker gives its slot
// back. Workers run the same bundle as the main thread and branch on
// `isMainThread`.

import path from "node:path";
import { Worker } from "node:worker_threads";
import { get } from "../config.js";
import { AppError, raise } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import { decode, encode } from "../transit.js";

const log = createLogger("app.wasm.pool");
setLevel("app.wasm.pool", "info");

export const readyTimeoutMs = 60000;

export type WorkerListener = (...args: unknown[]) => void;

// The slice of node:worker_threads the pool uses. A plain object suffices in
// tests, and keeps the pool free of the concrete Worker type.
export interface WorkerPort {
  on(event: string, listener: WorkerListener): unknown;
  once(event: string, listener: WorkerListener): unknown;
  off(event: string, listener: WorkerListener): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number> | number | void;
  __id?: number;
  __alive?: boolean;
}

export type WorkerFactory = () => Promise<WorkerPort>;

export interface WorkerPoolOptions {
  max: number;
  min: number;
  testOnBorrow: boolean;
  evictionRunIntervalMillis: number;
  numTestsPerEvictionRun: number;
  idleTimeoutMillis: number;
}

export interface RenderOptions {
  "cancel-buffer"?: ArrayBufferLike;
  cancelled?: () => boolean;
}

interface Entry {
  worker: WorkerPort;
  id: number;
  idleSince: number;
}

interface Waiter {
  resolve(): void;
  reject(cause: unknown): void;
}

let nextWorkerId = 0;

function workerScript(): string {
  const script = process.argv[1];
  if (script === undefined) {
    return raise({
      type: "internal",
      code: "worker-not-ready",
      hint: "cannot resolve the render worker script",
    });
  }
  return path.resolve(script);
}

// Builds one worker and waits for its "ready" handshake. A worker that dies
// while booting fails its own creation; rejecting after resolve is a no-op, so
// the persistent error handler is safe for errors raised later.
export function createWorker(): Promise<WorkerPort> {
  const script = workerScript();

  return new Promise((resolve, reject) => {
    const id = (nextWorkerId += 1);
    const worker = new Worker(script) as unknown as WorkerPort;

    const timer = setTimeout(() => {
      log.error({ hint: "render worker did not become ready", "worker-id": id });
      void stopWorker(worker);
      reject(
        new AppError({
          type: "internal",
          code: "worker-not-ready",
          hint: "render worker did not become ready",
        }),
      );
    }, readyTimeoutMs);

    worker.__id = id;
    worker.__alive = true;

    worker.on("error", (cause) => {
      log.error({ hint: "render worker error", "worker-id": id, cause });
      worker.__alive = false;
      clearTimeout(timer);
      reject(cause);
    });

    worker.on("exit", (code) => {
      log.info({ hint: "render worker exited", "worker-id": id, code });
      worker.__alive = false;
    });

    // Not `once`: a stray message before the handshake would consume the
    // listener and leave the worker hanging until the ready timeout.
    const onReady: WorkerListener = (data) => {
      if (data !== null && typeof data === "object" && (data as { type?: unknown }).type === "ready") {
        clearTimeout(timer);
        worker.off("message", onReady);
        log.info({ origin: "factory", action: "create", "worker-id": id });
        resolve(worker);
      }
    };

    worker.on("message", onReady);
  });
}

function stopWorker(worker: WorkerPort): Promise<unknown> {
  worker.__alive = false;
  return Promise.resolve(worker.terminate()).catch((cause) => {
    log.warn({ hint: "unable to terminate the render worker", cause });
  });
}

// How long a render may go silent before the worker is presumed wedged. Reset
// on every message, so a long export keeps its worker as long as it keeps
// reporting objects; only a thread stuck inside Skia runs it out.
function idleTimeoutMs(): number {
  return 1000 * get("wasm-worker-idle-timeout", 300);
}

export class WorkerPool {
  private readonly factory: WorkerFactory;
  private readonly options: WorkerPoolOptions;
  private readonly idle: Entry[] = [];
  private readonly busy = new Set<Entry>();
  private waiters: Waiter[] = [];
  private creating = 0;
  private drained = false;
  private evictor: NodeJS.Timeout | undefined;

  constructor(factory: WorkerFactory, options: WorkerPoolOptions) {
    this.factory = factory;
    this.options = options;

    this.evictor = setInterval(() => this.evict(), options.evictionRunIntervalMillis);
    // The http server keeps the process alive; a maintenance timer must not.
    this.evictor.unref();

    void this.warm();
  }

  private warm(): Promise<void> {
    return this.fill().catch((cause) => {
      log.warn({ hint: "unable to prewarm the render worker pool", cause });
    });
  }

  private async fill(): Promise<void> {
    while (!this.drained && this.size() < this.options.min) {
      this.creating += 1;
      try {
        const entry = await this.spawn();
        if (this.drained) {
          await this.close(entry);
          return;
        }
        entry.idleSince = Date.now();
        this.idle.push(entry);
      } finally {
        this.creating -= 1;
      }
    }
  }

  private size(): number {
    return this.idle.length + this.busy.size + this.creating;
  }

  private async spawn(): Promise<Entry> {
    const worker = await this.factory();
    const id = worker.__id ?? (nextWorkerId += 1);
    worker.__id = id;
    if (worker.__alive === undefined) worker.__alive = true;
    return { worker, id, idleSince: 0 };
  }

  private async close(entry: Entry): Promise<void> {
    log.info({ origin: "factory", action: "destroy", "worker-id": entry.id });
    await stopWorker(entry.worker);
  }

  private takeIdle(): Entry | undefined {
    while (this.idle.length > 0) {
      const entry = this.idle.pop() as Entry;
      if (!this.options.testOnBorrow) return entry;
      log.info({ origin: "factory", action: "validate", "worker-id": entry.id });
      if (entry.worker.__alive === true) return entry;
      void this.close(entry);
      this.wake();
    }
    return undefined;
  }

  private waitForSlot(): Promise<void> {
    if (this.drained) {
      return Promise.reject(
        new AppError({
          type: "internal",
          code: "worker-not-ready",
          hint: "render worker pool is draining",
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private wake(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve();
  }

  async acquire(): Promise<WorkerPort> {
    for (;;) {
      if (this.drained) {
        return raise({
          type: "internal",
          code: "worker-not-ready",
          hint: "render worker pool is draining",
        });
      }

      const idle = this.takeIdle();
      if (idle !== undefined) {
        this.busy.add(idle);
        return idle.worker;
      }

      if (this.size() < this.options.max) {
        this.creating += 1;
        try {
          const entry = await this.spawn();
          this.busy.add(entry);
          return entry.worker;
        } finally {
          this.creating -= 1;
          this.wake();
        }
      }

      await this.waitForSlot();
    }
  }

  private entryOf(worker: WorkerPort): Entry | undefined {
    for (const entry of this.busy) if (entry.worker === worker) return entry;
    for (const entry of this.idle) if (entry.worker === worker) return entry;
    return undefined;
  }

  release(worker: WorkerPort): void {
    const entry = this.entryOf(worker);
    if (entry === undefined || !this.busy.has(entry)) return;

    this.busy.delete(entry);
    entry.idleSince = Date.now();
    this.idle.push(entry);
    this.wake();
  }

  async destroy(worker: WorkerPort): Promise<void> {
    const entry = this.entryOf(worker);
    if (entry === undefined) return;

    this.busy.delete(entry);
    const position = this.idle.indexOf(entry);
    if (position >= 0) this.idle.splice(position, 1);
    await this.close(entry);
    this.wake();
  }

  private evict(): void {
    const now = Date.now();
    let tested = 0;
    let removed = 0;

    for (let index = this.idle.length - 1; index >= 0; index -= 1) {
      if (tested >= this.options.numTestsPerEvictionRun) break;
      if (removed >= this.options.numTestsPerEvictionRun) break;
      tested += 1;

      const entry = this.idle[index];
      if (now - entry.idleSince < this.options.idleTimeoutMillis) continue;
      if (this.size() - 1 < this.options.min) break;

      this.idle.splice(index, 1);
      removed += 1;
      void this.close(entry);
    }

    if (removed > 0) this.wake();
    void this.warm();
  }

  // drain: stop handing out workers and let the borrowed ones come back.
  async drain(): Promise<void> {
    this.drained = true;
    if (this.evictor !== undefined) clearInterval(this.evictor);

    const cause = new AppError({
      type: "internal",
      code: "worker-not-ready",
      hint: "render worker pool is draining",
    });
    for (const waiter of this.waiters) waiter.reject(cause);
    this.waiters = [];

    while (this.busy.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async clear(): Promise<void> {
    const entries = this.idle.splice(0);
    await Promise.all(entries.map((entry) => this.close(entry)));
  }

  // Acquires one worker for the whole of `f`. A failure destroys the worker:
  // the module may be aborted or mid-write, and a terminated worker cannot be
  // reused.
  async withWorker<T>(f: (worker: WorkerPort) => Promise<T>): Promise<T> {
    const worker = await this.acquire();

    try {
      const result = await f(worker);
      this.release(worker);
      return result;
    } catch (cause) {
      await this.destroy(worker);
      throw cause;
    }
  }
}

// Settles when the worker reports the render finished, failed, or the thread
// went away. The last case matters: a terminated worker (how a cancel stops a
// render mid-Skia) emits `exit` and never `error`, and a promise left pending
// there would keep its pool slot borrowed for the life of the process.
function runOnWorker(
  worker: WorkerPort,
  params: unknown,
  cancelBuffer: ArrayBufferLike | undefined,
  onObject: (object: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const disarm = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const cleanup = () => {
      disarm();
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };

    const fail = (cause: unknown) => settle(() => reject(cause));

    const rearm = () => {
      disarm();
      timer = setTimeout(() => {
        log.error({ hint: "render worker went silent, terminating", "worker-id": worker.__id });
        void stopWorker(worker);
        fail(
          new AppError({
            type: "internal",
            code: "render-timeout",
            hint: "render worker stopped responding",
          }),
        );
      }, idleTimeoutMs());
    };

    const onError: WorkerListener = (cause) => fail(cause);

    const onExit: WorkerListener = (code) => {
      fail(
        new AppError({
          type: "internal",
          code: "worker-exited",
          hint: `render worker exited with code ${String(code)}`,
        }),
      );
    };

    const onMessage: WorkerListener = (data) => {
      rearm();

      const message = (data ?? {}) as {
        type?: string;
        payload?: unknown;
        code?: string;
        message?: string;
      };

      switch (message.type) {
        case "object":
          // A failure while the main thread handles the object (moving the
          // file, appending to the zip) has to end the render too, or nothing
          // ever settles this promise.
          try {
            onObject(decode(message.payload as string));
          } catch (cause) {
            fail(cause);
          }
          return;
        case "done":
          settle(resolve);
          return;
        case "error":
          fail(
            new AppError({
              type: "internal",
              code: message.code ?? "wasm-render-error",
              hint: message.message,
            }),
          );
          return;
        default:
      }
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    rearm();
    worker.postMessage({ type: "render", params: encode(params), cancel: cancelBuffer });
  });
}

export function renderOn(
  worker: WorkerPort,
  params: unknown,
  onObject: (object: unknown) => void,
  options: RenderOptions = {},
): Promise<void> {
  if (options.cancelled?.() === true) {
    return Promise.reject(
      new AppError({
        type: "internal",
        code: "job-cancelled",
        hint: "export job was cancelled",
      }),
    );
  }

  return runOnWorker(worker, params, options["cancel-buffer"], onObject);
}

export function terminate(worker: WorkerPort | undefined): void {
  if (worker !== undefined) void stopWorker(worker);
}

let pool: WorkerPool | undefined;
let factory: WorkerFactory = createWorker;

export function setWorkerFactory(next: WorkerFactory | undefined): void {
  factory = next ?? createWorker;
}

export function setPool(next: WorkerPool | undefined): void {
  pool = next;
}

export function currentPool(): WorkerPool | undefined {
  return pool;
}

// How many renders can run at once, and so how many headless jobs the
// scheduler may admit. Clamped rather than rejected: a bad value should not
// stop the exporter from booting, and a headless render has no other backend.
export function capacity(): number {
  return Math.max(1, get("wasm-worker-pool-max", 2));
}

export function defaultOptions(): WorkerPoolOptions {
  const configured = get("wasm-worker-pool-max", 2);
  const max = Math.max(1, configured);

  return {
    max,
    min: Math.min(max, get("wasm-worker-pool-min", 1)),
    testOnBorrow: true,
    evictionRunIntervalMillis: 30000,
    numTestsPerEvictionRun: 2,
    idleTimeoutMillis: 300000,
  };
}

export function init(): void {
  const options = defaultOptions();
  const configured = get("wasm-worker-pool-max", 2);

  if (configured !== options.max) {
    log.warn({ hint: "wasm-worker-pool-max raised to the minimum of one", configured });
  }

  log.info({ hint: "initializing render worker pool", opts: options });
  pool = new WorkerPool(factory, options);
}

export async function stop(): Promise<void> {
  if (pool === undefined) return;

  log.info({ hint: "finalizing render worker pool" });
  const current = pool;
  pool = undefined;
  await current.drain();
  await current.clear();
}

// Acquires one worker for the whole of `f`, a fn of that worker.
export function withWorker<T>(f: (worker: WorkerPort) => Promise<T>): Promise<T> {
  if (pool === undefined) {
    return Promise.reject(
      new AppError({
        type: "internal",
        code: "worker-not-ready",
        hint: "render worker pool is not initialized",
      }),
    );
  }
  return pool.withWorker(f);
}
