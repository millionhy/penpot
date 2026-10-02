import { describe, expect, it } from "vitest";
import { resolveLegacyHash, resolveScreenQuery } from "@/lib/legacy-routes";

describe("resolveLegacyHash", () => {
  it("maps a legacy auth path", () => {
    expect(resolveLegacyHash("#/auth/login")).toBe("/auth/login");
  });

  it("keeps the query string", () => {
    expect(resolveLegacyHash("#/auth/recovery?token=abc")).toBe("/auth/recovery?token=abc");
  });

  it("turns a path parameter into a query parameter", () => {
    expect(resolveLegacyHash("#/render-sprite/6c9d1a2e")).toBe("/render-sprite?file-id=6c9d1a2e");
  });

  it("maps the viewer and the workspace", () => {
    expect(resolveLegacyHash("#/view")).toBe("/view");
    expect(resolveLegacyHash("#/workspace")).toBe("/workspace");
  });

  it("maps the dashboard sections", () => {
    expect(resolveLegacyHash("#/dashboard/recent")).toBe("/dashboard/recent");
    expect(resolveLegacyHash("#/dashboard/fonts/providers")).toBe("/dashboard/fonts/providers");
  });

  it("maps the settings sections", () => {
    expect(resolveLegacyHash("#/settings/profile")).toBe("/settings/profile");
    expect(resolveLegacyHash("#/settings/subscriptions")).toBe("/settings/subscriptions");
  });

  it("returns null for an unknown path", () => {
    expect(resolveLegacyHash("#/nope")).toBeNull();
  });

  it("returns null when the segment count differs", () => {
    expect(resolveLegacyHash("#/auth/login/extra")).toBeNull();
  });

  it("returns null for a non legacy hash", () => {
    expect(resolveLegacyHash("#section")).toBeNull();
    expect(resolveLegacyHash("")).toBeNull();
  });

  it("decodes an escaped path parameter", () => {
    expect(resolveLegacyHash("#/render-sprite/a%20b")).toBe("/render-sprite?file-id=a+b");
  });
});

describe("resolveScreenQuery", () => {
  it("maps a screen name to its path", () => {
    expect(resolveScreenQuery("?screen=auth-register")).toBe("/auth/register");
  });

  it("carries the remaining parameters over", () => {
    expect(resolveScreenQuery("?screen=dashboard-recent&team-id=t1")).toBe(
      "/dashboard/recent?team-id=t1",
    );
  });

  it("accepts a search string without the leading question mark", () => {
    expect(resolveScreenQuery("screen=viewer")).toBe("/view");
  });

  it("returns null for an unknown screen", () => {
    expect(resolveScreenQuery("?screen=nope")).toBeNull();
  });

  it("returns null without a screen parameter", () => {
    expect(resolveScreenQuery("?team-id=t1")).toBeNull();
    expect(resolveScreenQuery("")).toBeNull();
  });
});
