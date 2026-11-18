"use client";

// Port of app.main.ui.nitrate.entry (nitrate-entry*). The route is a hand-off,
// not a page: it flags the shared "penpot" storage entry that the dashboard
// consumes on its next mount to open the enterprise (nitrate) onboarding form,
// then sends the visitor to the dashboard or to the register page. The CLJS
// router registers /subscribe-nitrate only under the :admin-console flag; the
// shell keeps the page reachable and the dashboard flow decides what to show.
//
// Deviation from the CLJS, documented: rt/nav pushes a history entry, so
// going back re-triggers the flag; the shell replaces the entry page instead.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PenpotLoader } from "@/components/penpot-loader";
import { activateNitrateEntryPopup } from "@/lib/nitrate";
import { routePaths } from "@/lib/routes";
import { isAuthenticatedProfile, useSession } from "@/lib/session";

export default function SubscribeNitratePage() {
  const { status, profile } = useSession();
  const router = useRouter();

  useEffect(() => {
    // Wait for get-profile: a still-loading session and an anonymous one both
    // carry a null profile and must land on different routes.
    if (status === "loading") return;

    activateNitrateEntryPopup();

    if (isAuthenticatedProfile(profile)) {
      const teamId = profile["default-team-id"];
      const href = routePaths["dashboard-recent"];
      router.replace(teamId !== undefined ? `${href}?team-id=${teamId}` : href);
    } else {
      router.replace(routePaths["auth-register"]);
    }
  }, [status, profile, router]);

  return <PenpotLoader />;
}
