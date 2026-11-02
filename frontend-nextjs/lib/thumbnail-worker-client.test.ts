// Unit tests for the main-thread half of the dashboard thumbnail worker
// (lib/thumbnail-worker-client).
//
// Two layers. Without a browser Worker (the node environment) every entry
// must answer null and leave the card in its loader state; the dashboard
// keeps working. With a stubbed Worker the spawn/pending protocol is
// exercised: one message per render, crash recovery, and the holder
// refcount that keeps shared grids from tearing down each other's worker.

import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "@/lib/config";
import { THUMBNAIL_WIDTH } from "@/lib/thumbnail";
import {
  disposeThumbnailRenderer,
  generateFileThumbnail,
  renderThumbnailOffThread,
  retainThumbnailRenderer,
} from "@/lib/thumbnail-worker-client";

type Listener = (event: unknown) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly url: string;
  readonly options: { type?: string };
  readonly posted: Array<Record<string, unknown>> = [];
  terminated = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: URL | string, options: { type?: string } = {}) {
    this.url = String(url);
    this.options = options;
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function useBrowserWorker(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
}

function currentWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (worker === undefined) throw new Error("no worker was spawned");
  return worker;
}

afterEach(() => {
  disposeThumbnailRenderer();
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("without a browser worker", () => {
  it("answers null from the raw render entry", async () => {
    await expect(renderThumbnailOffThread("raw")).resolves.toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("answers null from generateFileThumbnail before any RPC", async () => {
    await expect(generateFileThumbnail("file-1", 7)).resolves.toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("disposes and releases safely with no worker around", () => {
    expect(() => {
      disposeThumbnailRenderer();
      const release = retainThumbnailRenderer();
      release();
      release();
    }).not.toThrow();
  });
});

describe("with a browser worker", () => {
  it("spawns a module worker and posts the raw page data", async () => {
    useBrowserWorker();

    const answer = renderThumbnailOffThread("raw-page");

    const worker = currentWorker();
    expect(worker.url.endsWith("/thumbnail.worker.ts")).toBe(true);
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({
      raw: "raw-page",
      width: THUMBNAIL_WIDTH,
      publicUri: config.publicUri,
    });

    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    worker.emit("message", { data: { id: worker.posted[0].id, blob } });

    await expect(answer).resolves.toBe(blob);
  });

  it("keeps the caller width and settles a missing blob as null", async () => {
    useBrowserWorker();

    const answer = renderThumbnailOffThread("raw", 100);

    const worker = currentWorker();
    expect(worker.posted[0].width).toBe(100);

    // A worker that answers without a blob (an error field) is a failed pass.
    worker.emit("message", { data: { id: worker.posted[0].id, error: "boom" } });

    await expect(answer).resolves.toBeNull();
  });

  it("settles pending work null, terminates on crash and respawns later", async () => {
    useBrowserWorker();

    const first = renderThumbnailOffThread("one");
    const second = renderThumbnailOffThread("two");
    const crashed = currentWorker();
    expect(crashed.posted).toHaveLength(2);

    crashed.emit("error", {});

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(crashed.terminated).toBe(true);

    void renderThumbnailOffThread("three");
    expect(FakeWorker.instances).toHaveLength(2);
    expect(currentWorker()).not.toBe(crashed);
  });

  it("terminates only when the last holder releases the shared worker", async () => {
    useBrowserWorker();

    const releaseFirst = retainThumbnailRenderer();
    const releaseSecond = retainThumbnailRenderer();

    void renderThumbnailOffThread("raw");
    const worker = currentWorker();

    releaseFirst();
    expect(worker.terminated).toBe(false);

    releaseSecond();
    expect(worker.terminated).toBe(true);

    // A replay of the same release must not count down twice.
    releaseSecond();
    expect(worker.terminated).toBe(true);
  });
});