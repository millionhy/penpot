// Typed transport/RPC errors. Mirrors the :type classification produced by
// handle-response in frontend/src/app/main/repo.cljs so the Next.js shell reacts
// to transient vs. permanent failures exactly like the CLJS frontend.

export type RpcErrorType =
  | "network"
  | "bad-gateway"
  | "service-unavailable"
  | "offline"
  | "validation"
  | "authorization"
  | "challenge-required"
  | "nitrate-unavailable"
  | "nitrate-not-configured"
  | "internal";

export interface RpcErrorData {
  type: RpcErrorType | string;
  code?: string;
  hint?: string;
  status?: number;
  uri?: string;
  [key: string]: unknown;
}

export class RpcError extends Error {
  readonly data: RpcErrorData;
  constructor(message: string, data: RpcErrorData) {
    super(message);
    this.name = "RpcError";
    this.data = data;
  }
  get type(): RpcErrorType | string {
    return this.data.type;
  }
}

// Transient types are safe to retry for idempotent (GET) requests. This is the
// single source of truth, matching retryable-types in repo.cljs.
export const retryableTypes: ReadonlySet<string> = new Set([
  "network",
  "bad-gateway",
  "service-unavailable",
  "offline",
]);

export function isRetryable(err: unknown): boolean {
  return err instanceof RpcError && retryableTypes.has(String(err.data.type));
}