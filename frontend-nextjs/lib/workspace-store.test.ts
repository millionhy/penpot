// Unit tests for the workspace module store (lib/workspace-store): the
// subscribe/notify pair the route components bind through
// useSyncExternalStore, the snapshot stability, the viewport slice
// accessors and the finalize-workspace reset. Every case resets the store
// first, since the store is module-level by design.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getInitialWorkspaceState,
  getWorkspaceState,
  getWorkspaceViewport,
  resetWorkspaceState,
  setWorkspaceState,
  setWorkspaceViewport,
  subscribeWorkspace,
} from "@/lib/workspace-store";

beforeEach(() => {
  resetWorkspaceState();
});

describe("getInitialWorkspaceState", () => {
  it("returns the idle slice for the hydration render", () => {
    const initial = getInitialWorkspaceState();
    expect(initial.status).toBe("idle");
    expect(initial.fileId).toBeNull();
    expect(initial.file).toBeNull();
    expect(initial.pageId).toBeNull();
    expect(initial.error).toBeNull();
  });

  it("keeps its identity across writes", () => {
    const initial = getInitialWorkspaceState();
    setWorkspaceState({ status: "loading" });
    expect(getInitialWorkspaceState()).toBe(initial);
  });
});

describe("subscribeWorkspace", () => {
  it("notifies every subscriber and stops after the unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeWorkspace(a);
    const unsubB = subscribeWorkspace(b);

    setWorkspaceState({ status: "loading" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    setWorkspaceState({ status: "ready" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    unsubB();
  });

  it("keeps the snapshot reference stable between writes", () => {
    const before = getWorkspaceState();
    expect(getWorkspaceState()).toBe(before);
    setWorkspaceState({ status: "loading" });
    expect(getWorkspaceState()).not.toBe(before);
  });
});

describe("setWorkspaceState", () => {
  it("merges the patch and keeps the untouched fields", () => {
    setWorkspaceState({ status: "ready", fileId: "file-1" });
    setWorkspaceState({ pageId: "page-1" });
    const state = getWorkspaceState();
    expect(state.status).toBe("ready");
    expect(state.fileId).toBe("file-1");
    expect(state.pageId).toBe("page-1");
  });
});

describe("viewport slice", () => {
  it("is null until zoom, vbox and vport are all set", () => {
    expect(getWorkspaceViewport()).toBeNull();
    setWorkspaceState({ zoom: 1 });
    expect(getWorkspaceViewport()).toBeNull();
    setWorkspaceState({ vbox: { x: 0, y: 0, width: 100, height: 100 } });
    expect(getWorkspaceViewport()).toBeNull();
    setWorkspaceState({ vport: { width: 100, height: 100 } });
    expect(getWorkspaceViewport()).toEqual({
      zoom: 1,
      vbox: { x: 0, y: 0, width: 100, height: 100 },
      vport: { width: 100, height: 100 },
    });
  });

  it("writes the three fields in one shot", () => {
    const listener = vi.fn();
    const unsub = subscribeWorkspace(listener);
    setWorkspaceViewport({
      zoom: 2,
      vbox: { x: 1, y: 2, width: 3, height: 4 },
      vport: { width: 5, height: 6 },
    });
    expect(getWorkspaceViewport()).toEqual({
      zoom: 2,
      vbox: { x: 1, y: 2, width: 3, height: 4 },
      vport: { width: 5, height: 6 },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("resetWorkspaceState", () => {
  it("restores the initial slice and notifies the listeners", () => {
    const listener = vi.fn();
    const unsub = subscribeWorkspace(listener);
    setWorkspaceState({ status: "ready", fileId: "file-1" });
    setWorkspaceViewport({
      zoom: 2,
      vbox: { x: 0, y: 0, width: 10, height: 10 },
      vport: { width: 10, height: 10 },
    });

    resetWorkspaceState();

    const state = getWorkspaceState();
    expect(state.status).toBe("idle");
    expect(state.fileId).toBeNull();
    expect(state.file).toBeNull();
    expect(state.pageId).toBeNull();
    expect(getWorkspaceViewport()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
  });
});
