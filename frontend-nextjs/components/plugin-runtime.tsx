"use client";

// Plugin runtime boot (F7.3). Port of app.plugins/initialize: once the shell
// mounts, with the plugins/runtime feature on, the @penpot/plugins-runtime
// package loads (SES intrinsics repair included) and receives the context
// builder. The component also forwards the notification system to the
// runtime module, which has no React context of its own.
//
// Registered deviations from the CLJS:
//   - set! errors/is-plugin-error? has no counterpart: the shell has no
//     crash reporter to label plugin errors yet,
//   - the feature check reads the global defaults union the config flags
//     (globalEnabledFeatures); the CLJS also sees the team features, which
//     the root layout does not load here.

import { useEffect } from "react";
import { useNotifications } from "@/components/notifications";
import { setPluginRuntimeNotifier, startPluginRuntime } from "@/lib/plugin-runtime";
import { globalEnabledFeatures } from "@/lib/team";

export function PluginRuntime() {
  const { warn, error } = useNotifications();

  // The level helpers are stable; the notifier follows them and clears on
  // unmount so a stale closure cannot outlive the provider.
  useEffect(() => {
    setPluginRuntimeNotifier({
      warn: (message) => warn(message),
      error: (message) => error(message),
    });
    return () => setPluginRuntimeNotifier(null);
  }, [warn, error]);

  useEffect(() => {
    if (!globalEnabledFeatures().includes("plugins/runtime")) return;
    void startPluginRuntime();
  }, []);

  return null;
}
