"use client";

// Dashboard shell (F5.1). The frame app.main.ui.cljs assembles for the
// dashboard routes: team-container* guards the profile and resolves the team,
// dashboard* renders sidebar* plus dashboard-content* inside a <main> keyed by
// team-id so a team switch rebuilds the whole subtree (the shell equivalent of
// re-running dd/initialize on every team change). Team resolution, projects and
// recent files live in DashboardProvider (lib/dashboard-context.tsx);
// modal-container* is already mounted in the root layout (F4).
//
// Not here yet: the dashboard shortcuts registry
// (app.main.data.dashboard.shortcuts) arrives with F5.6, together with the
// onboarding and release-notes modals gated by the :onboarding flag.

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthGuard } from "@/components/auth-guard";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { singleSelectedFileId, workspaceHref } from "@/lib/dashboard";
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context";

function DashboardFrame({ children }: { children: React.ReactNode }) {
  const { teamId, selection, clearSelection } = useDashboard();
  const router = useRouter();

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
    <main className="pp-dashboard pp-dashboard-main" key={teamId ?? ""} data-testid="dashboard">
      <DashboardSidebar />
      {/* dashboard-content* clears the file selection on any click that
          bubbles up from the section (grid items stop propagation when the
          click changes the selection instead). */}
      <div className="pp-dashboard-content" data-testid="dashboard-content" onClick={clearSelection}>
        {children}
      </div>
    </main>
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
        <DashboardFrame>{children}</DashboardFrame>
      </DashboardProvider>
    </AuthGuard>
  );
}
