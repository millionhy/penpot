import { afterEach, describe, expect, it } from "vitest";
import {
  format,
  getActiveLocale,
  htmlLang,
  lookup,
  matchLocale,
  richSegments,
  setActiveLocale,
  tr,
} from "@/lib/i18n";
import { en } from "@/lib/translations/en";
import { zh_cn } from "@/lib/translations/zh_cn";
import { zh_hant } from "@/lib/translations/zh_hant";

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

  it("strips the |target:self suffix and marks the segment", () => {
    expect(richSegments("see [plans|target:self](/settings/subscription) now")).toEqual([
      { text: "see " },
      { text: "plans", href: "/settings/subscription", self: true },
      { text: " now" },
    ]);
  });

  it("leaves self unset on plain links", () => {
    const [segment] = richSegments("[b](https://example.com)");
    expect(segment.self).toBeUndefined();
  });

  it("resolves the terms agreement into two links", () => {
    const segments = richSegments(
      tr("auth.terms-and-privacy-agreement", "https://tos", "https://privacy"),
    );
    expect(segments.filter((segment) => segment.href !== undefined)).toHaveLength(2);
  });
});

describe("matchLocale", () => {
  it("matches the Chinese browser tags to their catalogs", () => {
    expect(matchLocale("zh-CN", "")).toBe("zh_cn");
    expect(matchLocale("zh-Hant", "")).toBe("zh_hant");
    expect(matchLocale("zh_hant", undefined)).toBe("zh_hant");
  });

  it("does not invent a bare zh catalog, like the CLJS supported set", () => {
    expect(matchLocale("zh", "")).toBe("en");
  });

  it("keeps an explicit lang even when it has no catalog", () => {
    expect(matchLocale("fr", "zh-CN")).toBe("en");
  });

  it("autodetects the browser language for an empty lang", () => {
    expect(matchLocale("", "zh-CN")).toBe("zh_cn");
    expect(matchLocale(undefined, "en-GB")).toBe("en");
    expect(matchLocale(null, null)).toBe("en");
  });
});

describe("htmlLang", () => {
  it("emits a BCP 47 tag", () => {
    expect(htmlLang("en")).toBe("en");
    expect(htmlLang("zh_cn")).toBe("zh-CN");
    expect(htmlLang("zh_hant")).toBe("zh-Hant");
  });
});

describe("locale catalogs", () => {
  it("keeps the Chinese catalogs free of empty entries", () => {
    for (const catalog of [zh_cn, zh_hant]) {
      for (const [key, entry] of Object.entries(catalog)) {
        if (Array.isArray(entry)) {
          expect(entry, key).toHaveLength(2);
          expect(
            entry.some((part) => part.length > 0),
            key,
          ).toBe(true);
        } else {
          expect(entry.length, key).toBeGreaterThan(0);
        }
      }
    }
  });

  it("falls back to English for keys a Chinese catalog lacks", () => {
    // zh_cn/zh_hant trail en.po upstream; whatever is missing has to resolve
    // to the English entry instead of the raw key.
    for (const catalog of [zh_cn, zh_hant]) {
      for (const key of Object.keys(en)) {
        if (key in catalog) continue;
        expect(lookup(key, catalog === zh_cn ? "zh_cn" : "zh_hant"), key).toEqual(en[key]);
      }
    }
  });

  it("falls back to English for an unknown locale", () => {
    expect(lookup("auth.check-email", "fr")).toBe(en["auth.check-email"]);
  });
});

describe("active locale", () => {
  afterEach(() => setActiveLocale("en"));

  it("starts on English and ignores unknown catalogs", () => {
    expect(getActiveLocale()).toBe("en");
    setActiveLocale("fr");
    expect(getActiveLocale()).toBe("en");
  });

  it("routes tr() through the active locale", () => {
    const zhEntry = lookup("labels.num-of-files", "zh_cn");
    setActiveLocale("zh_cn");
    const zhPlural = Array.isArray(zhEntry) ? zhEntry[1] : String(zhEntry);
    expect(tr("labels.num-of-files", 3)).toBe(format(zhPlural, [3]));

    const hantEntry = lookup("labels.num-of-files", "zh_hant");
    setActiveLocale("zh_hant");
    const hantPlural = Array.isArray(hantEntry) ? hantEntry[1] : String(hantEntry);
    expect(tr("labels.num-of-files", 5)).toBe(format(hantPlural, [5]));
  });

  // The left-sidebar tabs and the page panel resolve their labels on every
  // render; these keys are the ones the sidebar reads (workspace.sidebar.tokens
  // is the catalog entry added for the tabs, the CLJS kept a literal).
  it("translates the sidebar tabs and the page panel", () => {
    setActiveLocale("zh_cn");
    expect(tr("workspace.sidebar.layers")).toBe("图层");
    expect(tr("workspace.sidebar.tokens")).toBe("令牌");
    expect(tr("workspace.sidebar.sitemap")).toBe("页面");
    expect(tr("workspace.sidebar.sitemap.add-page")).toBe("添加页面");

    setActiveLocale("zh_hant");
    expect(tr("workspace.sidebar.tokens")).toBe("權杖");
  });
});
