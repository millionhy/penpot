// Tests for lib/templates.ts (F5.6): the builtin-template filtering, the
// thumbnail URL and the collapsed-flag storage round trip.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuiltinTemplate } from "@/lib/binfile";
import {
  TEMPLATES_STORAGE_KEY,
  TEMPLATES_STORAGE_NS,
  readTemplatesCollapsed,
  templateThumbnailUrl,
  visibleTemplates,
  writeTemplatesCollapsed,
} from "@/lib/templates";
import { decodeTransit, encodeTransit } from "@/lib/transit";

function template(id: string, name = id): BuiltinTemplate {
  return { id, name };
}

describe("visibleTemplates", () => {
  it("drops the onboarding templates", () => {
    const rows = [
      template("welcome"),
      template("tutorial-for-beginners"),
      template("kanban"),
    ];
    expect(visibleTemplates(rows)).toEqual([template("kanban")]);
  });

  it("keeps the order and handles an empty list", () => {
    expect(visibleTemplates([])).toEqual([]);
    expect(visibleTemplates([template("a"), template("b")])).toEqual([
      template("a"),
      template("b"),
    ]);
  });
});

describe("templateThumbnailUrl", () => {
  it("joins the public uri with the thumbnail path", () => {
    expect(templateThumbnailUrl("https://penpot.example", "kanban")).toBe(
      "https://penpot.example/images/thumbnails/template-kanban.jpg",
    );
  });

  it("never doubles the trailing slash", () => {
    expect(templateThumbnailUrl("https://penpot.example/", "kanban")).toBe(
      "https://penpot.example/images/thumbnails/template-kanban.jpg",
    );
    expect(templateThumbnailUrl("", "kanban")).toBe(
      "/images/thumbnails/template-kanban.jpg",
    );
  });
});

describe("templates collapsed storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the CLJS namespace and key for cross-tab agreement", () => {
    expect(TEMPLATES_STORAGE_NS).toBe("app.main.ui.dashboard.templates");
    expect(TEMPLATES_STORAGE_KEY).toBe("collapsed");
  });

  it("defaults to expanded without a browser storage", () => {
    expect(readTemplatesCollapsed()).toBe(false);
  });

  it("round-trips the flag under the CLJS storage key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });

    writeTemplatesCollapsed(true);
    const key = "penpot-global:" + TEMPLATES_STORAGE_NS + "/" + TEMPLATES_STORAGE_KEY;
    expect(store.has(key)).toBe(true);
    expect(decodeTransit(store.get(key) ?? "")).toBe(true);
    expect(readTemplatesCollapsed()).toBe(true);

    writeTemplatesCollapsed(false);
    expect(readTemplatesCollapsed()).toBe(false);

    // A non-boolean entry reads as expanded (only true collapses).
    store.set(key, encodeTransit("yes"));
    expect(readTemplatesCollapsed()).toBe(false);
  });
});
