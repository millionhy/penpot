"use client";

// Dashboard ?plugin= install flow (F7.2). Port of use-plugin-register in
// app.main.ui.dashboard: a plugin link arrives as ?plugin=<url> (or in the
// tab session for links that went through the login redirect), the manifest
// is fetched once the team and its default project resolve, and the
// permissions dialog chains into the try-out prompt.
//
// Registered deviations from the CLJS:
//   - once the try-out creates the file, the CLJS opens the workspace with
//     the plugin queued (delay-open-plugin + rt/nav :workspace); the shell
//     stays on the recent list until the workspace lands with F9,
//   - the CLJS navigates to the recent section on every close path of the
//     permissions dialog; here only the Cancel button navigates (see
//     components/plugins.tsx),
//   - the flow runs once per URL, so a projects refresh cannot re-fetch it
//     while a dialog is open,
//   - the parse-error / bad-url notifications match the CLJS split between a
//     nil manifest and a failed fetch; ev/event telemetry is dropped.

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { PluginPermissionsDialog, PluginTryOutDialog } from "@/components/plugins";
import { createFile, dashboardHref, fileFeatures } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import {
  clearStoredPluginUrl,
  fetchManifest,
  installPlugin,
  storedPluginUrl,
  type RegistryEntry,
} from "@/lib/plugins";

export function PluginInstallFlow() {
  const params = useSearchParams();
  const { team, teamId, defaultProject } = useDashboard();
  const modal = useModal();
  const notifications = useNotifications();
  const router = useRouter();

  // (or plugin-url (:plugin-url storage/session)). Reading the session on
  // every render makes the fallback go away by itself once it is cleared.
  const pluginUrl = params.get("plugin") ?? storedPluginUrl();
  const projectId = defaultProject?.id ?? null;
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (pluginUrl === null || projectId === null) return;
    if (handled.current === pluginUrl) return;
    handled.current = pluginUrl;

    // The session copy is consumed as soon as the flow takes the url
    // (storage/*sync* true in the CLJS effect).
    clearStoredPluginUrl();

    const goRecent = () => {
      router.push(dashboardHref("dashboard-recent", { teamId }));
    };

    const onTryOutAccept = async (plugin: RegistryEntry) => {
      try {
        await createFile({
          "project-id": projectId,
          // (str (tr "dashboard.plugins.try-plugin") (:name plugin)).
          name: tr("dashboard.plugins.try-plugin") + plugin.name,
          features: fileFeatures(team),
        });
        // The CLJS navigates to the workspace with the plugin queued; the
        // shell lands on the recent list so the new file shows up.
        goRecent();
      } catch {
        notifications.error(tr("errors.generic"));
      }
    };

    const openPermissions = (plugin: RegistryEntry) => {
      modal.open(
        <PluginPermissionsDialog
          plugin={plugin}
          onAccept={() => {
            // install-plugin! is fire-and-forget in the CLJS emit too; the
            // registry optimistic update lands before the dialog swaps.
            void installPlugin(plugin);
            modal.open(
              <PluginTryOutDialog
                plugin={plugin}
                onAccept={() => {
                  void onTryOutAccept(plugin);
                }}
              />,
            );
            goRecent();
          }}
          onCancel={goRecent}
        />,
      );
    };

    let live = true;
    void (async () => {
      try {
        const plugin = await fetchManifest(pluginUrl);
        if (!live) return;
        if (plugin !== null) {
          openPermissions(plugin);
        } else {
          // Cannot get the manifest.
          notifications.error(tr("dashboard.plugins.parse-error"));
        }
      } catch {
        if (!live) return;
        // The fetch itself failed: not a valid URL or unreachable.
        notifications.error(tr("dashboard.plugins.bad-url"));
      }
    })();

    return () => {
      live = false;
    };
  }, [pluginUrl, projectId, teamId, team, modal, notifications, router]);

  return null;
}
