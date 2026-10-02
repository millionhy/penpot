// Placeholder for the generated Penpot RPC types.
//
// The authoritative types are generated from the backend RPC surface
// (/api/main/methods/*, 400+ commands) via the contract tooling described in
// rewrite.md (task F1.2). Until the generator runs, this module exports nothing
// and the shell uses the hand-written slice in frontend-nextjs/lib/types.ts.
//
// Target generated shape:
//   export type RpcCommandName = "get-profile" | "login-with-password" | ...;
//   export interface RpcParamsMap { "get-profile": {}; "login-with-password": { email: string; password: string }; }
//   export interface RpcResultMap { "get-profile": Profile; }

export {};