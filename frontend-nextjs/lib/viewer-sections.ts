// The section gate of the viewer (F6.6): the allowed / visible formulas of
// app.main.ui.viewer and app.main.ui.viewer.header.
//
// Permissions reach the shell as a plain object (the transit boundary turns
// the keyword keys into strings): a membership carries type / can-edit /
// is-logged, a share-link carries type / is-logged / who-comment /
// who-inspect, and get-view-only-bundle appends in-team for logged-in team
// members.
//
// Deviations from the CLJS original, documented:
// - The header buttons and the section body use the same predicates as the
//   CLJS, including their disagreement: a team member sees the comments
//   button through in-team, while viewer-content* still requires can-edit to
//   render the section. That combination falls back to interactions, like the
//   original.
// - The shell renders all three sections: interactions, comments and
//   inspect (D23).

export const VIEWER_SECTIONS = ["interactions", "comments", "inspect"] as const;

export type ViewerSection = (typeof VIEWER_SECTIONS)[number];

export type ViewerPermissions = Record<string, unknown>;

export function isViewerSection(value: string | null): value is ViewerSection {
  return value !== null && (VIEWER_SECTIONS as readonly string[]).includes(value);
}

function isTrue(permissions: ViewerPermissions, key: string): boolean {
  return permissions[key] === true;
}

function asString(permissions: ViewerPermissions, key: string): string | null {
  const value = permissions[key];
  return typeof value === "string" ? value : null;
}

// header mode-zone: (or (:in-team permissions) (= (:who-comment permissions)
// "all")). An anonymous share-link with who-comment "all" shows the button
// even though the section body then needs a logged-in profile.
export function canShowCommentsButton(permissions: ViewerPermissions): boolean {
  return isTrue(permissions, "in-team") || asString(permissions, "who-comment") === "all";
}

// header mode-zone: (or (:in-team permissions) (and (= (:type permissions)
// :share-link) (= (:who-inspect permissions) "all"))).
export function canShowInspectButton(permissions: ViewerPermissions): boolean {
  return (
    isTrue(permissions, "in-team") ||
    (asString(permissions, "type") === "share-link" &&
      asString(permissions, "who-inspect") === "all")
  );
}

// viewer-content* `allowed`: interactions never gates; comments and inspect
// allow an editor, or a logged-in share-link visitor whose policy is "all".
export function canAccessSection(
  section: ViewerSection,
  permissions: ViewerPermissions,
): boolean {
  if (section === "interactions") return true;
  if (isTrue(permissions, "can-edit")) return true;
  if (!isTrue(permissions, "is-logged")) return false;
  const policy = section === "comments" ? "who-comment" : "who-inspect";
  return asString(permissions, policy) === "all";
}

// The section the viewer renders: an unknown or disallowed value falls back
// to interactions, the CLJS `(if (allowed section) ... :interactions)`.
export function resolveViewerSection(
  value: string | null,
  permissions: ViewerPermissions,
): ViewerSection {
  if (isViewerSection(value) && canAccessSection(value, permissions)) return value;
  return "interactions";
}

// header navigate / go-to-inspect: interactions is always reachable; every
// other section needs a session, which the shell sends to the login route
// (the CLJS shows the login modal).
export function requiresLogin(section: ViewerSection, permissions: ViewerPermissions): boolean {
  return section !== "interactions" && !isTrue(permissions, "is-logged");
}
