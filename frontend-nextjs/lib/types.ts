// RPC command types are GENERATED from the backend malli schemas
// (packages/api-types, task F1.2; regenerate with
// node packages/api-types/scripts/generate-types.mjs). This module bridges the
// generated surface to the shell with aliases for the pages migrated so far.

import type { RpcCommandName, RpcParams, RpcResults } from "@penpot/api-types";

export type { RpcCommandName, RpcParams, RpcResults };

// Profile as returned by get-profile (backend schema:profile). NOTE: the
// anonymous profile (zero uuid) only carries id/fullname/subscription at
// runtime even though the schema marks more fields required.
export type Profile = RpcResults["get-profile"];

export type LoginWithPasswordParams = RpcParams["login-with-password"];

// Hand-written until the dashboard migration (F5) consumes the generated
// get-teams result.
export interface Team {
  id: string;
  name: string;
  [key: string]: unknown;
}