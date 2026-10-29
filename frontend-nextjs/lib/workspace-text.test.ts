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
  TEXT_LINE_HEIGHT,
  createTextContent,
  measureTextRect,
  textEditAttrs,
  textPlainText,
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
