"use client";

// Dashboard shell (F5.1). The frame app.main.ui.cljs assembles for the
// dashboard routes: team-container* guards the profile and resolves the team,
// dashboard* renders sidebar* plus dashboard-content* inside a <main> keyed by
// team-id so a team switch rebuilds the whole subtree (the shell equivalent of
// re-running dd/initialize on every team change). Team resolution, projects and
// recent files live in DashboardProvider (lib/dashboard-context.tsx);
// modal-container* is already mounted in the root layout (F4).
//
// The dashboard shortcuts registry (app.main.data.dashboard.shortcuts, F5.6)
// mounts through DashboardShortcutsProvider inside DashboardProvider, which
// owns the navigate and default-project actions the matcher needs. The
// nitrate entry flow below ports use-nitrate-entry-popup; the rest of the
// onboarding and release-notes modals gated by the :onboarding flag are still
// missing.

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { AuthGuard } from "@/components/auth-guard";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { useNitrateFormPopup } from "@/components/nitrate-modals";
import { useNotifications } from "@/components/notifications";
import { PluginInstallFlow } from "@/components/plugin-install-flow";
import { ProgressProvider } from "@/components/progress-notification";
import { config } from "@/lib/config";
import { singleSelectedFileId, workspaceHref } from "@/lib/dashboard";
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context";
import { DashboardShortcutsProvider } from "@/lib/dashboard-shortcuts-context";
import { tr } from "@/lib/i18n";
import {
  consumeNitrateEntryPopup,
  nitrateEntryPopupPending,
  nitrateEntryProps,
} from "@/lib/nitrate";
import { useSession } from "@/lib/session";
import { updateProfileProps, type RuntimeProfile } from "@/lib/settings";

// use-nitrate-entry-popup in dashboard*: /subscribe-nitrate leaves a flag in
// the shared storage; the first dashboard mount after it consumes the flag,
// marks the onboarding as viewed and opens the enterprise (nitrate) form.
function useNitrateEntryPopup() {
  const { profile, refresh } = useSession();
  const notifications = useNotifications();
  const openNitrateForm = useNitrateFormPopup();
  const consumed = useRef(false);

  const runtime = (profile ?? null) as RuntimeProfile | null;
  const onboardingViewed = runtime?.props?.["onboarding-viewed"] === true;
  const nitrateOnboardingViewed = runtime?.props?.["nitrate-onboarding-viewed"] === true;

  useEffect(() => {
    // Wait for get-profile (runtime null) so the props read is the stored one.
    if (consumed.current || runtime === null) return;
    if (!nitrateEntryPopupPending()) return;

    consumed.current = true;
    consumeNitrateEntryPopup();

    const props = nitrateEntryProps({
      onboardingViewed,
      nitrateOnboardingViewed,
      releaseNotesVersion: config.version,
    });
    if (Object.keys(props).length > 0) {
      void updateProfileProps(props)
        .then(() => refresh())
        .catch(() => notifications.error(tr("errors.generic")));
    }
    openNitrateForm();
  }, [runtime, onboardingViewed, nitrateOnboardingViewed, openNitrateForm, refresh, notifications]);
}

function DashboardFrame({ children }: { children: React.ReactNode }) {
  const { teamId, selection, clearSelection } = useDashboard();
  const router = useRouter();

  useNitrateEntryPopup();

  // The global keydown in dashboard*: Enter opens the selection when it holds
  // exactly one file (dd/open-selected-file). Grid items handle their own
  // focused Enter and stop propagation before it reaches this listener.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const fileId = singleSelectedFileId(selection);
      if (fileId === null) return;
      router.push(workspaceHref({ teamId, fileId }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, teamId, router]);

  return (
    <>
      {/* use-plugin-register in dashboard*: consumes ?plugin= (or the tab
          session) once the default project resolves (F7.2). */}
      <PluginInstallFlow />
      <main className="pp-dashboard pp-dashboard-main" key={teamId ?? ""} data-testid="dashboard">
      <DashboardSidebar />
      {/* dashboard-content* clears the file selection on any click that
          bubbles up from the section (grid items stop propagation when the
          click changes the selection instead). */}
      <div className="pp-dashboard-content" data-testid="dashboard-content" onClick={clearSelection}>
        {/* dashboard-content* renders progress-notification-widget* as its
            first child, so the widget hangs off the content box the same way
            (F5.3). */}
        <ProgressProvider>{children}</ProgressProvider>
      </div>
    </main>
    </>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <DashboardProvider>
        <DashboardShortcutsProvider>
          <DashboardFrame>{children}</DashboardFrame>
        </DashboardShortcutsProvider>
      </DashboardProvider>
    </AuthGuard>
  );
}
