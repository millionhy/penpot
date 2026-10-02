// RPC command types are GENERATED from the backend malli schemas
// (packages/api-types, task F1.2; regenerate with
// node packages/api-types/scripts/generate-types.mjs). This module bridges the
// generated surface to the shell with aliases for the pages migrated so far.

import type { RpcCommandName, RpcParams, RpcResults } from "@penpot/api-types";
import type { RouteName } from "./routes";

export type { RpcCommandName, RpcParams, RpcResults };

// Profile as returned by get-profile (backend schema:profile). NOTE: the
// anonymous profile (zero uuid) only carries id/fullname/subscription at
// runtime even though the schema marks more fields required.
export type Profile = RpcResults["get-profile"];

export type LoginWithPasswordParams = RpcParams["login-with-password"];

// --- auth (F3) ---

// The login/register/verify-token responses can carry an invitation token that
// the profile itself does not, so the flows pass this widened shape around
// (see :invitation-token handling in app.main.data.auth/logged-in).
export interface SessionProfile extends Profile {
  "invitation-token"?: string;
}

export type PrepareRegisterProfileParams = RpcParams["prepare-register-profile"];
export type RegisterProfileParams = RpcParams["register-profile"];
export type RequestProfileRecoveryParams = RpcParams["request-profile-recovery"];
export type RecoverProfileParams = RpcParams["recover-profile"];
export type VerifyTokenParams = RpcParams["verify-token"];

export interface PrepareRegisterProfileResult {
  token: string;
}

// register-profile answers with one of three shapes
// (backend/src/app/rpc/commands/auth.clj): {id email invitation-token} plus a
// session when an active profile accepts a team invitation, the stripped
// profile plus a session when the profile is already active, and {id email}
// when a verification email was just sent.
export interface RegisterProfileResult {
  id: string;
  email: string;
  "invitation-token"?: string;
  "is-active"?: boolean;
  fullname?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateDemoProfileResult {
  email: string;
  password: string;
}

// The :iss values of the process-token multimethod in
// backend/src/app/rpc/commands/verify_token.clj.
export type VerifyTokenIss = "verify-email" | "change-email" | "auth" | "team-invitation";
export type VerifyTokenInvitationState = "created" | "pending";

export interface VerifyTokenResult {
  iss: VerifyTokenIss | string;
  "profile-id"?: string;
  profile?: Profile;
  email?: string;
  "invitation-token"?: string;
  state?: VerifyTokenInvitationState | string;
  "team-id"?: string;
  "organization-team-id"?: string;
  "organization-name"?: string;
  // Route name keyword, decoded to a string by lib/transit.ts.
  "redirect-to"?: RouteName | string;
  "member-id"?: string;
  [key: string]: unknown;
}

// Hand-written until the dashboard migration (F5) consumes the generated
// get-teams result.
export interface Team {
  id: string;
  name: string;
  [key: string]: unknown;
}
