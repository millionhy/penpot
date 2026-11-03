// Unit tests for the F9.15 index builder: the worker-side pure build, the
// sequence protocol of the client, and every fallback that keeps the canvas
// supplied with an index when no worker serves the build.

import { describe, expect, it, vi } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import { createWorkspaceIndex, type WorkspaceIndex } from "@/lib/workspace-index";
import {
  createIndexBuilder,
  type IndexBuildReply,
  type IndexBuilder,
} from "@/lib/workspace-index-client";
import type { WorkspaceObjects } from "@/lib/workspace";
import { buildIndexReply } from "@/lib/workspace-index.worker";

const RECT = "00000000-0000-0000-0000-0000000000a2";

function model(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", "parent-id": ZERO_UUID, "frame-id": ZERO_UUID },
    [RECT]: {
      id: RECT,
      type: "rect",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    },
  };
}

describe("buildIndexReply", () => {
  it("answers with the index a synchronous build produces", () => {
    const reply = buildIndexReply({ seq: 3, objects: model() });
    expect(reply.seq).toBe(3);
    expect(reply.error).toBeUndefined();
    // The shape lands in the quadtree exactly like the main-thread build.
    expect(reply.index).toEqual(createWorkspaceIndex(model()));
  });

  it("carries a thrown build as an error reply", () => {
    // createWorkspaceIndex walks every value of the map, so a poisoned
    // getter forces the build to throw regardless of the shape filtering.
    const poisoned = {} as WorkspaceObjects;
    Object.defineProperty(poisoned, "boom", {
      enumerable: true,
      get() {
        throw new Error("poisoned");
      },
    });
    const reply = buildIndexReply({ seq: 1, objects: poisoned });
    expect(reply.seq).toBe(1);
    expect(typeof reply.error).toBe("string");
  });
});

interface FakeWorker {
  posted: unknown[];
  listeners: Record<string, ((event: { data: unknown }) => void)[]>;
  terminated: boolean;
  postMessage(message: unknown): void;
  addEventListener(type: string, handler: (event: { data: unknown }) => void): void;
  terminate(): void;
  emit(type: string, data: unknown): void;
}

function fakeWorker(): FakeWorker {
  const worker: FakeWorker = {
    posted: [],
    listeners: {},
    terminated: false,
    postMessage(message: unknown) {
      this.posted.push(message);
    },
    addEventListener(type: string, handler: (event: { data: unknown }) => void) {
      (this.listeners[type] ??= []).push(handler);
    },
    terminate() {
      this.terminated = true;
    },
    emit(type: string, data: unknown) {
      for (const handler of this.listeners[type] ?? []) handler({ data });
    },
  };
  return worker;
}

// The spawn contract only needs the three Worker methods the client calls,
// and it owns the wiring: like the default spawn, the fake routes emitted
// messages to the reply callback and emitted errors to the broken one.
function spawnFake(worker: FakeWorker) {
  return (
    onReply: (reply: IndexBuildReply) => void,
    onBroken: () => void,
  ) => {
    worker.addEventListener("message", (event) => onReply(event.data as IndexBuildReply));
    worker.addEventListener("error", () => onBroken());
    return worker as unknown as Worker;
  };
}

describe("createIndexBuilder", () => {
  it("delivers a worker reply for the newest sequence", () => {
    const worker = fakeWorker();
    const builder: IndexBuilder = createIndexBuilder(spawnFake(worker));
    const seen: WorkspaceIndex[] = [];

    builder.schedule(model(), (index) => seen.push(index));

    expect(worker.posted).toHaveLength(1);
    const request = worker.posted[0] as { seq: number };
    expect(request.seq).toBe(1);
    worker.emit("message", { seq: 1, index: createWorkspaceIndex(model()) });
    expect(seen).toHaveLength(1);
    expect(seen[0].bounds).toEqual(createWorkspaceIndex(model()).bounds);
  });

  it("drops a reply superseded by a newer schedule", () => {
    const worker = fakeWorker();
    const builder = createIndexBuilder(spawnFake(worker));
    const first = vi.fn();
    const second = vi.fn();

    builder.schedule(model(), first);
    builder.schedule(model(), second);
    const late = createWorkspaceIndex(model());
    worker.emit("message", { seq: 1, index: late });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    worker.emit("message", { seq: 2, index: late });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("settles the waiting build synchronously when the worker pass fails", () => {
    const worker = fakeWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const builder = createIndexBuilder(spawnFake(worker));
    const seen: WorkspaceIndex[] = [];

    builder.schedule(model(), (index) => seen.push(index));
    worker.emit("message", { seq: 1, error: "boom" });

    // The sync fallback settles the in-flight deliver...
    expect(seen).toHaveLength(1);
    // ...and later schedules never touch the terminated worker again.
    builder.schedule(model(), (index) => seen.push(index));
    expect(worker.terminated).toBe(true);
    expect(seen).toHaveLength(2);
    expect(worker.posted).toHaveLength(1);
    warn.mockRestore();
  });

  it("settles the waiting build when the worker channel errors", () => {
    const worker = fakeWorker();
    const builder = createIndexBuilder(spawnFake(worker));
    const seen: WorkspaceIndex[] = [];

    builder.schedule(model(), (index) => seen.push(index));
    worker.emit("error", undefined);

    expect(seen).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("builds on the calling thread when the environment has no worker", () => {
    const builder = createIndexBuilder(() => null);
    const seen: WorkspaceIndex[] = [];

    builder.schedule(model(), (index) => seen.push(index));

    expect(seen).toHaveLength(1);
    expect(seen[0].bounds).toEqual(createWorkspaceIndex(model()).bounds);
  });

  it("terminates the worker on dispose and respawns on the next schedule", () => {
    const worker = fakeWorker();
    let spawns = 0;
    const builder = createIndexBuilder(() => {
      spawns += 1;
      return worker as unknown as Worker;
    });

    builder.schedule(model(), () => undefined);
    expect(spawns).toBe(1);
    builder.dispose();
    expect(worker.terminated).toBe(true);

    const next = fakeWorker();
    const second = createIndexBuilder(() => next as unknown as Worker);
    const seen: WorkspaceIndex[] = [];
    second.schedule(model(), (index) => seen.push(index));
    expect(next.posted).toHaveLength(1);
  });
});