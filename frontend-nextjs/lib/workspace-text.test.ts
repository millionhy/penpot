// Unit tests for the text model (lib/workspace-text): the default attrs of
// text.cljc, the change-text content tree, the plain-text reader and the
// measured box of a committed edition. All pure: no wasm, no store.

import { describe, expect, it } from "vitest";

import {
  TEXT_CLICK_HEIGHT,
  TEXT_CLICK_WIDTH,
  TEXT_DEFAULT_ATTRS,
  TEXT_DEFAULT_FILLS,
  TEXT_FONT_SIZE,
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_LINE_HEIGHT,
  TEXT_MIXED,
  TEXT_NODE_ATTRS,
  TEXT_SPACING_MAX,
  TEXT_SPACING_MIN,
  createTextContent,
  getTextAttrs,
  measureTextRect,
  setTextAttrs,
  textEditAttrs,
  textPlainText,
  type TextAttrs,
} from "@/lib/workspace-text";

describe("TEXT_DEFAULT_ATTRS", () => {
  it("carries the sourcesanspro defaults of default-text-attrs", () => {
    expect(TEXT_DEFAULT_ATTRS).toMatchObject({
      "font-id": "sourcesanspro",
      "font-family": "sourcesanspro",
      "font-variant-id": "regular",
      "font-size": "14",
      "font-weight": "400",
      "font-style": "normal",
      "line-height": "1.2",
      "letter-spacing": "0",
      "text-transform": "none",
      "text-align": "left",
      "text-decoration": "none",
      "text-direction": "ltr",
    });
  });

  it("carries the black default fill", () => {
    expect(TEXT_DEFAULT_FILLS).toEqual([{ "fill-color": "#000000", "fill-opacity": 1 }]);
  });

  it("counts the numeric font size and line height of the string attrs", () => {
    expect(TEXT_FONT_SIZE).toBe(14);
    expect(TEXT_LINE_HEIGHT).toBe(1.2);
  });
});

describe("createTextContent", () => {
  it("builds root -> paragraph-set -> paragraph -> text", () => {
    expect(createTextContent("hello")).toEqual({
      type: "root",
      "vertical-align": "top",
      children: [
        {
          type: "paragraph-set",
          children: [
            {
              type: "paragraph",
              "text-align": "left",
              "text-direction": "ltr",
              ...TEXT_DEFAULT_ATTRS,
              children: [{ text: "hello", ...TEXT_DEFAULT_ATTRS }],
            },
          ],
        },
      ],
    });
  });

  it("splits one paragraph per line", () => {
    const content = createTextContent("one\ntwo\nthree");
    const set = (content.children as Array<{ children: unknown[] }>)[0];
    const lines = set.children.map((paragraph) => {
      const nodes = (paragraph as { children: Array<{ text: string }> }).children;
      return nodes[0].text;
    });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("keeps a blank text as one empty paragraph", () => {
    const content = createTextContent("");
    const set = (content.children as Array<{ children: unknown[] }>)[0];
    expect(set.children.length).toBe(1);
  });
});

describe("textPlainText", () => {
  it("joins the paragraphs with newlines", () => {
    expect(textPlainText(createTextContent("a\nb"))).toBe("a\nb");
  });

  it("answers an empty string for a missing or malformed content", () => {
    expect(textPlainText(null)).toBe("");
    expect(textPlainText("text")).toBe("");
    expect(textPlainText({})).toBe("");
    expect(textPlainText({ children: "nope" })).toBe("");
    expect(textPlainText({ children: [null, { children: 1 }] })).toBe("");
  });

  it("skips nodes without a text value", () => {
    const content = {
      children: [
        {
          children: [
            {
              children: [{ text: "a" }, null, { text: 3 }, { text: "b" }],
            },
          ],
        },
      ],
    };
    expect(textPlainText(content)).toBe("ab");
  });
});

describe("measureTextRect", () => {
  it("keeps the click box of the CLJS for a blank text", () => {
    expect(measureTextRect("", 10, 20)).toEqual({
      x: 10,
      y: 20,
      width: TEXT_CLICK_WIDTH,
      height: TEXT_CLICK_HEIGHT,
    });
  });

  it("widens by the longest line and grows by the line count", () => {
    expect(measureTextRect("abcd\na", 0, 0)).toMatchObject({
      x: 0,
      y: 0,
      width: 4 * TEXT_FONT_SIZE * 0.55,
      height: 2 * 16.8,
    });
    expect(measureTextRect("a\nb", 0, 0).height).toBeCloseTo(2 * 16.8);
    expect(measureTextRect("a", 0, 0).height).toBe(TEXT_CLICK_HEIGHT);
    expect(measureTextRect("a\nb\nc", 0, 0).height).toBeCloseTo(3 * 16.8);
    expect(measureTextRect("a".repeat(20), 0, 0).width).toBeCloseTo(20 * 7.7);
  });

  it("counts code points, so a surrogate pair counts once", () => {
    expect(measureTextRect("\u{1F44D}\u{1F44D}", 0, 0).width).toBeCloseTo(2 * 7.7);
  });
});

describe("textEditAttrs", () => {
  it("packs the content and the measured box of setup-rect", () => {
    const attrs = textEditAttrs("hi", 5, 6);
    const width = 2 * TEXT_FONT_SIZE * 0.55;
    const height = TEXT_CLICK_HEIGHT;
    expect(attrs).toMatchObject({
      width,
      height,
      selrect: { x: 5, y: 6, width, height, x1: 5, y1: 6, x2: 5 + width, y2: 6 + height },
      points: [
        { x: 5, y: 6 },
        { x: 5 + width, y: 6 },
        { x: 5 + width, y: 6 + height },
        { x: 5, y: 6 + height },
      ],
    });
    expect(textPlainText(attrs.content)).toBe("hi");
  });
});

// Build a content tree from paragraphs, each with per-paragraph attrs and one
// text node carrying per-node attrs, so a test can make two levels diverge.
function styledParagraph(
  text: string,
  paragraphAttrs: Record<string, unknown> = {},
  nodeAttrs: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "paragraph",
    ...paragraphAttrs,
    children: [{ text, ...nodeAttrs }],
  };
}

function styledRoot(
  paragraphs: Array<Record<string, unknown>>,
  rootAttrs: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "root",
    ...rootAttrs,
    children: [{ type: "paragraph-set", children: paragraphs }],
  };
}

function firstNode(content: unknown): Record<string, unknown> {
  const set = (content as { children: Array<{ children: unknown[] }> }).children[0];
  const paragraph = set.children[0] as { children: Array<Record<string, unknown>> };
  return paragraph.children[0];
}

function firstParagraph(content: unknown): Record<string, unknown> {
  const set = (content as { children: Array<{ children: unknown[] }> }).children[0];
  return set.children[0] as Record<string, unknown>;
}

describe("getTextAttrs", () => {
  it("reads the sourcesanspro defaults createTextContent writes", () => {
    const attrs = getTextAttrs(createTextContent("hello"));
    expect(attrs["font-id"]).toBe("sourcesanspro");
    expect(attrs["font-size"]).toBe("14");
    expect(attrs["line-height"]).toBe("1.2");
    expect(attrs["text-align"]).toBe("left");
    // createTextContent stores no fills, so the color row falls back here.
    expect(attrs["fills"]).toBeUndefined();
  });

  it("reports the shared value across every paragraph and node", () => {
    const content = styledRoot([
      styledParagraph("a", { "font-size": "20" }, { "font-size": "20" }),
      styledParagraph("b", { "font-size": "20" }, { "font-size": "20" }),
    ]);
    expect(getTextAttrs(content)["font-size"]).toBe("20");
  });

  it("returns the mixed sentinel when two nodes disagree on a key", () => {
    const content = styledRoot([
      styledParagraph("a", {}, { "font-size": "14" }),
      styledParagraph("b", {}, { "font-size": "20" }),
    ]);
    expect(getTextAttrs(content)["font-size"]).toBe(TEXT_MIXED);
  });

  it("reads text-align off the paragraph, so a span default does not force mixed", () => {
    const content = styledRoot([
      styledParagraph("a", { "text-align": "center" }, { "text-align": "left" }),
    ]);
    expect(getTextAttrs(content)["text-align"]).toBe("center");
  });

  it("treats a numeric value and its string form as one value", () => {
    const content = styledRoot([
      styledParagraph("a", {}, { "font-size": 14 }),
      styledParagraph("b", {}, { "font-size": "14" }),
    ]);
    expect(getTextAttrs(content)["font-size"]).toBe("14");
  });

  it("answers an empty object for a missing or malformed content", () => {
    expect(getTextAttrs(null)).toEqual({});
    expect(getTextAttrs("text")).toEqual({});
    expect(getTextAttrs({})).toEqual({});
  });
});

describe("setTextAttrs", () => {
  it("fans the value out to every paragraph and text node", () => {
    const next = setTextAttrs(createTextContent("a\nb"), {
      "font-size": "20",
      "text-align": "center",
    });
    expect(getTextAttrs(next)["font-size"]).toBe("20");
    expect(getTextAttrs(next)["text-align"]).toBe("center");
    expect(firstNode(next)["font-size"]).toBe("20");
    expect(firstParagraph(next)["text-align"]).toBe("center");
  });

  it("is round-trip stable: get, set what you read, get again", () => {
    const base = createTextContent("x");
    const once = setTextAttrs(base, { "letter-spacing": "2", "line-height": "1.5" });
    const read = getTextAttrs(once);
    const twice = setTextAttrs(once, read);
    expect(getTextAttrs(twice)).toEqual(read);
  });

  it("writes fills to the text nodes and not the paragraph", () => {
    const fills = [{ "fill-color": "#ff0000", "fill-opacity": 1 }];
    const next = setTextAttrs(createTextContent("f"), { fills });
    expect(firstNode(next)["fills"]).toEqual(fills);
    expect(firstParagraph(next)["fills"]).toBeUndefined();
    expect(getTextAttrs(next)["fills"]).toEqual(fills);
  });

  it("drops keys outside the ported subset", () => {
    const stray = { "vertical-align": "middle", growtype: "yes" } as unknown as TextAttrs;
    const next = setTextAttrs(createTextContent("z"), stray);
    expect(firstNode(next)["vertical-align"]).toBeUndefined();
    expect(firstNode(next)["growtype"]).toBeUndefined();
    // The root keeps its default; nothing in the subset was touched.
    expect((next as Record<string, unknown>)["vertical-align"]).toBe("top");
    expect(getTextAttrs(next)["font-size"]).toBe("14");
  });

  it("never commits the mixed sentinel back", () => {
    const next = setTextAttrs(createTextContent("m"), { "font-size": TEXT_MIXED });
    expect(firstNode(next)["font-size"]).toBe("14");
  });

  it("returns a non-object content untouched", () => {
    expect(setTextAttrs(null, { "font-size": "20" })).toBe(null);
    expect(setTextAttrs("text", { "font-size": "20" })).toBe("text");
  });
});

describe("the D4 attr surface", () => {
  it("exposes the eight target controls as the ported subset", () => {
    expect(TEXT_NODE_ATTRS).toContain("font-id");
    expect(TEXT_NODE_ATTRS).toContain("text-align");
    expect(TEXT_NODE_ATTRS).toContain("fills");
    expect(TEXT_NODE_ATTRS).not.toContain("text-decoration");
    expect(TEXT_NODE_ATTRS).not.toContain("vertical-align");
  });

  it("carries the font-size and spacing bounds of text.cljc", () => {
    expect(TEXT_FONT_SIZE_MIN).toBe(3);
    expect(TEXT_FONT_SIZE_MAX).toBe(1000);
    expect(TEXT_SPACING_MIN).toBe(-200);
    expect(TEXT_SPACING_MAX).toBe(200);
  });
});
