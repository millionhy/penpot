"use client";

// Locale selection for the shell (mirrors the profile + browser branches of
// app.util.i18n). The gate resolves the catalog from the session profile's
// lang - set on the settings/options page, where an empty value means
// "Auto (browser)" - and keeps lib/i18n's active locale in sync.
//
// tr() is a plain function, not a hook, so a locale change cannot travel
// through context alone: the gate writes the active locale during render and
// remounts the subtree through the fragment key whenever the resolved locale
// changes. Components that never read the session then cannot keep text
// rendered under the previous locale.
//
// navigator.language is read in an effect: the first client render has to
// match the server's (English) markup before autodetection applies.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { htmlLang, matchLocale, setActiveLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { RuntimeProfile } from "@/lib/settings";

export function LocaleGate({ children }: { children: ReactNode }) {
  const { profile } = useSession();
  const [browserLanguage, setBrowserLanguage] = useState("");

  useEffect(() => {
    setBrowserLanguage(navigator.language ?? "");
  }, []);

  const locale = matchLocale((profile as RuntimeProfile | null)?.lang, browserLanguage);
  // Render-phase write: the remount below must already render with the new
  // locale, and the write is idempotent across re-renders.
  setActiveLocale(locale);

  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
  }, [locale]);

  return <Fragment key={locale}>{children}</Fragment>;
}
