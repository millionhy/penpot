"use client";

// Auth guard (F1.4). Wraps route groups that the CLJS frontend only renders
// with an authenticated profile (dashboard/settings/viewer/workspace). While
// the session is loading it renders a neutral placeholder; anonymous sessions
// are redirected to /auth/login, matching the (= id uuid/zero) branch of
// on-query-navigate in frontend/src/app/main/ui/routes.cljs.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { routePaths } from "@/lib/routes";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "anonymous") {
      router.replace(routePaths["auth-login"]);
    }
  }, [status, router]);

  if (status === "authenticated") {
    return <>{children}</>;
  }
  return (
    <main className="pp-page">
      <p className="pp-muted">Loading session...</p>
    </main>
  );
}