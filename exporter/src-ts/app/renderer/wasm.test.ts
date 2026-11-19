// app.renderer.wasm: the serialized per-job scope over the worker pool.

import { afterEach, describe, expect, it, vi } from "vitest";

process.env.PENPOT_SECRET_KEY = "test-secret";
process.env.PENPOT_WASM_WORKER_POOL_MIN = "0";

import type { RenderParams } from "../renderer.js";
import { decode } from "../transit.js";
import * as pool from "../wasm/pool.js";
import { FakeWorker } from "../../test/fake-worker.js";
import { render, serializer, withScope } from "./wasm.js";

function setup(max = 1): { created: FakeWorker[] } {
  const created: FakeWorker[] = [];
  const factory = async () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker;
  };

  pool.setPool(
    new pool.WorkerPool(factory, {
      max,
      min: 0,
      testOnBorrow: true,
      evictionRunIntervalMillis: 600000,
      numTestsPerEvictionRun: 2,
      idleTimeoutMillis: 600000,
    }),
  );

  return { created };
}

afterEach(async () => {
  await pool.stop();
});

describe("serializer", () => {
  it("runs the thunks one at a time, in submission order", async () => {
    const chain = serializer();
    const order: string[] = [];

    const first = chain(async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("a:end");
      return 1;
    });
    const second = chain(async () => {
      order.push("b");
      return 2;
    });

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  it("keeps the chain alive after a failure", async () => {
    const chain = serializer();

    const failed = chain(async () => {
      throw new Error("boom");
    });
    const next = chain(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("withScope", () => {
  it("sends every render to the same worker, one at a time", async () => {
    const { created } = setup();
    const onObject = vi.fn();

    const params = (scale: number): RenderParams => ({
      "file-id": "f",
      "page-id": "p",
      scale,
      type: "png",
      objects: [],
    });

    const scope = withScope(undefined, async (renderShape) => {
      await renderShape(params(1), onObject);
      await renderShape(params(2), onObject);
    });

    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1));
    created[0].emit("message", { type: "done" });

    await vi.waitFor(() => expect(created[0].posted).toHaveLength(2));
    created[0].emit("message", { type: "done" });

    await scope;

    const posted = created[0].posted as Array<{ params: string }>;
    expect(decode(posted[0].params)).toEqual(params(1));
    expect(decode(posted[1].params)).toEqual(params(2));
    expect(created).toHaveLength(1);
  });

  it("destroys the worker when the scope throws", async () => {
    const { created } = setup();

    await expect(
      withScope(undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(created[0].terminations).toBe(1);
  });
});

describe("render", () => {
  it("reads the job id from the params and renders once", async () => {
    const { created } = setup();
    const onObject = vi.fn();
    const params = { "job-id": "not-a-live-job", pages: [{ id: "p1" }] };

    const done = render(params, onObject);

    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1));
    const command = created[0].posted[0] as { params: string };
    expect(decode(command.params)).toEqual(params);

    created[0].emit("message", { type: "done" });
    await done;
    expect(onObject).not.toHaveBeenCalled();
  });
});
