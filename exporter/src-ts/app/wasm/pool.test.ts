// app.wasm.pool: the worker pool and the per-render protocol.

import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_WASM_WORKER_POOL_MIN = "0";

import { AppError } from "../errors.js";
import { decode, encode } from "../transit.js";
import { FakeWorker } from "../../test/fake-worker.js";
import {
  WorkerPool,
  capacity,
  currentPool,
  init,
  renderOn,
  setPool,
  setWorkerFactory,
  stop,
  terminate,
  withWorker,
  type WorkerFactory,
  type WorkerPort,
  type WorkerPoolOptions,
} from "./pool.js";

const pools: WorkerPool[] = [];

function makePool(factory: WorkerFactory, options: Partial<WorkerPoolOptions> = {}): WorkerPool {
  const pool = new WorkerPool(factory, {
    max: 2,
    min: 0,
    testOnBorrow: true,
    evictionRunIntervalMillis: 600000,
    numTestsPerEvictionRun: 2,
    idleTimeoutMillis: 600000,
    ...options,
  });
  pools.push(pool);
  return pool;
}

function factoryOf(): { created: FakeWorker[]; factory: WorkerFactory } {
  const created: FakeWorker[] = [];
  const factory = vi.fn(async () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker;
  });
  return { created, factory };
}

afterEach(async () => {
  vi.useRealTimers();
  setWorkerFactory(undefined);
  setPool(undefined);

  const pending = pools.splice(0);
  for (const pool of pending) {
    await pool.drain();
    await pool.clear();
  }
});

describe("acquire/release", () => {
  it("caps the workers at max and hands a released one to the waiter", async () => {
    const { created, factory } = factoryOf();
    const pool = makePool(factory, { max: 1 });

    const first = await pool.acquire();
    expect(created).toHaveLength(1);

    let handed: WorkerPort | undefined;
    const second = pool.acquire().then((worker) => {
      handed = worker;
      return worker;
    });
    await Promise.resolve();
    expect(handed).toBeUndefined();

    pool.release(first);
    const handedSecond = await second;
    expect(handedSecond).toBe(first);
    expect(created).toHaveLength(1);

    pool.release(handedSecond);
  });

  it("destroys a worker that failed validation on borrow", async () => {
    const { created, factory } = factoryOf();
    const pool = makePool(factory, { max: 1 });

    const first = await pool.acquire();
    pool.release(first);
    first.__alive = false;

    const second = await pool.acquire();

    expect(second).not.toBe(first);
    expect(created[0]).toBe(first);
    expect(created[0].terminations).toBe(1);
    expect(created).toHaveLength(2);

    pool.release(second);
  });
});

describe("withWorker", () => {
  it("releases the worker after a successful scope", async () => {
    const { created, factory } = factoryOf();
    const pool = makePool(factory, { max: 1 });

    const result = await pool.withWorker(async (worker) => {
      expect(worker).toBe(created[0]);
      return "done";
    });

    expect(result).toBe("done");
    expect(created[0].terminations).toBe(0);
    const borrowed = await pool.acquire();
    expect(borrowed).toBe(created[0]);
    pool.release(borrowed);
  });

  it("destroys the worker when the scope throws and rethrows", async () => {
    const { created, factory } = factoryOf();
    const pool = makePool(factory, { max: 1 });

    await expect(
      pool.withWorker(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(created[0].terminations).toBe(1);

    // The slot is free again: the next scope spawns a fresh worker.
    await pool.withWorker(async () => undefined);
    expect(created).toHaveLength(2);
  });
});

describe("renderOn", () => {
  it("posts the encoded render command and decodes the objects", async () => {
    const worker = new FakeWorker();
    const params = { "job-id": "j1", objects: [{ id: "a" }] };
    const onObject = vi.fn();

    const done = renderOn(worker, params, onObject);
    const command = worker.posted[0] as { type: string; params: string; cancel?: unknown };

    expect(command.type).toBe("render");
    expect(command.cancel).toBeUndefined();
    expect(decode(command.params)).toEqual(params);

    worker.emit("message", { type: "object", payload: encode({ id: "a'0" }) });
    expect(onObject).toHaveBeenCalledWith({ id: "a'0" });

    worker.emit("message", { type: "done" });
    await done;
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it("forwards the cancel buffer", async () => {
    const worker = new FakeWorker();
    const signal = new Int32Array(new SharedArrayBuffer(4));

    const done = renderOn(worker, {}, () => undefined, { "cancel-buffer": signal.buffer });
    expect((worker.posted[0] as { cancel?: unknown }).cancel).toBe(signal.buffer);

    worker.emit("message", { type: "done" });
    await done;
  });

  it("rejects a job that was cancelled before it started", async () => {
    const worker = new FakeWorker();

    await expect(renderOn(worker, {}, () => undefined, { cancelled: () => true })).rejects.toMatchObject({
      data: { code: "job-cancelled" },
    });
    expect(worker.posted).toEqual([]);
  });

  it("turns an error message into an AppError with the worker code", async () => {
    const worker = new FakeWorker();
    const done = renderOn(worker, {}, () => undefined);

    worker.emit("message", { type: "error", code: "wasm-critical", message: "skia failed" });

    await expect(done).rejects.toMatchObject({
      data: { type: "internal", code: "wasm-critical", hint: "skia failed" },
    });
  });

  it("defaults a coded error message to wasm-render-error", async () => {
    const worker = new FakeWorker();
    const done = renderOn(worker, {}, () => undefined);

    worker.emit("message", { type: "error", message: "no code" });

    await expect(done).rejects.toMatchObject({ data: { code: "wasm-render-error", hint: "no code" } });
  });

  it("rejects when the worker exits", async () => {
    const worker = new FakeWorker();
    const done = renderOn(worker, {}, () => undefined);

    worker.emit("exit", 2);

    await expect(done).rejects.toMatchObject({
      data: { code: "worker-exited", hint: "render worker exited with code 2" },
    });
  });

  it("rejects when the object handler throws and drops the listeners", async () => {
    const worker = new FakeWorker();
    const done = renderOn(worker, {}, () => {
      throw new Error("zip failed");
    });

    worker.emit("message", { type: "object", payload: encode({ id: "a" }) });

    await expect(done).rejects.toThrow("zip failed");
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it("terminates a worker that goes silent and reports a render timeout", async () => {
    vi.useFakeTimers();

    const worker = new FakeWorker();
    const done = renderOn(worker, {}, () => undefined);
    const rejection = expect(done).rejects.toMatchObject({ data: { code: "render-timeout" } });

    await vi.advanceTimersByTimeAsync(300_000);
    await rejection;

    expect(worker.terminations).toBe(1);
    expect(worker.__alive).toBe(false);
  });
});

describe("terminate", () => {
  it("marks the worker dead and terminates it", () => {
    const worker = new FakeWorker();

    terminate(worker);

    expect(worker.__alive).toBe(false);
    expect(worker.terminations).toBe(1);
  });

  it("ignores an absent worker", () => {
    expect(() => terminate(undefined)).not.toThrow();
  });
});

describe("capacity/init/stop", () => {
  it("defaults to two render slots", () => {
    expect(capacity()).toBe(2);
  });

  it("builds and drops the module pool", async () => {
    const { factory } = factoryOf();
    setWorkerFactory(factory);

    init();
    expect(currentPool()).toBeInstanceOf(WorkerPool);

    await stop();
    expect(currentPool()).toBeUndefined();
  });

  it("wraps a missing pool as worker-not-ready", async () => {
    const cause = await withWorker(async () => undefined).catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(AppError);
    expect((cause as AppError).data.code).toBe("worker-not-ready");
  });
});
