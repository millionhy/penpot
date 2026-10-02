// URL compatibility layer (F1.3). Current Penpot uses query-string routing
// (?screen=<name>&params) with a legacy "#/<path>" hash table being phased out
// (see frontend/src/app/main/ui/routes.cljs: legacy-routes + on-navigate).
// The Next.js shell uses clean path segments; these pure resolvers translate
// both legacy shapes into shell paths so old bookmarks, emails and CLJS-era
// links keep working. Applied once on the client by components/url-compat.tsx
// (hash fragments never reach the server).

import { routePaths, type RouteName } from "./routes";

// Port of the legacy-routes table in app.main.ui.routes (debug-only routes and
// the admin-console flag gate are intentionally omitted in the shell for now).
const legacyTable: ReadonlyArray<readonly [pattern: string, name: RouteName]> = [
  ["/auth/login", "auth-login"],
  ["/auth/register", "auth-register"],
  ["/auth/register/validate", "auth-register-validate"],
  ["/auth/register/success", "auth-register-success"],
  ["/auth/recovery/request", "auth-recovery-request"],
  ["/auth/recovery", "auth-recovery"],
  ["/auth/verify-token", "auth-verify-token"],
  ["/subscribe-nitrate", "nitrate-entry"],
  ["/settings/profile", "settings-profile"],
  ["/settings/password", "settings-password"],
  ["/settings/feedback", "settings-feedback"],
  ["/settings/options", "settings-options"],
  ["/settings/subscriptions", "settings-subscription"],
  ["/settings/integrations", "settings-integrations"],
  ["/settings/notifications", "settings-notifications"],
  ["/settings/shortcuts", "settings-shortcuts"],
  ["/frame-preview", "frame-preview"],
  ["/view", "viewer"],
  ["/render-sprite/:file-id", "render-sprite"],
  ["/dashboard/members", "dashboard-members"],
  ["/dashboard/invitations", "dashboard-invitations"],
  ["/dashboard/webhooks", "dashboard-webhooks"],
  ["/dashboard/settings", "dashboard-settings"],
  ["/dashboard/recent", "dashboard-recent"],
  ["/dashboard/search", "dashboard-search"],
  ["/dashboard/fonts", "dashboard-fonts"],
  ["/dashboard/fonts/providers", "dashboard-font-providers"],
  ["/dashboard/libraries", "dashboard-libraries"],
  ["/dashboard/files", "dashboard-files"],
  ["/dashboard/deleted", "dashboard-deleted"],
  ["/workspace", "workspace"],
];

interface LegacyMatch {
  name: RouteName;
  params: Record<string, string>;
}

function matchLegacyPath(path: string): LegacyMatch | null {
  const pathSegments = path.split("/").filter(Boolean);
  for (const [pattern, name] of legacyTable) {
    const patternSegments = pattern.split("/").filter(Boolean);
    if (patternSegments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternSegments.length; index++) {
      const segment = patternSegments[index];
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(pathSegments[index]);
      } else if (segment !== pathSegments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { name, params };
  }
  return null;
}

function buildTarget(name: RouteName, params: URLSearchParams): string | null {
  const path = routePaths[name];
  if (!path) return null;
  const query = params.toString();
  return query.length > 0 ? path + "?" + query : path;
}

// Translate a legacy hash ("#/auth/login?x=1") into a shell path, or null when
// untranslatable (on-navigate falls through to the normal query flow there).
export function resolveLegacyHash(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const raw = hash.slice(1);
  const queryIndex = raw.indexOf("?");
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const match = matchLegacyPath(path);
  if (!match) return null;
  const params = new URLSearchParams(queryIndex >= 0 ? raw.slice(queryIndex + 1) : "");
  for (const [key, value] of Object.entries(match.params)) {
    params.set(key, value);
  }
  return buildTarget(match.name, params);
}

// Translate query-string routing ("?screen=dashboard-recent&team-id=x") into a
// shell path, or null when there is no usable screen (mirrors rt/match).
export function resolveScreenQuery(search: string): string | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length === 0) return null;
  const params = new URLSearchParams(raw);
  const screen = params.get("screen");
  if (!screen) return null;
  const name = screen as RouteName;
  if (!(name in routePaths)) return null;
  params.delete("screen");
  return buildTarget(name, params);
}