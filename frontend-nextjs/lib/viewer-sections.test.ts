import { describe, expect, it } from "vitest";

import {
  canAccessSection,
  canShowCommentsButton,
  canShowInspectButton,
  isViewerSection,
  requiresLogin,
  resolveViewerSection,
} from "@/lib/viewer-sections";

// The section gate of the viewer: the header visibility formulas and the
// viewer-content* allowed predicate, ported verbatim from the CLJS.

const MEMBERSHIP = {
  type: "membership",
  "is-owner": false,
  "is-admin": false,
  "can-edit": false,
  "can-read": true,
  "is-logged": true,
};

const SHARE_LINK = {
  type: "share-link",
  pages: ["p1"],
  "is-logged": true,
  "who-comment": "team",
  "who-inspect": "team",
};

describe("isViewerSection", () => {
  it("accepts the three section names and nothing else", () => {
    expect(isViewerSection("interactions")).toBe(true);
    expect(isViewerSection("comments")).toBe(true);
    expect(isViewerSection("inspect")).toBe(true);
    expect(isViewerSection("dashboard")).toBe(false);
    expect(isViewerSection(null)).toBe(false);
  });
});

describe("canShowCommentsButton", () => {
  it("shows for a team member", () => {
    expect(canShowCommentsButton({ "in-team": true })).toBe(true);
  });

  it("shows for a share-link open to every commenter", () => {
    expect(canShowCommentsButton({ type: "share-link", "who-comment": "all" })).toBe(true);
  });

  it("hides without in-team and with a team-only policy", () => {
    expect(canShowCommentsButton(SHARE_LINK)).toBe(false);
  });
});

describe("canShowInspectButton", () => {
  it("shows for a team member", () => {
    expect(canShowInspectButton({ "in-team": true })).toBe(true);
  });

  it("shows for a share-link open to every viewer", () => {
    expect(canShowInspectButton({ type: "share-link", "who-inspect": "all" })).toBe(true);
  });

  it("hides for a membership without in-team", () => {
    expect(canShowInspectButton({ ...MEMBERSHIP, "who-inspect": "all" })).toBe(false);
  });
});

describe("canAccessSection", () => {
  it("always allows interactions", () => {
    expect(canAccessSection("interactions", {})).toBe(true);
  });

  it("allows a comment editor", () => {
    expect(canAccessSection("comments", { ...MEMBERSHIP, "can-edit": true })).toBe(true);
  });

  it("requires a session and the all policy for a share-link", () => {
    expect(canAccessSection("comments", { ...SHARE_LINK, "who-comment": "all" })).toBe(true);
    expect(canAccessSection("comments", SHARE_LINK)).toBe(false);
    expect(
      canAccessSection("comments", { ...SHARE_LINK, "is-logged": false, "who-comment": "all" }),
    ).toBe(false);
  });

  it("gates inspect on who-inspect", () => {
    expect(canAccessSection("inspect", { ...SHARE_LINK, "who-inspect": "all" })).toBe(true);
    expect(canAccessSection("inspect", SHARE_LINK)).toBe(false);
  });

  it("keeps the CLJS disagreement: in-team alone does not allow comments", () => {
    expect(canAccessSection("comments", { "in-team": true, "is-logged": true })).toBe(false);
  });
});

describe("resolveViewerSection", () => {
  it("falls back to interactions for an unknown value", () => {
    expect(resolveViewerSection("nope", {})).toBe("interactions");
    expect(resolveViewerSection(null, {})).toBe("interactions");
  });

  it("keeps an allowed section", () => {
    expect(resolveViewerSection("comments", { ...MEMBERSHIP, "can-edit": true })).toBe(
      "comments",
    );
  });

  it("keeps an allowed inspect section", () => {
    expect(resolveViewerSection("inspect", { ...SHARE_LINK, "who-inspect": "all" })).toBe(
      "inspect",
    );
  });

  it("falls back when the section is not allowed", () => {
    expect(resolveViewerSection("comments", SHARE_LINK)).toBe("interactions");
    expect(resolveViewerSection("inspect", SHARE_LINK)).toBe("interactions");
  });
});

describe("requiresLogin", () => {
  it("never asks for a session on interactions", () => {
    expect(requiresLogin("interactions", {})).toBe(false);
  });

  it("asks for a session when the visitor is anonymous", () => {
    expect(requiresLogin("comments", { "is-logged": false })).toBe(true);
    expect(requiresLogin("comments", { "is-logged": true })).toBe(false);
  });
});
