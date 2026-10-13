import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "@/lib/errors";
import {
  createTeamAccessRequest,
  exceptionStage,
  isExceptionCause,
  loadAccessInfo,
  requestAccessParams,
  requestAccessStage,
} from "@/lib/exception-page";
import { encodeTransit } from "@/lib/transit";

describe("exceptionStage", () => {
  it("keeps the not-found content for an anonymous visitor", () => {
    expect(exceptionStage(false, null)).toBe("not-found");
    expect(exceptionStage(false, { fileId: "f1" })).toBe("not-found");
  });

  it("stays pending while the access info loads", () => {
    expect(exceptionStage(true, null)).toBe("pending");
  });

  it("turns into the request dialog when a file or team resolved", () => {
    expect(exceptionStage(true, { fileId: "f1" })).toBe("request-access");
    expect(exceptionStage(true, { teamId: "t1" })).toBe("request-access");
  });

  it("falls back to not-found when nothing resolved", () => {
    expect(exceptionStage(true, {})).toBe("not-found");
  });
});

describe("requestAccessStage", () => {
  const base = { isDefault: undefined, fileId: undefined, teamId: undefined, sent: false, alreadyRequested: false };

  it("lets the default-team branch win over everything", () => {
    expect(requestAccessStage({ ...base, isDefault: true, fileId: "f1" })).toBe("default-team");
  });

  it("shows the file copy when a requested file failed again", () => {
    expect(requestAccessStage({ ...base, fileId: "f1", alreadyRequested: true })).toBe("already-file");
  });

  it("shows the project copy when a requested team failed again", () => {
    expect(requestAccessStage({ ...base, teamId: "t1", alreadyRequested: true })).toBe("already-project");
  });

  it("shows the success copy once the request went through", () => {
    expect(requestAccessStage({ ...base, fileId: "f1", sent: true })).toBe("sent");
  });

  it("asks for the file, then for the team", () => {
    expect(requestAccessStage({ ...base, fileId: "f1" })).toBe("file");
    expect(requestAccessStage({ ...base, teamId: "t1" })).toBe("team");
  });
});

describe("requestAccessParams", () => {
  it("carries is-viewer for a file request outside the workspace", () => {
    expect(requestAccessParams({ fileId: "f1", teamId: undefined, isWorkspace: false })).toEqual({
      fileId: "f1",
      isViewer: true,
    });
  });

  it("drops is-viewer inside the workspace", () => {
    expect(requestAccessParams({ fileId: "f1", teamId: undefined, isWorkspace: true })).toEqual({
      fileId: "f1",
      isViewer: false,
    });
  });

  it("falls back to the team id without a file", () => {
    expect(requestAccessParams({ fileId: undefined, teamId: "t1", isWorkspace: false })).toEqual({
      teamId: "t1",
    });
  });
});

describe("isExceptionCause", () => {
  it("accepts not-found and authentication transport errors", () => {
    expect(isExceptionCause(new RpcError("x", { type: "not-found" }))).toBe(true);
    expect(isExceptionCause(new RpcError("x", { type: "authentication" }))).toBe(true);
  });

  it("rejects other transports and plain errors", () => {
    expect(isExceptionCause(new RpcError("x", { type: "internal" }))).toBe(false);
    expect(isExceptionCause(new RpcError("x", { type: "network" }))).toBe(false);
    expect(isExceptionCause(new Error("x"))).toBe(false);
    expect(isExceptionCause(null)).toBe(false);
  });
});

// load-info in static.cljs over the RPC transport: the file branch maps the
// row id, the team branch adds is-default, and the timeout resolves empty.
describe("loadAccessInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubTransit(body: unknown): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(encodeTransit(body), {
          status: 200,
          headers: { "content-type": "application/transit+json" },
        }),
    );
  }

  it("resolves the file id", async () => {
    stubTransit({ id: "f1" });
    await expect(loadAccessInfo({ fileId: "f1" })).resolves.toEqual({ fileId: "f1" });
  });

  it("resolves empty when the file does not exist", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    await expect(loadAccessInfo({ fileId: "missing" })).resolves.toEqual({});
  });

  it("resolves the team id and its default flag", async () => {
    stubTransit({ id: "t1", "is-default": true });
    await expect(loadAccessInfo({ teamId: "t1" })).resolves.toEqual({
      teamId: "t1",
      teamDefault: true,
    });
  });

  it("resolves empty without ids", async () => {
    await expect(loadAccessInfo({})).resolves.toEqual({});
  });

  it("resolves empty after the three second timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    const pending = loadAccessInfo({ fileId: "f1" });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({});
  });
});

describe("createTeamAccessRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the params to the command endpoint", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(encodeTransit({ request: {} }), {
        status: 200,
        headers: { "content-type": "application/transit+json" },
      });
    });

    await createTeamAccessRequest({ fileId: "f1", isViewer: true });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("create-team-access-request");
    expect(calls[0].init.method).toBe("POST");
  });
});
