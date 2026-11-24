// Unit tests for the frontend half of app.common.files.changes (G5.3): the
// structural validation of an inbound change vector and the page-level
// application over the workspace file model.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { UpdateFileChange, UpdateFilePageChange } from "@/lib/transit";
import {
  applyPageChanges,
  isPageChange,
  validateFileChanges,
} from "@/lib/workspace-file-change";
import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";
import { emptyPage } from "@/lib/workspace-pages";

const FILE_ID = "00000000-0000-0000-0000-0000000000f1";
const PAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PAGE = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
const SHAPE_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

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
    id: FILE_ID,
    name: "File",
    revn: 4,
    vern: 2,
    data: {
      pages: [PAGE_ID, OTHER_PAGE],
      "pages-index": {
        [PAGE_ID]: {
          id: PAGE_ID,
          name: "Page 1",
          objects: { [ZERO_UUID]: rootFrame([SHAPE_ID]) },
        },
        [OTHER_PAGE]: {
          id: OTHER_PAGE,
          name: "Page 2",
          objects: { [ZERO_UUID]: rootFrame() },
        },
      },
    },
  };
}

describe("validateFileChanges", () => {
  it("accepts the change types this shell consumes", () => {
    const changes: UpdateFileChange[] = [
      { type: "del-obj", "page-id": PAGE_ID, id: SHAPE_ID },
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: SHAPE_ID,
        operations: [{ type: "set", attr: "name", val: "Rect" }],
      },
      { type: "mov-objects", "page-id": PAGE_ID, "parent-id": ZERO_UUID, shapes: [SHAPE_ID] },
      { type: "add-page", id: OTHER_PAGE, name: "Page 3" },
      {
        type: "mod-page",
        id: OTHER_PAGE,
        background: null,
        "pixel-grid-opacity": 0.5,
      },
      { type: "del-page", id: OTHER_PAGE },
      { type: "mov-page", id: OTHER_PAGE, index: 0 },
    ];

    expect(validateFileChanges(changes)).toEqual({ ok: true, changes });
  });

  it("tolerates an unknown change type as an object with a type", () => {
    const changes = [{ type: "add-component", id: SHAPE_ID }];
    expect(validateFileChanges(changes)).toEqual({ ok: true, changes });
  });

  it("rejects a value that is not a change vector", () => {
    expect(validateFileChanges(null)).toEqual({
      ok: false,
      errors: [{ index: -1, reason: "the changes are not an array" }],
    });
    expect(validateFileChanges({ changes: [] }).ok).toBe(false);
  });

  it("rejects entries without a type", () => {
    const result = validateFileChanges([{ id: SHAPE_ID }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ index: 0, reason: "the change carries no type" }]);
  });

  it("rejects a hole in the change vector", () => {
    const changes: unknown[] = [];
    changes[1] = { type: "del-page", id: PAGE_ID };
    const result = validateFileChanges(changes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].index).toBe(0);
  });

  it("rejects a malformed page id", () => {
    const result = validateFileChanges([
      { type: "del-page", id: "not-a-uuid" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].reason).toContain("id");
  });

  it("rejects a set operation without an attr", () => {
    const result = validateFileChanges([
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: SHAPE_ID,
        operations: [{ type: "set", val: "Rect" }],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].reason).toContain("attr");
  });

  it("accepts component-targeted changes and component-sync operations", () => {
    const changes = [
      {
        type: "mod-obj",
        "component-id": SHAPE_ID,
        id: SHAPE_ID,
        operations: [
          { type: "assign", value: { name: "Rect" } },
          { type: "set-touched", touched: null },
        ],
      },
      { type: "del-obj", "component-id": SHAPE_ID, id: SHAPE_ID },
      {
        type: "mov-objects",
        "component-id": SHAPE_ID,
        "parent-id": ZERO_UUID,
        shapes: [SHAPE_ID],
        index: null,
      },
    ];
    expect(validateFileChanges(changes)).toEqual({ ok: true, changes });
  });

  it("rejects a mod-page without attributes", () => {
    const result = validateFileChanges([{ type: "mod-page", id: PAGE_ID }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].reason).toContain("attribute");
  });

  it("rejects a pixel-grid opacity outside the safe number range", () => {
    const result = validateFileChanges([
      { type: "mod-page", id: PAGE_ID, "pixel-grid-opacity": 1e12 },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].reason).toContain("pixel-grid-opacity");
  });

  it("rejects an add-page with neither a name nor a page map", () => {
    const result = validateFileChanges([{ type: "add-page", id: PAGE_ID }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].reason).toContain("name or a page");
  });

  it("accepts an add-page that carries the whole page map", () => {
    const page = emptyPage(OTHER_PAGE, "Imported");
    const changes = [{ type: "add-page", id: OTHER_PAGE, page }];
    expect(validateFileChanges(changes)).toEqual({ ok: true, changes });
  });
});

describe("isPageChange", () => {
  it("separates the four page-level types from the shape changes", () => {
    const pageChanges: UpdateFilePageChange[] = [
      { type: "add-page", id: OTHER_PAGE, name: "Page 3" },
      { type: "mod-page", id: OTHER_PAGE, name: "Home" },
      { type: "del-page", id: OTHER_PAGE },
      { type: "mov-page", id: OTHER_PAGE, index: 1 },
    ];
    for (const change of pageChanges) expect(isPageChange(change)).toBe(true);
    expect(isPageChange({ type: "del-obj", "page-id": PAGE_ID, id: SHAPE_ID })).toBe(false);
  });
});

describe("applyPageChanges", () => {
  it("appends a page built from id and name with the open page root", () => {
    const file = makeFile();
    const root = file.data["pages-index"]?.[PAGE_ID].objects[ZERO_UUID];
    const next = applyPageChanges(file, [
      { type: "add-page", id: "new-page", name: "Page 3" },
    ], { root });

    expect(next.data.pages).toEqual([PAGE_ID, OTHER_PAGE, "new-page"]);
    expect(next.data["pages-index"]?.["new-page"]).toMatchObject({
      id: "new-page",
      name: "Page 3",
      objects: {
        [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: [] },
      },
    });
    expect(next.data["pages-index"]?.[PAGE_ID]).toBe(file.data["pages-index"]?.[PAGE_ID]);
  });

  it("adds a page that carries its own map", () => {
    const file = makeFile();
    const page = emptyPage("imported", "Imported");
    page.background = "#ffffff";
    const next = applyPageChanges(file, [
      { type: "add-page", id: "imported", page },
    ]);

    expect(next.data["pages-index"]?.imported).toBe(page);
  });

  it("treats a repeated add-page as a no-op", () => {
    const file = makeFile();
    const next = applyPageChanges(file, [
      { type: "add-page", id: PAGE_ID, name: "Replay" },
    ]);
    expect(next).toBe(file);
  });

  it("renames a page without replacing its objects map", () => {
    const file = makeFile();
    const next = applyPageChanges(file, [
      { type: "mod-page", id: PAGE_ID, name: "Home" },
    ]);

    expect(next.data["pages-index"]?.[PAGE_ID].name).toBe("Home");
    expect(next.data["pages-index"]?.[PAGE_ID].objects).toBe(
      file.data["pages-index"]?.[PAGE_ID].objects,
    );
    expect(next.data.pages).toBe(file.data.pages);
  });

  it("removes an attribute only when the change carries an explicit null", () => {
    const file = makeFile();
    const page = file.data["pages-index"]?.[PAGE_ID];
    if (page !== undefined) {
      page.background = "#ffffff";
      page["background-token"] = "surface.base";
      page["pixel-grid-opacity"] = 0.4;
    }

    const renamed = applyPageChanges(file, [
      { type: "mod-page", id: PAGE_ID, name: "Home" },
    ]);
    expect(renamed.data["pages-index"]?.[PAGE_ID].background).toBe("#ffffff");

    const cleared = applyPageChanges(renamed, [
      { type: "mod-page", id: PAGE_ID, background: null, "pixel-grid-opacity": null },
    ]);
    const clearedPage = cleared.data["pages-index"]?.[PAGE_ID];
    expect(clearedPage).not.toHaveProperty("background");
    expect(clearedPage).not.toHaveProperty("pixel-grid-opacity");
    expect(clearedPage?.["background-token"]).toBe("surface.base");
    expect(clearedPage?.name).toBe("Home");
  });

  it("keeps a page untouched when a mod-page targets a missing id", () => {
    const file = makeFile();
    expect(
      applyPageChanges(file, [{ type: "mod-page", id: "missing", name: "Home" }]),
    ).toBe(file);
  });

  it("deletes a page from the order and the index", () => {
    const file = makeFile();
    const next = applyPageChanges(file, [{ type: "del-page", id: PAGE_ID }]);

    expect(next.data.pages).toEqual([OTHER_PAGE]);
    expect(next.data["pages-index"]?.[PAGE_ID]).toBeUndefined();
    expect(next.data["pages-index"]?.[OTHER_PAGE]).toBe(
      file.data["pages-index"]?.[OTHER_PAGE],
    );
  });

  it("moves a page to an index counted after its removal", () => {
    const file = makeFile();
    const next = applyPageChanges(file, [
      { type: "mov-page", id: PAGE_ID, index: 1 },
    ]);
    expect(next.data.pages).toEqual([OTHER_PAGE, PAGE_ID]);

    const back = applyPageChanges(next, [{ type: "mov-page", id: PAGE_ID, index: 0 }]);
    expect(back.data.pages).toEqual([PAGE_ID, OTHER_PAGE]);
  });

  it("clamps an out-of-range mov-page index like split-at", () => {
    const file = makeFile();
    const past = applyPageChanges(file, [
      { type: "mov-page", id: PAGE_ID, index: 99 },
    ]);
    expect(past.data.pages).toEqual([OTHER_PAGE, PAGE_ID]);

    const before = applyPageChanges(file, [
      { type: "mov-page", id: PAGE_ID, index: -5 },
    ]);
    expect(before.data.pages).toEqual([PAGE_ID, OTHER_PAGE]);
  });

  it("ignores a mov-page for a page missing from the order", () => {
    const file = makeFile();
    expect(
      applyPageChanges(file, [{ type: "mov-page", id: "missing", index: 0 }]),
    ).toBe(file);
  });
});
