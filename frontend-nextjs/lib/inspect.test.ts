import { describe, expect, it } from "vitest";

import {
  allShapeIds,
  buildInspectSections,
  contentToTextBlocks,
  expandRegionSelection,
  inspectSelectionType,
  inspectShapeIcon,
  inspectSubtitle,
  inspectTreeIds,
  inspectTreeRows,
  resolveShapes,
  unionSelrect,
  type InspectBuildContext,
} from "@/lib/inspect";
import type { ViewerObjects, ViewerShape } from "@/lib/viewer";

// The inspect model: the layer tree, the selection helpers and the computed
// sections of the right sidebar, ported from the CLJS data side.

function shape(id: string, type: string, extra: Record<string, unknown> = {}): ViewerShape {
  return { id, type, name: id, ...extra };
}

const TREE_OBJECTS: ViewerObjects = {
  frame: shape("frame", "frame", {
    shapes: ["group", "a"],
    selrect: { x: 0, y: 0, width: 200, height: 100 },
  }),
  group: shape("group", "group", { shapes: ["b"], "parent-id": "frame" }),
  a: shape("a", "rect", { "parent-id": "frame" }),
  b: shape("b", "text", { "parent-id": "group" }),
};

describe("inspectTreeRows", () => {
  it("lists the frame subtree topmost first, with depth and expand state", () => {
    const rows = inspectTreeRows(TREE_OBJECTS.frame, TREE_OBJECTS, new Set<string>());

    expect(rows.map((row) => row.shape.id)).toEqual(["frame", "a", "group", "b"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 2]);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, false, true, false]);
    expect(rows.every((row) => row.expanded)).toBe(true);
  });

  it("hides the subtree of a collapsed row", () => {
    const rows = inspectTreeRows(TREE_OBJECTS.frame, TREE_OBJECTS, new Set(["group"]));

    expect(rows.map((row) => row.shape.id)).toEqual(["frame", "a", "group"]);
    expect(rows[2].expanded).toBe(false);
  });

  it("feeds the shift range with the visible rows", () => {
    expect(inspectTreeIds(TREE_OBJECTS.frame, TREE_OBJECTS, new Set(["group"]))).toEqual([
      "frame",
      "a",
      "group",
    ]);
  });
});

describe("allShapeIds", () => {
  it("collects the frame and every shape that names it as its top-level frame", () => {
    const objects: ViewerObjects = {
      frame: shape("frame", "frame", { shapes: ["group", "a"], "frame-id": "zero" }),
      group: shape("group", "group", { shapes: ["b"], "frame-id": "frame" }),
      a: shape("a", "rect", { "frame-id": "frame" }),
      b: shape("b", "text", { "frame-id": "frame" }),
      c: shape("c", "rect", { "frame-id": "frame" }),
      "other-frame": shape("other-frame", "frame", { "frame-id": "zero" }),
      d: shape("d", "rect", { "frame-id": "other-frame" }),
    };

    const ids = [...new Set(allShapeIds(objects.frame, objects))].sort();

    expect(ids).toEqual(["a", "b", "c", "frame", "group"]);
  });
});

describe("expandRegionSelection", () => {
  const order = ["frame", "group", "b", "a"];

  it("selects the range between the last selected row and the target", () => {
    expect(expandRegionSelection(order, new Set(["frame"]), "a")).toEqual(order);
    expect(expandRegionSelection(order, new Set(["b"]), "group")).toEqual(["group", "b"]);
  });

  it("falls back to the target when it is outside the tree", () => {
    expect(expandRegionSelection(order, new Set(["frame"]), "missing")).toEqual(["missing"]);
  });

  it("takes the target alone when nothing was selected", () => {
    expect(expandRegionSelection(order, new Set<string>(), "a")).toEqual(["a"]);
  });
});

describe("resolveShapes", () => {
  it("skips ids the objects map does not carry", () => {
    const shapes = resolveShapes(TREE_OBJECTS, new Set(["a", "missing", "b"]));

    expect(shapes.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("unionSelrect", () => {
  it("wraps every selected selrect in one box", () => {
    const shapes = [
      shape("a", "rect", { selrect: { x: 0, y: 0, width: 10, height: 10 } }),
      shape("b", "rect", { selrect: { x: 5, y: 5, width: 10, height: 10 } }),
    ];

    expect(unionSelrect(shapes)).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });

  it("returns null when no shape has a selrect", () => {
    expect(unionSelrect([])).toBeNull();
    expect(unionSelrect([shape("a", "rect")])).toBeNull();
  });
});

describe("inspectShapeIcon", () => {
  it("maps the shape kinds onto the shell icon set", () => {
    expect(inspectShapeIcon(shape("f", "frame"))).toBe("board");
    expect(inspectShapeIcon(shape("g", "group"))).toBe("group");
    expect(inspectShapeIcon(shape("g", "group", { "masked-group": true }))).toBe("mask");
    expect(inspectShapeIcon(shape("c", "circle"))).toBe("ellipse");
    expect(inspectShapeIcon(shape("r", "rect"))).toBe("rect");
    expect(inspectShapeIcon(shape("t", "text"))).toBe("text");
    expect(inspectShapeIcon(shape("i", "image"))).toBe("image");
    expect(inspectShapeIcon(shape("s", "svg-raw"))).toBe("image");
    expect(inspectShapeIcon(shape("p", "path"))).toBe("path");
    expect(inspectShapeIcon(shape("p", "bool"))).toBe("path");
  });

  it("marks component heads, copies and variants", () => {
    expect(
      inspectShapeIcon(
        shape("m", "frame", {
          "component-id": "c",
          "main-instance": true,
        }),
      ),
    ).toBe("component");
    expect(
      inspectShapeIcon(
        shape("m", "frame", {
          "component-id": "c",
          "main-instance": true,
          "variant-id": "v",
        }),
      ),
    ).toBe("variant");
    expect(inspectShapeIcon(shape("i", "frame", { "component-id": "c" }))).toBe("component-copy");
    expect(inspectShapeIcon(shape("v", "frame", { "is-variant-container": true }))).toBe(
      "component",
    );
    expect(inspectShapeIcon(shape("i", "rect"), { "variant-id": "v" })).toBe("component");
  });
});

describe("inspectSubtitle", () => {
  it("names the main instance, the variant and the copy", () => {
    expect(inspectSubtitle(null)).toBeNull();
    expect(inspectSubtitle(shape("plain", "rect"))).toBeNull();
    expect(inspectSubtitle(shape("v", "frame", { "is-variant-container": true }))).toBe(
      "Main component",
    );
    expect(inspectSubtitle(shape("m", "frame", { "main-instance": true }))).toBe(
      "Main component",
    );
    expect(
      inspectSubtitle(shape("m", "frame", { "main-instance": true, "variant-id": "v" })),
    ).toBe("Variant");
    expect(inspectSubtitle(shape("i", "frame", { "component-id": "c" }))).toBe("Copy");
  });
});

describe("inspectSelectionType", () => {
  it("reads multiple, variant and the plain shape type", () => {
    expect(inspectSelectionType([])).toBe("multiple");
    expect(inspectSelectionType([shape("a", "rect"), shape("b", "rect")])).toBe("multiple");
    expect(inspectSelectionType([shape("v", "frame", { "is-variant-container": true })])).toBe(
      "variant",
    );
    expect(
      inspectSelectionType(
        [shape("i", "rect", { "component-id": "c" })],
        { c: { "variant-id": "v" } },
      ),
    ).toBe("variant");
    expect(inspectSelectionType([shape("r", "rect")])).toBe("rect");
  });
});

describe("contentToTextBlocks", () => {
  it("splits paragraphs by style and folds the defaults in", () => {
    const blocks = contentToTextBlocks({
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ text: "Hello ", "font-size": "14" }],
        },
        {
          type: "paragraph",
          children: [{ text: "world", "font-size": "24", "font-weight": "700" }],
        },
      ],
    });

    expect(blocks.map((block) => block.text)).toEqual(["Hello \n", "world\n"]);
    expect(blocks[0].style["font-size"]).toBe("14");
    expect(blocks[1].style["font-weight"]).toBe("700");
    expect(blocks[1].style["font-id"]).toBe("sourcesanspro");
  });

  it("returns nothing for absent content", () => {
    expect(contentToTextBlocks(null)).toEqual([]);
    expect(contentToTextBlocks("text")).toEqual([]);
  });
});

function contextFor(objects: ViewerObjects): InspectBuildContext {
  return { objects, colorFormat: "hex", publicUri: "", shareId: null };
}

describe("buildInspectSections", () => {
  it("returns no section for an empty selection", () => {
    expect(buildInspectSections([], contextFor({}))).toEqual([]);
  });

  it("orders the rect sections like the CLJS type options", () => {
    const rect = shape("rect", "rect", {
      selrect: { x: 0, y: 0, width: 100, height: 50 },
      opacity: 0.5,
      "fill-color": "#ff0000",
      "fill-opacity": 0.5,
      strokes: [
        {
          "stroke-color": "#000000",
          "stroke-opacity": 1,
          "stroke-width": 2,
          "stroke-style": "solid",
        },
      ],
    });
    const sections = buildInspectSections([rect], contextFor({ rect }));

    expect(sections.map((section) => section.id)).toEqual([
      "visibility",
      "geometry",
      "fill",
      "stroke",
    ]);
  });

  it("formats the geometry rows in pixels", () => {
    const rect = shape("rect", "rect", {
      selrect: { x: 0, y: 0, width: 100, height: 50 },
    });
    const geometry = buildInspectSections([rect], contextFor({ rect })).find(
      (section) => section.id === "geometry",
    );

    expect(geometry?.title).toBe("Size and position");
    expect(geometry?.rows[0]).toMatchObject({ label: "Width", value: "100px" });
    expect(geometry?.rows[1]).toMatchObject({ label: "Height", value: "50px" });
  });

  it("reads the fill colour in the selected format", () => {
    const rect = shape("rect", "rect", {
      selrect: { x: 0, y: 0, width: 10, height: 10 },
      "fill-color": "#ff0000",
      "fill-opacity": 0.5,
    });
    const fill = buildInspectSections([rect], contextFor({ rect })).find(
      (section) => section.id === "fill",
    );

    expect(fill?.title).toBe("Fill");
    expect(fill?.rows[0]).toMatchObject({
      kind: "color",
      label: "Background",
      value: "#FF0000",
      hint: "50%",
      swatch: "#ff000080",
    });
    expect(fill?.rows[0].copy).toContain("background");
  });

  it("lists the stroke style, width and colour", () => {
    const rect = shape("rect", "rect", {
      selrect: { x: 0, y: 0, width: 10, height: 10 },
      strokes: [
        {
          "stroke-color": "#000000",
          "stroke-opacity": 1,
          "stroke-width": 2,
          "stroke-style": "solid",
        },
      ],
    });
    const stroke = buildInspectSections([rect], contextFor({ rect })).find(
      (section) => section.id === "stroke",
    );

    expect(stroke?.rows.map((row) => row.label)).toEqual([
      "Border style",
      "Border width",
      "Border color",
    ]);
    expect(stroke?.rows[1].value).toBe("2px");
    expect(stroke?.rows[2]).toMatchObject({ value: "#000000", hint: "100%" });
  });

  it("turns a shadow into offsets plus a colour row", () => {
    const rect = shape("rect", "rect", {
      selrect: { x: 0, y: 0, width: 10, height: 10 },
      shadow: [
        {
          style: "drop-shadow",
          "offset-x": 0,
          "offset-y": 4,
          blur: 8,
          spread: 0,
          color: { color: "#000000", opacity: 0.25 },
        },
      ],
    });
    const shadow = buildInspectSections([rect], contextFor({ rect })).find(
      (section) => section.id === "shadow",
    );

    expect(shadow?.rows[0]).toMatchObject({
      kind: "shadow",
      label: "Drop shadow",
      value: "0px 4px 8px 0px",
      copy: "box-shadow: 0px 4px 8px 0px #00000040;",
    });
    expect(shadow?.rows[1]).toMatchObject({ kind: "color", value: "#000000", hint: "25%" });
  });

  it("prints the text rows and the run itself", () => {
    const text = shape("text", "text", {
      selrect: { x: 0, y: 0, width: 80, height: 24 },
      content: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                text: "Hello",
                "font-size": "24",
                "font-weight": "700",
                fills: [{ "fill-color": "#00ff00", "fill-opacity": 1 }],
              },
            ],
          },
        ],
      },
    });
    const sections = buildInspectSections([text], {
      ...contextFor({ text }),
      fontName: (fontId) => (fontId === "sourcesanspro" ? "Source Sans Pro" : undefined),
    });
    const typography = sections.find((section) => section.id === "text");

    expect(typography?.title).toBe("Typography");
    expect(typography?.rows[0]).toMatchObject({ kind: "color", value: "#00FF00" });
    expect(typography?.rows.find((row) => row.label === "Font Family")?.value).toBe(
      "Source Sans Pro",
    );
    expect(typography?.rows.find((row) => row.label === "Font Size")?.value).toBe("24px");
    expect(typography?.rows.find((row) => row.kind === "text")).toMatchObject({
      value: "Hello",
      copy: "Hello",
    });
  });

  it("groups the variant properties of the child components", () => {
    const container = shape("container", "frame", {
      "is-variant-container": true,
      shapes: ["s", "m"],
    });
    const objects: ViewerObjects = {
      container,
      s: shape("s", "frame", { "component-id": "c1", "parent-id": "container" }),
      m: shape("m", "frame", { "component-id": "c2", "parent-id": "container" }),
    };
    const components = {
      c1: { "variant-properties": [{ name: "Size", value: "S" }] },
      c2: {
        "variant-properties": [
          { name: "Size", value: "M" },
          { name: "Type", value: "Primary" },
        ],
      },
    };
    const variant = buildInspectSections([container], {
      ...contextFor(objects),
      components,
    })[0];

    expect(variant.id).toBe("variant");
    expect(variant.title).toBe("Variants properties");
    expect(variant.rows.map((row) => [row.label, row.value])).toEqual([
      ["Size", "S, M"],
      ["Type", "Primary"],
    ]);
  });
});
