import { beforeEach, describe, expect, it, vi } from "vitest";
import { Pointer, encodeTransit } from "@/lib/transit";

vi.mock("@/lib/rpc", () => ({ cmdRaw: vi.fn() }));

import { cmdRaw } from "@/lib/rpc";
import {
  decodeBundleText,
  fetchDecodedBundle,
  invalidateDecodedBundle,
  loadDecodedBundle,
  pageObjects,
  resolveBundlePointers,
  shapeById,
} from "./bundle";

const FILE_ID = "file-1";

beforeEach(() => {
  vi.mocked(cmdRaw).mockReset();
  invalidateDecodedBundle({ fileId: FILE_ID });
  invalidateDecodedBundle({ fileId: FILE_ID, shareId: "share-1" });
});

describe("decodeBundleText", () => {
  it("reads the file data as plain objects", () => {
    const raw = encodeTransit({
      file: {
        id: FILE_ID,
        data: {
          "pages-index": {
            "page-1": { objects: { s1: { id: "s1", type: "rect" } } },
          },
        },
      },
      team: { id: "team-1" },
    });

    const bundle = decodeBundleText(raw);
    expect(bundle.file.id).toBe(FILE_ID);
    expect(bundle.payload.team).toEqual({ id: "team-1" });
    expect(pageObjects(bundle.fileData, "page-1")).toEqual({
      s1: { id: "s1", type: "rect" },
    });
  });

  it("answers empty data for a payload without a file", () => {
    const bundle = decodeBundleText(encodeTransit({ team: {} }));
    expect(bundle.file).toEqual({});
    expect(bundle.fileData).toEqual({});
    expect(pageObjects(bundle.fileData, "page-1")).toBeUndefined();
  });
});

describe("resolveBundlePointers", () => {
  it("resolves the pages-index first, then the top-level keys", async () => {
    const fileData = {
      "pages-index": {
        "page-1": new Pointer("frag-1", null),
        "page-2": { objects: {} },
      },
      fonts: new Pointer("frag-2", null),
      name: "doc",
    };
    const calls: string[] = [];
    const loader = async (fragmentId: string): Promise<unknown> => {
      calls.push(fragmentId);
      return fragmentId === "frag-1" ? { objects: { s1: {} } } : ["font"];
    };

    const data = await resolveBundlePointers(fileData, { fileId: FILE_ID }, loader);

    expect(calls).toEqual(["frag-1", "frag-2"]);
    expect(data["pages-index"]).toEqual({
      "page-1": { objects: { s1: {} } },
      "page-2": { objects: {} },
    });
    expect(data.fonts).toEqual(["font"]);
    expect(data.name).toBe("doc");
    // The input map keeps its pointers.
    expect((fileData["pages-index"] as Record<string, unknown>)["page-1"]).toBeInstanceOf(Pointer);
  });

  it("passes the share id to the fragment command", async () => {
    vi.mocked(cmdRaw).mockResolvedValue(encodeTransit({ data: { objects: {} } }));

    const data = await resolveBundlePointers(
      { "pages-index": { "page-1": new Pointer("frag-1", null) } },
      { fileId: FILE_ID, shareId: "share-1" },
    );

    expect(cmdRaw).toHaveBeenCalledWith("get-file-fragment", {
      "file-id": FILE_ID,
      "fragment-id": "frag-1",
      "share-id": "share-1",
    });
    expect(data["pages-index"]).toEqual({ "page-1": { objects: {} } });
  });
});

describe("loadDecodedBundle", () => {
  it("shares one load per file and share pair", async () => {
    vi.mocked(cmdRaw).mockResolvedValue(
      encodeTransit({ file: { data: { "pages-index": {} } }, team: {} }),
    );

    const first = loadDecodedBundle({ fileId: FILE_ID });
    const second = loadDecodedBundle({ fileId: FILE_ID });
    expect(second).toBe(first);

    const bundle = await first;
    expect(bundle.fileData).toEqual({ "pages-index": {} });
    expect(cmdRaw).toHaveBeenCalledTimes(1);
    expect(cmdRaw).toHaveBeenCalledWith(
      "get-view-only-bundle",
      expect.objectContaining({ "file-id": FILE_ID }),
    );

    invalidateDecodedBundle({ fileId: FILE_ID });
    await loadDecodedBundle({ fileId: FILE_ID });
    expect(cmdRaw).toHaveBeenCalledTimes(2);
  });

  it("keeps the share id in the bundle command", async () => {
    vi.mocked(cmdRaw).mockResolvedValue(encodeTransit({ file: { data: {} } }));

    await loadDecodedBundle({ fileId: FILE_ID, shareId: "share-1" });

    expect(cmdRaw).toHaveBeenCalledWith(
      "get-view-only-bundle",
      expect.objectContaining({ "file-id": FILE_ID, "share-id": "share-1" }),
    );
  });

  it("evicts a failed load so the next mount retries", async () => {
    vi.mocked(cmdRaw)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(encodeTransit({ file: { data: {} } }));

    await expect(fetchDecodedBundle({ fileId: FILE_ID })).rejects.toThrow("offline");
    const bundle = await loadDecodedBundle({ fileId: FILE_ID });
    expect(bundle.fileData).toEqual({});
    expect(cmdRaw).toHaveBeenCalledTimes(2);
  });
});

describe("pageObjects and shapeById", () => {
  it("reads the page objects and one shape", () => {
    const fileData = {
      "pages-index": { "page-1": { objects: { s1: { id: "s1" } } } },
    };
    const objects = pageObjects(fileData, "page-1");
    expect(objects).toEqual({ s1: { id: "s1" } });
    expect(shapeById(objects ?? {}, "s1")).toEqual({ id: "s1" });
    expect(shapeById(objects ?? {}, "missing")).toBeUndefined();
  });
});
