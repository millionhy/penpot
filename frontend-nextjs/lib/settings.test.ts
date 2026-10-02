import { describe, expect, it } from "vitest";
import { initials } from "@/lib/avatars";
import { config } from "@/lib/config";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import {
  defaultNotificationSettings,
  feedbackError,
  feedbackVisible,
  localeOptions,
  notificationsFromProfile,
  passwordError,
  passwordParams,
  profilePhotoUrl,
  profileUpdateParams,
  rendererFromProfile,
  resolveTheme,
  settingsNav,
  supportedLocales,
  themeClass,
  themeFormValue,
  type RuntimeProfile,
} from "@/lib/settings";

function rpc(code: string, extra: Record<string, unknown> = {}) {
  return new RpcError("http error", { type: "validation", code, ...extra });
}

function profile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: "p1",
    fullname: "Ada Lovelace",
    email: "ada@example.com",
    ...overrides,
  };
}

describe("resolveTheme", () => {
  it("follows the system preference for 'system'", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });

  it("treats 'default' and an unset theme as dark", () => {
    expect(resolveTheme("default", "light")).toBe("dark");
    expect(resolveTheme(undefined, "light")).toBe("dark");
    expect(resolveTheme(null, "light")).toBe("dark");
  });

  it("passes an explicit theme through", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("maps the resolved theme onto the token class", () => {
    expect(themeClass("dark")).toBe("default");
    expect(themeClass("light")).toBe("light");
  });
});

describe("themeFormValue", () => {
  it("normalizes the stored value for the select", () => {
    expect(themeFormValue("default")).toBe("dark");
    expect(themeFormValue(undefined)).toBe("dark");
    expect(themeFormValue("light")).toBe("light");
    expect(themeFormValue("system")).toBe("system");
  });
});

describe("notificationsFromProfile", () => {
  it("falls back to the defaults", () => {
    expect(notificationsFromProfile(null)).toEqual(defaultNotificationSettings);
    expect(notificationsFromProfile(profile())).toEqual(defaultNotificationSettings);
  });

  it("reads the stored props", () => {
    const stored = profile({
      props: {
        notifications: {
          "dashboard-comments": "none",
          "email-comments": "all",
          "email-invites": "none",
        },
      },
    });
    expect(notificationsFromProfile(stored)).toEqual({
      "dashboard-comments": "none",
      "email-comments": "all",
      "email-invites": "none",
    });
  });
});

describe("rendererFromProfile", () => {
  it("defaults to svg", () => {
    expect(rendererFromProfile(null)).toBe("svg");
    expect(rendererFromProfile(profile())).toBe("svg");
  });

  it("reads the wasm prop", () => {
    expect(rendererFromProfile(profile({ props: { renderer: "wasm" } }))).toBe("wasm");
  });
});

describe("profileUpdateParams", () => {
  it("carries only fullname, lang and theme", () => {
    expect(profileUpdateParams({ fullname: "Ada" })).toEqual({ fullname: "Ada" });
    expect(profileUpdateParams({ fullname: "Ada", lang: "", theme: "dark" })).toEqual({
      fullname: "Ada",
      lang: "",
      theme: "dark",
    });
  });
});

describe("passwordParams", () => {
  it("renames the form fields onto the backend schema", () => {
    expect(passwordParams({ "password-old": "old", "password-1": "new" })).toEqual({
      "old-password": "old",
      password: "new",
    });
  });
});

describe("passwordError", () => {
  it("maps a wrong old password onto its field", () => {
    expect(passwordError(rpc("old-password-not-match"))).toEqual({
      kind: "field",
      field: "password-old",
      message: tr("errors.wrong-old-password"),
    });
  });

  it("maps the email reused as password onto password-1", () => {
    expect(passwordError(rpc("email-as-password"))).toEqual({
      kind: "field",
      field: "password-1",
      message: tr("errors.email-as-password"),
    });
  });

  it("lists the weak-password reasons under password-1", () => {
    const err = rpc("weak-password", {
      details: ["errors.weak-password.too-short", "errors.weak-password.insufficient-digits"],
    });
    const mapped = passwordError(err);
    expect(mapped.kind).toBe("field");
    if (mapped.kind !== "field") return;
    expect(mapped.field).toBe("password-1");
    const lines = mapped.message.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(tr("errors.weak-password"));
  });

  it("keeps the bare message when the backend sends no details", () => {
    const mapped = passwordError(rpc("weak-password"));
    expect(mapped.kind).toBe("field");
    if (mapped.kind !== "field") return;
    expect(mapped.message).toBe(tr("errors.weak-password"));
  });

  it("falls back to a toast for anything else", () => {
    expect(passwordError(rpc("something-else"))).toEqual({ kind: "generic" });
    expect(passwordError(new Error("boom"))).toEqual({ kind: "generic" });
  });
});

describe("feedbackError", () => {
  it("reports a disabled feedback form", () => {
    expect(feedbackError(rpc("feedback-disabled"))).toBe(tr("labels.feedback-disabled"));
  });

  it("falls back to the generic error", () => {
    expect(feedbackError(rpc("other"))).toBe(tr("errors.generic"));
    expect(feedbackError(new Error("boom"))).toBe(tr("errors.generic"));
  });
});

describe("settingsNav", () => {
  it("lists the default entries in the CLJS order", () => {
    expect(settingsNav(config.flags).map((item) => item.route)).toEqual([
      "settings-profile",
      "settings-password",
      "settings-notifications",
      "settings-shortcuts",
      "settings-options",
    ]);
  });

  it("drops shortcuts without the custom-shortcuts flag", () => {
    expect(settingsNav([]).map((item) => item.route)).toEqual([
      "settings-profile",
      "settings-password",
      "settings-notifications",
      "settings-options",
    ]);
  });

  it("adds subscription and integrations under their flags", () => {
    expect(settingsNav(["subscriptions"]).map((item) => item.route)).toContain(
      "settings-subscription",
    );
    expect(settingsNav(["admin-console"]).map((item) => item.route)).toContain(
      "settings-subscription",
    );
    expect(settingsNav(["access-tokens"]).map((item) => item.route)).toContain(
      "settings-integrations",
    );
    expect(settingsNav(["mcp"]).map((item) => item.route)).toContain("settings-integrations");
  });

  it("keeps the data-testid the CLJS sidebar puts on the options entry", () => {
    const options = settingsNav([]).find((item) => item.route === "settings-options");
    expect(options?.testId).toBe("settings-profile");
  });

  it("resolves every label key through the generated catalog", () => {
    // tr() falls back to the key itself, so a label the extractor missed would
    // render as its own name. settingsNav stores keys in a data field, which
    // scripts/extract-translations.mjs has to scan explicitly.
    const items = settingsNav(["custom-shortcuts", "subscriptions", "access-tokens"]);
    expect(items.map((item) => item.route)).toHaveLength(7);
    for (const item of items) {
      expect(tr(item.labelKey)).not.toBe(item.labelKey);
    }
  });
});

describe("feedbackVisible", () => {
  it("needs the user-feedback flag", () => {
    expect(feedbackVisible(["user-feedback"])).toBe(true);
    expect(feedbackVisible([])).toBe(false);
    expect(feedbackVisible(config.flags)).toBe(false);
  });
});

describe("profilePhotoUrl", () => {
  it("returns null without a stored photo", () => {
    expect(profilePhotoUrl(null, "")).toBeNull();
    expect(profilePhotoUrl(profile(), "")).toBeNull();
    expect(profilePhotoUrl(profile({ "photo-id": null }), "")).toBeNull();
  });

  it("points at assets/by-id and joins the public uri", () => {
    expect(profilePhotoUrl(profile({ "photo-id": "abc" }), "")).toBe("/assets/by-id/abc");
    expect(profilePhotoUrl(profile({ "photo-id": "abc" }), "https://x.dev")).toBe(
      "https://x.dev/assets/by-id/abc",
    );
    expect(profilePhotoUrl(profile({ "photo-id": "abc" }), "https://x.dev/")).toBe(
      "https://x.dev/assets/by-id/abc",
    );
  });
});

describe("localeOptions", () => {
  it("prepends the browser entry and keeps every locale", () => {
    const options = localeOptions("Auto (browser)");
    expect(options[0]).toEqual({ label: "Auto (browser)", value: "" });
    expect(options).toHaveLength(supportedLocales.length + 1);
  });

  it("carries the codes app.util.i18n lists", () => {
    expect(supportedLocales).toHaveLength(34);
    expect(supportedLocales[0]).toEqual({ label: "English", value: "en" });
    expect(supportedLocales.map((locale) => locale.value)).toContain("zh_cn");
  });
});

describe("initials", () => {
  it("takes the first letter of one or two words", () => {
    expect(initials("ada")).toBe("A");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Ada  Byron  Lovelace")).toBe("AB");
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
  });
});
