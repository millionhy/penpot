import { describe, expect, it } from "vitest";
import {
  classifyUpdateCheck,
  highlightsUntilInstalled,
  parseHighlightItem,
  parseHighlights,
  parseLatestReleasedVersion,
  versionNewer,
} from "@/lib/check-updates";

const CHANGES = [
  "## Unreleased",
  "",
  "### :rocket: Epics and highlights",
  "- future stuff",
  "",
  "## 2.19.0",
  "",
  "### :rocket: Epics and highlights",
  "- New **tokens** panel",
  "- See [the docs](https://help.penpot.app/tokens)",
  "- Not a link [bad](ftp://x)",
  "",
  "### :bug: Bug fixes",
  "- fixed things",
  "",
  "## 2.18.2",
  "",
  "### :bug: Bug fixes",
  "- only fixes here",
  "",
  "## 2.18.0",
  "",
  "### :rocket: Epics and highlights",
  "- older highlight",
  "",
].join("\n");

describe("versionNewer", () => {
  it("compares on (major, minor, patch)", () => {
    expect(versionNewer("2.19.0", "2.18.2")).toBe(true);
    expect(versionNewer("2.18.2", "2.19.0")).toBe(false);
    expect(versionNewer("2.18.0", "2.18.0")).toBe(false);
    expect(versionNewer("3.0.0", "2.99.99")).toBe(true);
  });

  it("treats unparseable versions as 0.0.0", () => {
    expect(versionNewer("develop", "0.0.0")).toBe(false);
    expect(versionNewer("1.0.0", "develop")).toBe(true);
  });

  it("accepts suffixed installed versions like the CLJS version-re", () => {
    expect(versionNewer("2.19.0", "2.18.0-rc1")).toBe(true);
    expect(versionNewer("2.18.0", "2.18.0-rc1")).toBe(false);
  });
});

describe("parseLatestReleasedVersion", () => {
  it("skips unreleased headings", () => {
    expect(parseLatestReleasedVersion(CHANGES)).toBe("2.19.0");
    expect(parseLatestReleasedVersion("## Unreleased\n- x")).toBeNull();
    expect(parseLatestReleasedVersion(null)).toBeNull();
  });
});

describe("parseHighlights", () => {
  it("keeps released sections that have rocket bullets", () => {
    const sections = parseHighlights(CHANGES);
    expect(sections.map((section) => section.version)).toEqual(["2.19.0", "2.18.0"]);
    expect(sections[0].items).toHaveLength(3);
    expect(parseHighlights(null)).toEqual([]);
    expect(parseHighlights("no headings")).toEqual([]);
  });

  it("stops the section at the next heading", () => {
    const sections = parseHighlights(CHANGES);
    expect(sections[0].items.join(" ")).not.toContain("fixed things");
  });
});

describe("highlightsUntilInstalled", () => {
  it("keeps only the sections newer than the installed one", () => {
    const sections = parseHighlights(CHANGES);
    expect(highlightsUntilInstalled(sections, "2.18.2").map((s) => s.version)).toEqual(["2.19.0"]);
    expect(highlightsUntilInstalled(sections, "2.19.0")).toEqual([]);
    expect(highlightsUntilInstalled(sections, "1.0.0").map((s) => s.version)).toEqual([
      "2.19.0",
      "2.18.0",
    ]);
  });
});

describe("parseHighlightItem", () => {
  it("splits links, bold and plain text", () => {
    expect(parseHighlightItem("New **tokens** panel")).toEqual([
      { type: "text", text: "New " },
      { type: "bold", text: "tokens" },
      { type: "text", text: " panel" },
    ]);
    expect(parseHighlightItem("See [the docs](https://help.penpot.app/tokens)")).toEqual([
      { type: "text", text: "See " },
      { type: "link", text: "the docs", href: "https://help.penpot.app/tokens" },
    ]);
  });

  it("degrades non-http links and empty input", () => {
    expect(parseHighlightItem("Not a link [bad](ftp://x)")).toEqual([
      { type: "text", text: "Not a link " },
      { type: "text", text: "[bad](ftp://x)" },
    ]);
    expect(parseHighlightItem("")).toEqual([]);
    expect(parseHighlightItem(null)).toEqual([]);
  });
});

describe("classifyUpdateCheck", () => {
  it("reports available with the newer highlights", () => {
    const result = classifyUpdateCheck("2.18.2", CHANGES);
    expect(result).toEqual({
      kind: "available",
      installed: "2.18.2",
      latest: "2.19.0",
      highlights: [
        {
          version: "2.19.0",
          items: [
            "New **tokens** panel",
            "See [the docs](https://help.penpot.app/tokens)",
            "Not a link [bad](ftp://x)",
          ],
        },
      ],
    });
  });

  it("reports uptodate when nothing is newer", () => {
    expect(classifyUpdateCheck("2.19.0", CHANGES)).toEqual({ kind: "uptodate", version: "2.19.0" });
    expect(classifyUpdateCheck("9.9.9", CHANGES)).toEqual({ kind: "uptodate", version: "9.9.9" });
  });

  it("reports unable without a parseable changelog", () => {
    expect(classifyUpdateCheck("2.18.0", null)).toEqual({ kind: "unable" });
    expect(classifyUpdateCheck("2.18.0", "garbage")).toEqual({ kind: "unable" });
  });
});
