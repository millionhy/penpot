// Settings / shortcuts (F4 placeholder).
//
// app.main.ui.settings.shortcuts lists and edits the keyboard shortcuts of the
// workspace, the viewer, the dashboard and the path editor. It reads their
// definitions from app.main.data.workspace.shortcuts,
// app.main.data.viewer.shortcuts, app.main.data.dashboard.shortcuts and
// app.main.data.workspace.path.shortcuts, and persists overrides to
// props.custom-shortcuts through update-profile-props.
//
// Those registries arrive with the dashboard (F5) and workspace (F9)
// migrations, so the page stays a stub. The nav entry is reachable because
// :custom-shortcuts is on by default (lib/config.ts defaultFlags).

import { RouteStub } from "@/components/route-stub";

export default function Page() {
  return <RouteStub title="Settings / Shortcuts" cljs="app.main.ui.settings.shortcuts" />;
}
