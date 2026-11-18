import { describe, expect, it } from "vitest";
import {
  RELEASE_NOTES_INTRO,
  RELEASE_NOTES_SLIDES,
  mainVersion,
  releaseNotesContentVersion,
  shouldShowReleaseNotes,
} from "@/lib/release-notes";

const flags = ["onboarding"];

function gate(overrides: Partial<Parameters<typeof shouldShowReleaseNotes>[0]> = {}) {
  return shouldShowReleaseNotes({
    version: "2.18.0",
    props: { "onboarding-viewed": true, "release-notes-viewed": "2.17" },
    flags,
    nitrateEntryActive: false,
    ...overrides,
  });
}

describe("mainVersion", () => {
  it("keeps major.minor like v/parse :main", () => {
    expect(mainVersion("2.18.0")).toBe("2.18");
    expect(mainVersion("2.18")).toBe("2.18");
    expect(mainVersion("2.9.3-rc1")).toBe("2.9");
    expect(mainVersion("3.0.0")).toBe("3.0");
  });

  it("maps develop and unparseable stamps to 0.0", () => {
    expect(mainVersion("develop")).toBe("0.0");
    expect(mainVersion(null)).toBe("0.0");
  });
});

describe("releaseNotesContentVersion", () => {
  it("resolves the registered 2.18 content", () => {
    expect(releaseNotesContentVersion("2.18.0")).toBe("2.18");
    expect(releaseNotesContentVersion("2.18")).toBe("2.18");
  });

  it("aliases the 0.0 development version to the newest content", () => {
    expect(releaseNotesContentVersion("0.0")).toBe("2.18");
    expect(releaseNotesContentVersion("develop")).toBe("2.18");
  });

  it("answers null for a release without content", () => {
    expect(releaseNotesContentVersion("2.17.0")).toBeNull();
    expect(releaseNotesContentVersion("2.19.0")).toBeNull();
  });
});

describe("shouldShowReleaseNotes", () => {
  it("opens when the onboarding is done and the running release is unseen", () => {
    expect(gate()).toBe(true);
  });

  it("needs the onboarding flag", () => {
    expect(gate({ flags: [] })).toBe(false);
  });

  it("honours hide-release-modal", () => {
    expect(gate({ flags: ["onboarding", "hide-release-modal"] })).toBe(false);
  });

  it("yields to a pending nitrate entry", () => {
    expect(gate({ nitrateEntryActive: true })).toBe(false);
  });

  it("waits for onboarding-viewed", () => {
    expect(gate({ props: { "release-notes-viewed": "2.17" } })).toBe(false);
  });

  it("stays closed once this release is stamped", () => {
    expect(gate({ props: { "onboarding-viewed": true, "release-notes-viewed": "2.18" } })).toBe(
      false,
    );
  });

  it("never auto-opens on a development or missing version", () => {
    expect(gate({ version: "0.0" })).toBe(false);
    expect(gate({ version: "develop" })).toBe(false);
    expect(gate({ version: null })).toBe(false);
  });
});

describe("2.18 content", () => {
  it("carries the intro and six slides of v2_18.cljs", () => {
    expect(RELEASE_NOTES_INTRO.title).toBe("What’s new in Penpot?");
    expect(RELEASE_NOTES_SLIDES).toHaveLength(6);
    expect(RELEASE_NOTES_SLIDES[0].title).toBe("Introducing Penpot Enterprise");
    expect(RELEASE_NOTES_SLIDES[5].title).toBe("Stroke to Paths and new drawing tools");
    expect(RELEASE_NOTES_SLIDES[5].paragraphs).toHaveLength(5);
  });

  it("serves every image from the copied features folder", () => {
    const slides = [RELEASE_NOTES_INTRO, ...RELEASE_NOTES_SLIDES];
    for (const slide of slides) {
      expect(slide.image.startsWith("/images/features/2.18-")).toBe(true);
      expect(slide.alt.length).toBeGreaterThan(0);
      expect(slide.paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of slide.paragraphs) {
        expect(paragraph.length).toBeGreaterThan(0);
      }
    }
    expect(new Set(slides.map((slide) => slide.image)).size).toBe(slides.length);
  });
});
