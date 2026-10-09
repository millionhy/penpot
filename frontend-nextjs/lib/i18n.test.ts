import { describe, expect, it } from "vitest";
import { format, richSegments, tr } from "@/lib/i18n";

describe("format", () => {
  it("substitutes %s from left to right", () => {
    expect(format("%s then %s", ["a", "b"])).toBe("a then b");
  });

  it("leaves a placeholder alone when the argument is missing", () => {
    expect(format("%s then %s", ["a"])).toBe("a then %s");
  });

  it("renders null and undefined as an empty string", () => {
    expect(format("[%s|%s]", [null, undefined])).toBe("[|]");
  });

  it("stringifies numbers", () => {
    expect(format("%s minutes", [5])).toBe("5 minutes");
  });
});

describe("tr", () => {
  it("returns the catalog entry", () => {
    expect(tr("auth.check-email")).toBe("Check your email!");
  });

  it("falls back to the key when the catalog has no entry", () => {
    expect(tr("definitely.not-a-key")).toBe("definitely.not-a-key");
  });

  it("substitutes arguments into the message", () => {
    expect(tr("errors.field-max-length", 250)).toBe("Must contain at most 250 characters.");
  });

  it("keeps the backend-provided weak password reasons", () => {
    expect(tr("errors.weak-password.too-short")).not.toBe("errors.weak-password.too-short");
  });
});

describe("richSegments", () => {
  it("turns [label](url) into a link segment", () => {
    expect(richSegments("a [b](https://example.com) c")).toEqual([
      { text: "a " },
      { text: "b", href: "https://example.com" },
      { text: " c" },
    ]);
  });

  it("keeps plain text as a single segment", () => {
    expect(richSegments("no links here")).toEqual([{ text: "no links here" }]);
  });

  it("turns **text** into a bold segment", () => {
    expect(richSegments("a **b** c")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c" },
    ]);
  });

  it("handles a bold run next to a link", () => {
    expect(richSegments("**single family** and [terms](https://tos)")).toEqual([
      { text: "single family", bold: true },
      { text: " and " },
      { text: "terms", href: "https://tos" },
    ]);
  });

  it("resolves the terms agreement into two links", () => {
    const segments = richSegments(
      tr("auth.terms-and-privacy-agreement", "https://tos", "https://privacy"),
    );
    expect(segments.filter((segment) => segment.href !== undefined)).toHaveLength(2);
  });
});
