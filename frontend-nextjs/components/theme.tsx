"use client";

// Profile-driven theme (F4). Mirrors use-initialize + set-color-scheme in
// app.util.theme: the profile's theme setting resolves against the OS
// preference and becomes a class on <html>, which is where styles/tokens.css
// scopes the .light / .default semantic color tokens.
//
// The CLJS app sets the class on <body>; the shell sets it on <html> so the
// server-rendered markup already carries a theme and there is no flash.

import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { resolveTheme, themeClass, type ResolvedTheme } from "@/lib/settings";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(profileTheme: string | undefined) {
  const next = themeClass(resolveTheme(profileTheme, systemTheme()));
  const root = document.documentElement;
  root.classList.remove("light", "default");
  root.classList.add(next);
}

export function ThemeManager() {
  const { profile } = useSession();
  const theme = profile?.theme;

  useEffect(() => {
    applyTheme(theme);
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  return null;
}
