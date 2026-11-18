// Integrations page logic (G1). Headless port of
// app.main.ui.settings.integrations and the access-token surface of
// app.main.data.profile. Kept free of JSX so it runs in vitest's node
// environment, like lib/settings.ts.

import { tr } from "@/lib/i18n";
import { cmd } from "@/lib/rpc";

// get-access-tokens answers rows of the access_token table with :perms
// stripped; non-mcp rows also lose :token. The MCP row keeps the key in
// clear because the section builds the server URL from it
// (app.rpc.commands.access-token).
export interface AccessToken {
  id: string;
  name: string;
  type?: string | null;
  "created-at"?: Date;
  "updated-at"?: Date;
  "expires-at"?: Date | null;
  token?: string;
}

export interface CreateAccessTokenParams {
  name: string;
  // ::ct/duration strings ("720h"). The generated RpcParams types this as
  // number because the schema parser degrades the duration keyword, so the
  // command wrapper below carries the real shape.
  expiration?: string;
  type?: string;
}

export const mcpTokenType = "mcp";

export function fetchAccessTokens(): Promise<AccessToken[]> {
  return cmd<AccessToken[]>("get-access-tokens");
}

export function createAccessToken(params: CreateAccessTokenParams): Promise<AccessToken> {
  return cmd<AccessToken>("create-access-token", params);
}

export function deleteAccessToken(id: string): Promise<unknown> {
  return cmd("delete-access-token", { id });
}

export function isMcpToken(token: AccessToken): boolean {
  return token.type === mcpTokenType;
}

// access-tokens-section* keeps only the rows without a type.
export function userTokens(tokens: readonly AccessToken[] | null): AccessToken[] {
  return (tokens ?? []).filter((token) => token.type === undefined || token.type === null);
}

// mcp-server-section* seeks the first MCP row. The backend keeps one per
// profile: create-access-token deletes the other MCP rows of the profile.
export function findMcpToken(tokens: readonly AccessToken[] | null): AccessToken | null {
  return (tokens ?? []).find(isMcpToken) ?? null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// valid-mcp-token? in the CLJS: a token without expires-at never expires,
// and a token expires at the instant itself (the comparison is strict).
export function tokenValid(token: AccessToken | null, now: Date = new Date()): boolean {
  if (token === null) return false;
  const expiresAt = toDate(token["expires-at"]);
  if (expiresAt === null) return true;
  return expiresAt.getTime() > now.getTime();
}

// (-> profile :props :mcp-enabled boolean).
export function mcpEnabled(profile: { props?: { "mcp-enabled"?: boolean } } | null): boolean {
  return Boolean(profile?.props?.["mcp-enabled"]);
}

export interface ExpirationOption {
  value: string;
  labelKey: string;
}

// The select of create-token*: "never" plus the four duration presets.
export const expirationOptions: readonly ExpirationOption[] = [
  { value: "never", labelKey: "integrations.expiration-never" },
  { value: "720h", labelKey: "integrations.expiration-30-days" },
  { value: "1440h", labelKey: "integrations.expiration-60-days" },
  { value: "2160h", labelKey: "integrations.expiration-90-days" },
  { value: "4320h", labelKey: "integrations.expiration-180-days" },
];

// create-token* in the CLJS: the MCP key has a fixed name and type, and
// "never" means the expiration key is omitted instead of sent as a
// duration.
export function createTokenParams(input: {
  name: string;
  expiration: string;
  isMcp: boolean;
}): CreateAccessTokenParams {
  const params: CreateAccessTokenParams = { name: input.name };
  if (input.expiration !== "never") params.expiration = input.expiration;
  if (input.isMcp) {
    params.name = "MCP key";
    params.type = mcpTokenType;
  }
  return params;
}

// cf/mcp-server-url is (ensure-path-slash public-uri) + "mcp/stream"; the
// section appends ?userToken=<key>.
export function mcpServerUrl(publicUri: string, token: string): string {
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "mcp/stream?userToken=" + encodeURIComponent(token);
}

export const mcpHelpCenterUri = "https://help.penpot.app/mcp/";

// ct/format-inst "PPP" is date-fns' long date ("October 9, 2026"); Intl
// renders the same order for en-US, so no part reassembly is needed.
export function formatTokenDate(value: Date | string | null | undefined): string | null {
  const date = toDate(value);
  if (date === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export interface TokenSubtitle {
  text: string;
  warning: boolean;
}

// token-item* subtitle: no expiration, "Expires on %s", or the warning
// "Expired on %s" once the instant passed.
export function tokenSubtitle(token: AccessToken, now: Date = new Date()): TokenSubtitle {
  const expiresAt = toDate(token["expires-at"]);
  if (expiresAt === null) {
    return { text: tr("integrations.no-expiration"), warning: false };
  }
  const formatted = formatTokenDate(expiresAt) ?? "";
  if (expiresAt.getTime() < now.getTime()) {
    return { text: tr("integrations.expired-on", formatted), warning: true };
  }
  return { text: tr("integrations.expires-on", formatted), warning: false };
}
