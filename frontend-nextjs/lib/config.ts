// Runtime configuration for the Next.js shell. Mirrors the subset of
// frontend/src/app/config.cljs that the RPC transport and routing need.

export interface PenpotConfig {
  // Same-origin base URL. Empty string => relative URLs, proxied by Next
  // rewrites in dev and by nginx in production (exactly like cf/public-uri).
  publicUri: string;
  // Direct backend origin, used for the WebSocket collab channel (Next rewrites
  // do not forward the HTTP upgrade) and for dev without the proxy.
  backendOrigin: string;
  // Per-tab session id, sent as x-session-id (see send! in repo.cljs).
  sessionId: string;
  // Feature flags resolved from the host (cf/flags).
  flags: string[];
}

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "ss-" + Math.random().toString(36).slice(2);
}

export const config: PenpotConfig = {
  publicUri: readEnv("NEXT_PUBLIC_PENPOT_PUBLIC_URI", ""),
  backendOrigin: readEnv("NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN", "http://localhost:6060"),
  sessionId: makeSessionId(),
  flags: readEnv("NEXT_PUBLIC_PENPOT_FLAGS", "")
    .split(/[,\s]+/)
    .filter(Boolean),
};

export function hasFlag(flag: string): boolean {
  return config.flags.includes(flag);
}