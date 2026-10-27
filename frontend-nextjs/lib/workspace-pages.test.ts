// Unit tests for the workspace page list (lib/workspace-pages): file order,
// the generated names, the empty-page root template, the immutable file
// rewrites and the update-file change builders.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  addPageChange,
  deletePageChange,
  emptyPage,
  normalizePageName,
  pageInfos,
  renamePageChange,
  uniquePageName,
  validPageName,
  withPageAdded,
  withPageDeleted,
  withPageRenamed,
} from "@/lib/workspace-pages";
import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";

function rootFrame(children: string[] = []): WorkspaceObjects[string] {
  return {
    id: ZERO_UUID,
    type: "frame",
    name: "Root Frame",
    "parent-id": ZERO_UUID,
    "frame-id": ZERO_UUID,
    shapes: children,
  };
}

function makeFile(): WorkspaceFile {
  return {
    id: "file-1",
    name: "File",
    data: {
      pages: ["p1", "p2"],
      "pages-index": {
        p1: {
          id: "p1",
          name: "Page 1",
          objects: { [ZERO_UUID]: rootFrame(["shape-1"]) },
        },
        p2: { id: "p2", name: "Page 2", objects: { [ZERO_UUID]: rootFrame() } },
      },
    },
  };
}

describe("pageInfos", () => {
  it("lists the pages in file order with their names", () => {
    expect(pageInfos(makeFile())).toEqual([
      { id: "p1", name: "Page 1" },
      { id: "p2", name: "Page 2" },
    ]);
  });

  it("falls back to the empty name for a page missing from pages-index", () => {
    const file = makeFile();
    file.data.pages = ["p1", "gone"];
    expect(pageInfos(file)).toEqual([
      { id: "p1", name: "Page 1" },
      { id: "gone", name: "" },
    ]);
  });
});

describe("uniquePageName", () => {
  it("starts at Page 1 because the bare base name counts as taken", () => {
    expect(uniquePageName([])).toBe("Page 1");
    expect(uniquePageName(["Page"])).toBe("Page 1");
  });

  it("fills the first gap instead of counting the pages", () => {
    expect(uniquePageName(["Page 1", "Page 3"])).toBe("Page 2");
    expect(uniquePageName(["Page 1", "Page 2"])).toBe("Page 3");
  });
});

describe("page names", () => {
  it("trims like ctp/normalize-page-name and rejects blank names", () => {
    expect(normalizePageName("  Board  ")).toBe("Board");
    expect(validPageName("  Board  ")).toBe(true);
    expect(validPageName("   ")).toBe(false);
  });
});

describe("emptyPage", () => {
  it("clones the current root and clears its children", () => {
    const page = emptyPage("new", "Page 3", rootFrame(["shape-1"]));
    expect(page.id).toBe("new");
    expect(page.name).toBe("Page 3");
    expect(page.objects[ZERO_UUID]).toMatchObject({
      id: ZERO_UUID,
      type: "frame",
      name: "Root Frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      shapes: [],
    });
  });

  it("builds the root frame when there is no template", () => {
    const page = emptyPage("new", "Page 3", null);
    expect(page.objects[ZERO_UUID]).toMatchObject({
      id: ZERO_UUID,
      type: "frame",
      name: "Root Frame",
      shapes: [],
    });
  });
});

describe("file rewrites", () => {
  it("appends the new page and keeps the old pages untouched", () => {
    const file = makeFile();
    const page = emptyPage("p3", "Page 3", rootFrame());
    const next = withPageAdded(file, page);

    expect(next).not.toBe(file);
    expect(next.data.pages).toEqual(["p1", "p2", "p3"]);
    expect(next.data["pages-index"]?.p3).toBe(page);
    expect(next.data["pages-index"]?.p1).toBe(file.data["pages-index"]?.p1);
    // Adding an id already present is a no-op, like ctpl/add-page.
    expect(withPageAdded(next, page)).toBe(next);
  });

  it("renames a page without replacing its objects map", () => {
    const file = makeFile();
    const next = withPageRenamed(file, "p1", "Home");

    expect(next.data["pages-index"]?.p1.name).toBe("Home");
    expect(next.data["pages-index"]?.p1.objects).toBe(
      file.data["pages-index"]?.p1.objects,
    );
    expect(next.data.pages).toEqual(["p1", "p2"]);
    expect(withPageRenamed(next, "p1", "Home")).toBe(next);
    expect(withPageRenamed(next, "missing", "Home")).toBe(next);
  });

  it("deletes a page from the order and the index", () => {
    const file = makeFile();
    const next = withPageDeleted(file, "p1");

    expect(next.data.pages).toEqual(["p2"]);
    expect(next.data["pages-index"]?.p1).toBeUndefined();
    expect(next.data["pages-index"]?.p2).toBe(file.data["pages-index"]?.p2);
    expect(withPageDeleted(next, "p1")).toBe(next);
  });
});

describe("change builders", () => {
  it("builds the add-page, mod-page and del-page changes", () => {
    expect(addPageChange("page-id", "Page 3")).toEqual({
      type: "add-page",
      id: "page-id",
      name: "Page 3",
    });
    expect(renamePageChange("page-id", "Home")).toEqual({
      type: "mod-page",
      id: "page-id",
      name: "Home",
    });
    expect(deletePageChange("page-id")).toEqual({
      type: "del-page",
      id: "page-id",
    });
  });
});
