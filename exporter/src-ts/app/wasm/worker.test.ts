// app.wasm.worker: the render worker entry point. The port, the renderer and
// the logging console are injected, so these exercise the message protocol
// without spawning a thread.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../errors.js";
import { encode } from "../transit.js";
import { cancelledFn, main, onMessage, reset, setParentPort, setRenderer } from "./worker.js";

class FakePort {
  readonly posted: unknown[] = [];
  readonly listeners: Array<(data: unknown) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(_event: "message", listener: (data: unknown) => void): unknown {
    this.listeners.push(listener);
    return this;
  }
}

let port: FakePort;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  reset();
  port = new FakePort();
  setParentPort(port);
});

afterEach(() => {
  reset();
  vi.restoreAllMocks();
});

describe("cancelledFn", () => {
  it("reads the shared flag", () => {
    const buffer = new SharedArrayBuffer(4);
    const signal = new Int32Array(buffer);
    const cancelled = cancelledFn(buffer);

    expect(cancelled()).toBe(false);
    Atomics.store(signal, 0, 1);
    expect(cancelled()).toBe(true);
  });

  it("never cancels without a shared buffer", () => {
    expect(cancelledFn(undefined)()).toBe(false);
    expect(cancelledFn("nope")()).toBe(false);
  });
});

describe("main", () => {
  it("announces readiness and installs one listener", () => {
    main();

    expect(port.listeners).toHaveLength(1);
    expect(port.posted).toEqual([{ type: "ready" }]);

    // Re-entering main announces again but never doubles the listener.
    main();
    expect(port.listeners).toHaveLength(1);
  });
});

describe("onMessage", () => {
  it("renders a request, posting each object and then done", async () => {
    const object = { id: "shape", filename: "shape.png", path: "tmp/shape.png" };
    setRenderer(async (_params, onObject) => {
      onObject(object);
    });

    onMessage({ type: "render", params: encode({ "file-id": "file" }) });

    await vi.waitFor(() => expect(port.posted).toHaveLength(2));

    expect(port.posted[0]).toMatchObject({ type: "object" });
    expect(port.posted[1]).toEqual({ type: "done" });
  });

  it("passes the decoded params and the cancel predicate to the renderer", async () => {
    const buffer = new SharedArrayBuffer(4);
    Atomics.store(new Int32Array(buffer), 0, 1);

    const seen: Array<Record<string, unknown>> = [];
    setRenderer(async (params) => {
      seen.push(params);
    });

    onMessage({ type: "render", params: encode({ "file-id": "file" }), cancel: buffer });
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));

    expect(seen[0]).toMatchObject({ "file-id": "file" });
    expect((seen[0]["cancelled?"] as () => boolean)()).toBe(true);
  });

  it("reports a failed render with its code", async () => {
    setRenderer(async () => {
      throw new AppError({ type: "internal", code: "boom", hint: "render broke" });
    });

    onMessage({ type: "render", params: encode({}) });
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));

    expect(port.posted[0]).toEqual({ type: "error", message: "render broke", code: "boom" });
  });

  it("ignores an unknown message type", () => {
    onMessage({ type: "nope" });

    expect(port.posted).toEqual([]);
  });

  it("ignores a missing message", () => {
    onMessage(undefined);

    expect(port.posted).toEqual([]);
  });
});