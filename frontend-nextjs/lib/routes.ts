// Route registry. Mirrors the enabled `routes` set and the path table in
// frontend/src/app/main/ui/routes.cljs so the Next.js App Router tree and the
// CLJS router stay in lockstep during the migration.
//
// URL-shape note: current Penpot uses query-string routing (?screen=<name>&params)
// with a legacy #/... hash table being phased out. The Next.js shell adopts clean
// path segments instead (better for SSR/SEO, which is the reason for Next.js).
// A compatibility layer that maps ?screen=<name> and #/<path> to these paths is a
// Phase-F task (see rewrite.md, task F1.3).

export type RouteName =
  | "auth-login"
  | "auth-register"
  | "auth-register-validate"
  | "auth-register-success"
  | "auth-recovery-request"
  | "auth-recovery"
  | "auth-verify-token"
  | "settings-profile"
  | "settings-password"
  | "settings-feedback"
  | "settings-options"
  | "settings-subscription"
  | "settings-integrations"
  | "settings-notifications"
  | "settings-shortcuts"
  | "frame-preview"
  | "viewer"
  | "render-sprite"
  | "dashboard-members"
  | "dashboard-invitations"
  | "dashboard-webhooks"
  | "dashboard-settings"
  | "dashboard-recent"
  | "dashboard-search"
  | "dashboard-fonts"
  | "dashboard-font-providers"
  | "dashboard-libraries"
  | "dashboard-files"
  | "dashboard-deleted"
  | "workspace"
  | "nitrate-entry";

export const routePaths: Record<RouteName, string> = {
  "auth-login": "/auth/login",
  "auth-register": "/auth/register",
  "auth-register-validate": "/auth/register/validate",
  "auth-register-success": "/auth/register/success",
  "auth-recovery-request": "/auth/recovery/request",
  "auth-recovery": "/auth/recovery",
  "auth-verify-token": "/auth/verify-token",
  "settings-profile": "/settings/profile",
  "settings-password": "/settings/password",
  "settings-feedback": "/settings/feedback",
  "settings-options": "/settings/options",
  "settings-subscription": "/settings/subscriptions",
  "settings-integrations": "/settings/integrations",
  "settings-notifications": "/settings/notifications",
  "settings-shortcuts": "/settings/shortcuts",
  "frame-preview": "/frame-preview",
  "viewer": "/view",
  "render-sprite": "/render-sprite",
  "dashboard-members": "/dashboard/members",
  "dashboard-invitations": "/dashboard/invitations",
  "dashboard-webhooks": "/dashboard/webhooks",
  "dashboard-settings": "/dashboard/settings",
  "dashboard-recent": "/dashboard/recent",
  "dashboard-search": "/dashboard/search",
  "dashboard-fonts": "/dashboard/fonts",
  "dashboard-font-providers": "/dashboard/fonts/providers",
  "dashboard-libraries": "/dashboard/libraries",
  "dashboard-files": "/dashboard/files",
  "dashboard-deleted": "/dashboard/deleted",
  "workspace": "/workspace",
  "nitrate-entry": "/subscribe-nitrate",
};

export function routePath(name: RouteName): string {
  return routePaths[name];
}

// Route groups migrated as a unit (matches the Phase-F task breakdown).
export const routeGroups = {
  auth: [
    "auth-login",
    "auth-register",
    "auth-register-validate",
    "auth-register-success",
    "auth-recovery-request",
    "auth-recovery",
    "auth-verify-token",
  ],
  settings: [
    "settings-profile",
    "settings-password",
    "settings-feedback",
    "settings-options",
    "settings-subscription",
    "settings-integrations",
    "settings-notifications",
    "settings-shortcuts",
  ],
  dashboard: [
    "dashboard-members",
    "dashboard-invitations",
    "dashboard-webhooks",
    "dashboard-settings",
    "dashboard-recent",
    "dashboard-search",
    "dashboard-fonts",
    "dashboard-font-providers",
    "dashboard-libraries",
    "dashboard-files",
    "dashboard-deleted",
  ],
  viewer: ["viewer", "frame-preview", "render-sprite"],
  workspace: ["workspace"],
} as const satisfies Record<string, readonly RouteName[]>;