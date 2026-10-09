"use client";

// Settings shell (F4). Mirrors settings* in app.main.ui.settings: an
// authenticated dashboard frame with the settings sidebar, the "your account"
// header, and the routed page in the container slot.
//
// modal-container* lives in the root layout, so a dialog opened from any
// settings page renders there. The settings routes mount the dashboard
// shortcut base set (sc/shortcuts, toggle-theme) through
// DashboardShortcutsProvider, like settings.cljs does with
// (use-shortcuts ::dashboard sc/shortcuts :dashboard); the provider reads
// the route itself (dashboardSetForPath) and resolves "base" here.

import { AuthGuard } from "@/components/auth-guard";
import { SettingsSidebar } from "@/components/settings-sidebar";
import { DashboardShortcutsProvider } from "@/lib/dashboard-shortcuts-context";
import { tr } from "@/lib/i18n";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <DashboardShortcutsProvider>
        <section className="pp-dashboard">
          <SettingsSidebar />
          <div className="pp-dashboard-content">
            <header className="pp-dashboard-header" data-testid="dashboard-header">
              <div className="pp-dashboard-title">
                <h1 data-testid="account-title">{tr("dashboard.your-account-title")}</h1>
              </div>
            </header>
            <div className="pp-dashboard-container">{children}</div>
          </div>
        </section>
      </DashboardShortcutsProvider>
    </AuthGuard>
  );
}
