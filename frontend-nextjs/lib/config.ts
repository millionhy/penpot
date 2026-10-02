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
  // Legal links rendered on the register page. The CLJS app reads them from
  // globalThis.penpotTermsOfServiceURI / penpotPrivacyPolicyURI injected by the
  // SaaS host; the shell resolves them from the environment instead so the
  // value is identical on the server and the client (no hydration mismatch).
  termsOfServiceUri: string | null;
  privacyPolicyUri: string | null;
}

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function readOptionalEnv(name: string): string | null {
  const value = readEnv(name, "");
  return value.length > 0 ? value : null;
}

// Port of `default` in common/src/app/common/flags.cljc, already normalized:
// flags/parse strips the enable- prefix, so these are the resulting names.
const defaultFlags: readonly string[] = [
  "registration",
  "login-with-password",
  "export-file-v3",
  "frontend-svgo",
  "exporter-svgo",
  "backend-svgo",
  "backend-api-doc",
  "backend-openapi-doc",
  "backend-worker",
  "secure-session-cookies",
  "email-verification",
  "onboarding",
  "dashboard-templates-section",
  "google-fonts-provider",
  "component-thumbnails",
  "render-wasm-dpr",
  "token-color",
  "token-shadow",
  "token-typography-row",
  "inspect-styles",
  "feature-fdata-objects-map",
  "feature-render-wasm",
  "token-import-from-library",
  "render-switch",
  "render-wasm-info",
  "available-viewer-wasm",
  "background-blur",
  "stroke-path",
  "stroke-per-side",
  "token-combobox",
  "custom-shortcuts",
  "token-lib-sync",
  "link-unfurl",
];

// Port of flags/parse: "enable-x" adds x, "disable-x" removes x, and a bare
// name is ignored. NEXT_PUBLIC_PENPOT_FLAGS uses the same syntax as the
// penpotFlags global the CLJS app reads, so both frontends agree.
export function parseFlags(
  tokens: Iterable<string>,
  initial: Iterable<string> = [],
): Set<string> {
  const result = new Set(initial);
  for (const token of tokens) {
    if (token.startsWith("enable-")) result.add(token.slice("enable-".length));
    else if (token.startsWith("disable-")) result.delete(token.slice("disable-".length));
  }
  return result;
}

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "ss-" + Math.random().toString(36).slice(2);
}

const envFlagTokens = readEnv("NEXT_PUBLIC_PENPOT_FLAGS", "")
  .split(/[,\s]+/)
  .filter(Boolean);

export const config: PenpotConfig = {
  publicUri: readEnv("NEXT_PUBLIC_PENPOT_PUBLIC_URI", ""),
  backendOrigin: readEnv("NEXT_PUBLIC_PENPOT_BACKEND_ORIGIN", "http://localhost:6060"),
  sessionId: makeSessionId(),
  flags: [...parseFlags(envFlagTokens, defaultFlags)],
  termsOfServiceUri: readOptionalEnv("NEXT_PUBLIC_PENPOT_TERMS_OF_SERVICE_URI"),
  privacyPolicyUri: readOptionalEnv("NEXT_PUBLIC_PENPOT_PRIVACY_POLICY_URI"),
};

export function hasFlag(flag: string): boolean {
  return config.flags.includes(flag);
}
