// Auth flows for the shell: the subset of app.main.data.auth the migrated
// pages use, expressed as plain async calls over the RPC transport instead of
// potok events. The command names, params and response handling match the
// CLJS reference one for one so both frontends stay interchangeable against
// the unchanged Clojure backend.

import { tr } from "./i18n";
import { cmd } from "./rpc";
import { routePaths, type RouteName } from "./routes";
import { takeLoginRedirect } from "./storage";
import type {
  CreateDemoProfileResult,
  PrepareRegisterProfileParams,
  PrepareRegisterProfileResult,
  RecoverProfileParams,
  RegisterProfileParams,
  RegisterProfileResult,
  SessionProfile,
  VerifyTokenResult,
} from "./types";
import { RpcError } from "./errors";

// --- commands --------------------------------------------------------------

// Step 1 of registration: the backend validates the attempt and mints a
// prepared-register JWE (backend/src/app/rpc/commands/auth.clj prepare-register).
export function prepareRegisterProfile(
  params: PrepareRegisterProfileParams,
): Promise<PrepareRegisterProfileResult> {
  return cmd<PrepareRegisterProfileResult>("prepare-register-profile", params);
}

// Step 2: exchanges the prepared-register token for the profile, sending the
// verification email when the profile is not active yet.
export function registerProfile(params: RegisterProfileParams): Promise<RegisterProfileResult> {
  return cmd<RegisterProfileResult>("register-profile", params);
}

export function requestProfileRecovery(email: string): Promise<unknown> {
  return cmd("request-profile-recovery", { email });
}

export function recoverProfile(token: string, password: string): Promise<unknown> {
  const params: RecoverProfileParams = { token, password };
  return cmd("recover-profile", params);
}

export function verifyToken(token: string): Promise<VerifyTokenResult> {
  return cmd<VerifyTokenResult>("verify-token", { token });
}

export function createDemoProfile(): Promise<CreateDemoProfileResult> {
  return cmd<CreateDemoProfileResult>("create-demo-profile", {});
}

// --- post login redirect ---------------------------------------------------

// Port of get-redirect-events in app.main.data.auth/logged-in. Team-id
// resolution against get-teams and the stored last team id belongs to the
// dashboard migration (F5); until then the fallback is the plain dashboard.
export type PostLoginTarget =
  | { kind: "route"; path: string }
  | { kind: "href"; href: string }
  | { kind: "reload" };

export function postLoginTarget(
  profile: SessionProfile | null,
  currentHref: string,
): PostLoginTarget {
  const invitationToken = profile?.["invitation-token"];
  if (typeof invitationToken === "string" && invitationToken.length > 0) {
    return {
      kind: "route",
      path: routePaths["auth-verify-token"] + "?token=" + encodeURIComponent(invitationToken),
    };
  }
  const redirect = takeLoginRedirect();
  if (redirect !== null) {
    return redirect === currentHref ? { kind: "reload" } : { kind: "href", href: redirect };
  }
  return { kind: "route", path: routePaths["dashboard-recent"] };
}

export interface Navigator {
  push(href: string): void;
  replace(href: string): void;
}

export function applyPostLoginTarget(router: Navigator, target: PostLoginTarget): void {
  if (target.kind === "route") router.push(target.path);
  else if (target.kind === "href") window.location.assign(target.href);
  else window.location.reload();
}

// --- error mapping ---------------------------------------------------------

interface RpcErrorFields {
  type?: unknown;
  code?: unknown;
  email?: unknown;
  details?: unknown;
  [key: string]: unknown;
}

function errorFields(err: unknown): RpcErrorFields | null {
  return err instanceof RpcError ? (err.data as RpcErrorFields) : null;
}

function isCode(err: unknown, type: string, code: string): boolean {
  const fields = errorFields(err);
  return fields !== null && fields.type === type && fields.code === code;
}

// The [:restriction ...] / [:validation ...] branches of on-error in
// app.main.ui.auth.register/register-form*. Each entry maps a backend code to
// the field that should be marked invalid.
export function registerFieldError(err: unknown): { field: string; message: string } | null {
  const fields = errorFields(err);
  if (fields === null) return null;
  const email = typeof fields.email === "string" ? fields.email : "";
  if (isCode(err, "restriction", "email-does-not-match-invitation")) {
    return { field: "email", message: tr("errors.email-does-not-match-invitation") };
  }
  if (isCode(err, "restriction", "registration-disabled")) {
    return { field: "email", message: tr("errors.registration-disabled") };
  }
  if (isCode(err, "restriction", "email-domain-is-not-allowed")) {
    return { field: "email", message: tr("errors.email-domain-not-allowed") };
  }
  if (
    isCode(err, "restriction", "email-has-permanent-bounces") ||
    isCode(err, "restriction", "email-has-complaints")
  ) {
    return { field: "email", message: tr("errors.email-has-permanent-bounces", email) };
  }
  if (isCode(err, "validation", "email-already-exists")) {
    return { field: "email", message: tr("errors.email-already-exists") };
  }
  if (isCode(err, "validation", "email-as-password")) {
    return { field: "password", message: tr("errors.email-as-password") };
  }
  if (isCode(err, "validation", "weak-password")) {
    // The backend sends translation keys in :details; the CLJS form maps them
    // with tr and renders them as the options of the weak-password message.
    const details = Array.isArray(fields.details) ? fields.details : [];
    const options = details.map((key) => tr(String(key)));
    return {
      field: "password",
      message: options.length > 0 ? options.join("\n") : tr("errors.weak-password"),
    };
  }
  return null;
}

// on-error in app.main.ui.auth.recovery/recovery-form*: a weak password is
// reported on the field, anything else means the recovery token is unusable.
export function recoveryError(err: unknown): { field: string; message: string } | "invalid-token" {
  const fields = errorFields(err);
  if (fields !== null && Array.isArray(fields.details) && isCode(err, "validation", "weak-password")) {
    const options = fields.details.map((key) => tr(String(key)));
    return {
      field: "password-1",
      message: options.length > 0 ? options.join("\n") : tr("errors.weak-password"),
    };
  }
  if (isCode(err, "validation", "weak-password")) {
    return { field: "password-1", message: tr("errors.weak-password") };
  }
  return "invalid-token";
}

// on-error in app.main.ui.auth.recovery-request/recovery-form*.
export function recoveryRequestError(err: unknown, email: string): string | null {
  if (errorFields(err) === null) return null;
  const fields = errorFields(err) as RpcErrorFields;
  switch (fields.code) {
    case "profile-not-verified":
      return tr("auth.notifications.profile-not-verified");
    case "profile-is-muted":
      return tr("errors.profile-is-muted");
    case "email-has-permanent-bounces":
    case "email-has-complaints":
      return tr("errors.email-has-permanent-bounces", email);
    default:
      // The CLJS form rethrows anything else; the shell reports it generically.
      return tr("errors.generic");
  }
}

// show-redirect-error in app.main.data.auth: OIDC redirect failures arrive as
// an ?error= query parameter on the login route. "unable-to-auth" is an
// explicit user cancel and stays silent.
export function oidcRedirectError(error: string | null): string | null {
  if (error === null || error.length === 0) return null;
  switch (error) {
    case "registration-disabled":
      return tr("errors.registration-disabled");
    case "profile-blocked":
      return tr("errors.profile-blocked");
    case "auth-provider-not-allowed":
      return tr("errors.auth-provider-not-allowed");
    case "email-domain-not-allowed":
      return tr("errors.email-domain-not-allowed");
    case "unable-to-auth":
      return null;
    default:
      return tr("errors.generic");
  }
}

// on-error in app.main.ui.auth.login/login-form*. A banner is rendered inside
// the form (context-notification*), a toast goes through the notifications
// provider; the split matches which channel the CLJS form uses per code.
export type LoginError =
  | { kind: "banner"; message: string }
  | { kind: "toast"; message: string };

export function loginError(err: unknown): LoginError {
  const fields = errorFields(err);
  const type = fields?.type;
  const code = fields?.code;
  if (type === "restriction" && (code === "profile-blocked" || code === "admin-only-profile")) {
    return { kind: "banner", message: tr("errors.profile-blocked") };
  }
  if (type === "restriction" && code === "ldap-not-initialized") {
    return { kind: "toast", message: tr("errors.ldap-disabled") };
  }
  if (
    type === "validation" &&
    (code === "wrong-credentials" || code === "account-without-password")
  ) {
    return { kind: "banner", message: tr("errors.wrong-credentials") };
  }
  if (type === "rate-limit" && code === "account-locked") {
    const ttl = typeof fields?.ttl === "number" ? fields.ttl : 0;
    const minutes = Math.max(1, Math.ceil(ttl / 60));
    return { kind: "banner", message: tr("errors.account-locked", minutes) };
  }
  return { kind: "banner", message: tr("errors.generic") };
}

// --- verify-token dispatch -------------------------------------------------

// The failure reasons of static/invalid-token in app.main.ui.static.
export type InvalidTokenReason = "token-expired" | "email-mismatch" | "invalid-token";

export type VerifyTokenOutcome =
  | { kind: "logged-in"; iss: "verify-email" | "auth"; invitationToken?: string }
  | { kind: "email-changed" }
  | { kind: "invitation-accepted"; teamId: string; organizationName?: string }
  | { kind: "invitation-pending"; route: RouteName; invitationToken?: string }
  | { kind: "invalid"; reason: InvalidTokenReason }
  | { kind: "already-member"; teamId?: string }
  | { kind: "organization-not-found"; teamId?: string }
  | { kind: "canceled-invitation" }
  | { kind: "email-already-exists" }
  | { kind: "email-already-validated" }
  | { kind: "error" };

function routeName(value: unknown, fallback: RouteName): RouteName {
  return typeof value === "string" && value in routePaths ? (value as RouteName) : fallback;
}

// Pure translation of the handle-token multimethod plus the error branches of
// verify-token* in app.main.ui.auth.verify-token. Kept side-effect free so the
// page only performs the navigation and the notifications.
export function classifyVerifyToken(result: VerifyTokenResult): VerifyTokenOutcome {
  switch (result.iss) {
    case "verify-email":
    case "auth":
      return {
        kind: "logged-in",
        iss: result.iss,
        invitationToken:
          typeof result["invitation-token"] === "string" ? result["invitation-token"] : undefined,
      };
    case "change-email":
      return { kind: "email-changed" };
    case "team-invitation": {
      if (result.state === "created") {
        const teamId = String(result["organization-team-id"] ?? result["team-id"] ?? "");
        return {
          kind: "invitation-accepted",
          teamId,
          organizationName:
            typeof result["organization-name"] === "string" ? result["organization-name"] : undefined,
        };
      }
      return {
        kind: "invitation-pending",
        route: routeName(result["redirect-to"], "auth-register"),
        invitationToken:
          typeof result["invitation-token"] === "string" ? result["invitation-token"] : undefined,
      };
    }
    default:
      return { kind: "invalid", reason: "invalid-token" };
  }
}

// The rx/subs! error handler of verify-token*.
export function classifyVerifyTokenError(err: unknown): VerifyTokenOutcome {
  const fields = errorFields(err);
  if (fields === null) return { kind: "error" };
  const code = fields.code;
  const teamId = typeof fields["team-id"] === "string" ? (fields["team-id"] as string) : undefined;
  const reason = fields.reason;
  if (code === "invalid-token-already-member") return { kind: "already-member", teamId };
  if (code === "organization-not-found") return { kind: "organization-not-found", teamId };
  if (code === "canceled-invitation") return { kind: "canceled-invitation" };
  if (fields.type === "validation" || code === "invalid-token" || reason === "token-expired") {
    if (reason === "token-expired") return { kind: "invalid", reason: "token-expired" };
    if (reason === "email-mismatch") return { kind: "invalid", reason: "email-mismatch" };
    return { kind: "invalid", reason: "invalid-token" };
  }
  if (code === "email-already-exists") return { kind: "email-already-exists" };
  if (code === "email-already-validated") return { kind: "email-already-validated" };
  return { kind: "error" };
}
