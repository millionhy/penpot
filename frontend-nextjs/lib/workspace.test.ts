// Unit tests for the workspace data layer (lib/workspace): the URL
// parameter parsing, the initialize-page resolution, the
// dsh/lookup-page-objects and cfh/get-immediate-children helpers and the
// get-file load with its two-pass pointer resolution plus the d/removem
// pass. The RPC transport is mocked; the pure helpers run as-is.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cmd: vi.fn() }));

vi.mock("@/lib/rpc", () => ({ cmd: mocks.cmd }));

import { ZERO_UUID } from "@/lib/file-data";
import { Pointer } from "@/lib/transit";
import {
  fetchWorkspaceFile,
  immediateChildren,
  pageObjects,
  parseWorkspaceQuery,
  resolvePageId,
  resolveWorkspaceFileData,
  type WorkspaceFile,
  type WorkspaceFileData,
  type WorkspaceObjects,
} from "@/lib/workspace";

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const TEAM_ID = "33333333-3333-3333-3333-333333333333";

function makeFile(): WorkspaceFile {
  return {
    id: FILE_ID,
    name: "Sample file",
    data: {
      pages: ["p1", "p2"],
      "pages-index": {
        p1: { id: "p1", name: "Page 1", objects: {} },
        p2: { id: "p2", name: "Page 2", objects: {} },
      },
    },
  };
}

beforeEach(() => {
  mocks.cmd.mockReset();
});

describe("parseWorkspaceQuery", () => {
  it("parses the uuid parameters of workspace-href links", () => {
    const search = new URLSearchParams({
      "team-id": TEAM_ID,
      "file-id": FILE_ID,
      "page-id": PAGE_ID,
    });
    expect(parseWorkspaceQuery(search)).toEqual({
      fileId: FILE_ID,
      pageId: PAGE_ID,
      teamId: TEAM_ID,
    });
  });

  it("treats missing and malformed values as absent", () => {
    const search = new URLSearchParams({ "file-id": "not-a-uuid" });
    expect(parseWorkspaceQuery(search)).toEqual({ fileId: null, pageId: null, teamId: null });
  });
});

describe("resolvePageId", () => {
  it("keeps the requested page when the file knows it", () => {
    expect(resolvePageId(makeFile(), "p2")).toBe("p2");
  });

  it("falls back to the first page for missing and unknown ids", () => {
    expect(resolvePageId(makeFile(), null)).toBe("p1");
    expect(resolvePageId(makeFile(), "gone")).toBe("p1");
  });

  it("returns null for a file without pages", () => {
    const file: WorkspaceFile = { id: FILE_ID, name: "Empty", data: {} };
    expect(resolvePageId(file, null)).toBeNull();
  });
});

describe("pageObjects", () => {
  it("returns the objects of the page", () => {
    const file = makeFile();
    const objects = { [ZERO_UUID]: { id: ZERO_UUID, type: "frame" } };
    file.data["pages-index"]!.p1.objects = objects;
    expect(pageObjects(file, "p1")).toEqual(objects);
  });

  it("returns an empty map for missing pages and no page", () => {
    expect(pageObjects(makeFile(), "gone")).toEqual({});
    expect(pageObjects(makeFile(), null)).toEqual({});
  });
});

describe("immediateChildren", () => {
  it("resolves the root shapes and skips the unresolvable ones", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["a", "b", "missing"] },
      a: { id: "a", type: "rect" },
      b: { id: "b", type: "rect" },
    };
    expect(immediateChildren(objects)).toEqual([objects.a, objects.b]);
  });

  it("returns an empty list without a root", () => {
    expect(immediateChildren({ a: { id: "a", type: "rect" } })).toEqual([]);
  });
});

describe("resolveWorkspaceFileData", () => {
  it("resolves the two pointer passes and drops keys still holding a pointer", async () => {
    const page = { id: "p1", name: "Page 1", objects: {} };
    const fetchFragment = vi.fn(async (fragmentId: string): Promise<unknown> => {
      if (fragmentId === "page-1") return page;
      if (fragmentId === "thumbs-1") return ["thumbnail"];
      // A fragment that resolves to another pointer stays a pointer; the
      // d/removem pass drops its key.
      if (fragmentId === "double") return new Pointer("inner", null);
      throw new Error("unexpected fragment " + fragmentId);
    });

    const data = {
      pages: ["p1"],
      "pages-index": { p1: new Pointer("page-1", null) },
      "thumbnails-ref": new Pointer("thumbs-1", null),
      "double-ref": new Pointer("double", null),
      plain: 42,
    } as unknown as WorkspaceFileData;

    const resolved = await resolveWorkspaceFileData(data, fetchFragment);

    expect(resolved["pages-index"]).toEqual({ p1: page });
    expect(resolved["thumbnails-ref"]).toEqual(["thumbnail"]);
    expect(resolved).not.toHaveProperty("double-ref");
    expect(resolved.plain).toBe(42);
    expect(resolved.pages).toEqual(["p1"]);
  });
});

describe("fetchWorkspaceFile", () => {
  it("loads through get-file and resolves fragments through get-file-fragment", async () => {
    const page = {
      id: "p1",
      name: "Page 1",
      objects: { [ZERO_UUID]: { id: ZERO_UUID, type: "frame" } },
    };
    const file = {
      id: FILE_ID,
      name: "Loaded",
      data: { pages: ["p1"], "pages-index": { p1: new Pointer("page-1", null) } },
    };
    mocks.cmd.mockImplementation((command: string, params: Record<string, unknown>) => {
      if (command === "get-file") return Promise.resolve(file);
      if (command === "get-file-fragment") {
        expect(params["file-id"]).toBe(FILE_ID);
        return Promise.resolve({ data: page });
      }
      return Promise.reject(new Error("unexpected command " + command));
    });

    const loaded = await fetchWorkspaceFile(FILE_ID);

    expect(loaded.id).toBe(FILE_ID);
    expect(loaded.data["pages-index"]?.p1?.objects).toEqual(page.objects);
    expect(mocks.cmd).toHaveBeenCalledWith(
      "get-file",
      expect.objectContaining({ id: FILE_ID }),
    );
    expect(mocks.cmd).toHaveBeenCalledWith(
      "get-file-fragment",
      expect.objectContaining({ "file-id": FILE_ID, "fragment-id": "page-1" }),
    );
  });
});
