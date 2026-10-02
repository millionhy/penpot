"use client";

// Bootstrap route. Mirrors the empty-token branch of on-query-navigate in
// frontend/src/app/main/ui/routes.cljs: get-profile decides the landing page.
// An authenticated profile lands on /dashboard/recent, an anonymous one
// (zero uuid) on /auth/login. Team-id resolution against get-teams is part of
// the dashboard migration (F5) and intentionally not duplicated here.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { routePaths } from "@/lib/routes";

export default function RootPage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(routePaths["dashboard-recent"]);
    } else if (status === "anonymous") {
      router.replace(routePaths["auth-login"]);
    }
  }, [status, router]);

  return (
    <main className="pp-page">
      <p className="pp-muted">Loading...</p>
    </main>
  );
}