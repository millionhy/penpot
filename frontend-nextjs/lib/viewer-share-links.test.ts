import { describe, expect, it } from "vitest";

import {
  findShareLink,
  initialShareLinkDraft,
  isEveryPageSelected,
  prepareShareParams,
  samePages,
  shareLinkHref,
  toggleEveryPage,
  toggleSharePage,
  type ShareLink,
} from "@/lib/viewer-share-links";

// The pure helpers of the share dialog (app.main.ui.viewer.share-link):
// the initial options, the link seek, the page toggles and the href.

const PAGE_A = "11111111-1111-1111-1111-111111111111";
const PAGE_B = "22222222-2222-2222-2222-222222222222";
const PAGE_C = "33333333-3333-3333-3333-333333333333";
const SHARE_ID = "44444444-4444-4444-4444-444444444444";

function link(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: SHARE_ID,
    "who-comment": "team",
    "who-inspect": "team",
    pages: [PAGE_A],
    ...overrides,
  };
}

describe("initialShareLinkDraft", () => {
  it("starts on the current page with team-only policies", () => {
    expect(initialShareLinkDraft(PAGE_A)).toEqual({
      pages: [PAGE_A],
      whoComment: "team",
      whoInspect: "team",
    });
  });
});

describe("prepareShareParams", () => {
  it("sends pages, who-comment and who-inspect", () => {
    expect(
      prepareShareParams({ pages: [PAGE_A, PAGE_B], whoComment: "all", whoInspect: "team" }),
    ).toEqual({ pages: [PAGE_A, PAGE_B], "who-comment": "all", "who-inspect": "team" });
  });

  it("copies the page list", () => {
    const draft = { pages: [PAGE_A], whoComment: "team", whoInspect: "team" };
    const params = prepareShareParams(draft);
    expect(params.pages).not.toBe(draft.pages);
  });
});

describe("samePages", () => {
  it("compares by value, not order", () => {
    expect(samePages([PAGE_A, PAGE_B], [PAGE_B, PAGE_A])).toBe(true);
  });

  it("rejects a different length or a different id", () => {
    expect(samePages([PAGE_A], [PAGE_A, PAGE_B])).toBe(false);
    expect(samePages([PAGE_A], [PAGE_B])).toBe(false);
  });
});

describe("findShareLink", () => {
  it("matches the policies and the page set", () => {
    const stored = link({ pages: [PAGE_B, PAGE_A] });
    expect(
      findShareLink([stored], { pages: [PAGE_A, PAGE_B], whoComment: "team", whoInspect: "team" }),
    ).toBe(stored);
  });

  it("returns null when a policy differs", () => {
    expect(
      findShareLink([link()], { pages: [PAGE_A], whoComment: "all", whoInspect: "team" }),
    ).toBeNull();
  });

  it("returns null when the page set differs", () => {
    expect(
      findShareLink([link()], { pages: [PAGE_B], whoComment: "team", whoInspect: "team" }),
    ).toBeNull();
  });
});

describe("isEveryPageSelected", () => {
  it("is true only when the draft covers the file pages", () => {
    const draft = { pages: [PAGE_A, PAGE_B], whoComment: "team", whoInspect: "team" };
    expect(isEveryPageSelected(draft, [PAGE_B, PAGE_A])).toBe(true);
    expect(isEveryPageSelected(draft, [PAGE_A, PAGE_B, PAGE_C])).toBe(false);
    expect(isEveryPageSelected(draft, [])).toBe(false);
  });
});

describe("toggleEveryPage", () => {
  const pages = [PAGE_A, PAGE_B, PAGE_C];

  it("selects every page", () => {
    const draft = initialShareLinkDraft(PAGE_A);
    expect(toggleEveryPage(draft, pages, PAGE_A).pages).toEqual(pages);
  });

  it("returns to the current page when every page is selected", () => {
    const draft = { pages, whoComment: "all", whoInspect: "all" };
    expect(toggleEveryPage(draft, pages, PAGE_B)).toEqual({
      pages: [PAGE_B],
      whoComment: "all",
      whoInspect: "all",
    });
  });
});

describe("toggleSharePage", () => {
  it("adds and removes a page", () => {
    const draft = { pages: [PAGE_A, PAGE_B], whoComment: "team", whoInspect: "team" };
    expect(toggleSharePage(draft, PAGE_C, true).pages).toEqual([PAGE_A, PAGE_B, PAGE_C]);
    expect(toggleSharePage(draft, PAGE_B, false).pages).toEqual([PAGE_A]);
  });

  it("keeps the only current page checked", () => {
    const draft = initialShareLinkDraft(PAGE_A);
    expect(toggleSharePage(draft, PAGE_A, false)).toBe(draft);
  });

  it("keeps a single page checked", () => {
    const draft = { pages: [PAGE_B], whoComment: "team", whoInspect: "team" };
    expect(toggleSharePage(draft, PAGE_B, false)).toBe(draft);
  });

  it("ignores a page that is already checked", () => {
    const draft = { pages: [PAGE_A], whoComment: "team", whoInspect: "team" };
    expect(toggleSharePage(draft, PAGE_A, true).pages).toEqual([PAGE_A]);
  });
});

describe("shareLinkHref", () => {
  const query = { fileId: "f1", pageId: PAGE_C, section: "comments" as string | null };

  it("uses the share id and the first file page the link carries", () => {
    const href = shareLinkHref(link({ pages: [PAGE_B, PAGE_A] }), query, [PAGE_A, PAGE_B], null);
    expect(href).toBe(
      "/view?file-id=f1&page-id=" + PAGE_A + "&share-id=" + SHARE_ID + "&index=0&section=comments",
    );
  });

  it("keeps the zoom style only when it is set", () => {
    expect(shareLinkHref(link(), query, [PAGE_A], "fit")).toContain("zoom=fit");
    expect(shareLinkHref(link(), query, [PAGE_A], null)).not.toContain("zoom=");
  });

  it("drops the page id when the link carries no file page", () => {
    const href = shareLinkHref(link({ pages: [PAGE_C] }), query, [PAGE_A], null);
    expect(href).not.toContain("page-id=");
    expect(href).toContain("share-id=" + SHARE_ID);
  });
});
