"use client";

// Applies the URL compatibility layer once per page load (F1.3). Mirrors the
// hash branch of on-navigate in app.main.ui.routes: legacy "#/..." URLs are
// translated first, then "?screen=<name>" query routing; both are replaced
// (no extra history entry) with the equivalent shell path.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { resolveLegacyHash, resolveScreenQuery } from "@/lib/legacy-routes";

export function UrlCompat() {
  const router = useRouter();

  useEffect(() => {
    const { hash, search } = window.location;
    const target =
      resolveLegacyHash(hash) ?? (search.length > 0 ? resolveScreenQuery(search) : null);
    if (target !== null) {
      router.replace(target);
    }
  }, [router]);

  return null;
}