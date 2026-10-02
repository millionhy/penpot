# @penpot/api-types

Generated TypeScript types for the Penpot RPC surface (rewrite.md task F1.2).
The Clojure backend is scanned statically and never modified.

## Pipeline

1. `pnpm scan` (`scripts/scan-rpc-inventory.mjs`, task S1) extracts every
   `sv/defmethod` registration in `backend/src` into `rpc-inventory.json`
   (name, namespace, file, line, auth requirement, schema references).
2. `pnpm generate` (`scripts/generate-types.mjs`) resolves those references
   against the malli schema defs in `backend/src` + `common/src` (including
   ns aliases, `:as-alias`, `:refer`, qualified symbols and the
   `app.common.schema` primitives) and writes `src/index.ts` with
   `RpcCommandName`, `RpcPublicCommandName`, `RpcParams` and `RpcResults`.

Current snapshot: 186 commands; params typed for 184, results for the 51
commands that declare `::sm/result`. Dynamic schemas in the file-data domain
(path content, file changes, token libs, profile props) degrade to `unknown`
and are reported by the generator; they get proper types when the
viewer/workspace phases (F6/F9) port them.

## Usage

`frontend-nextjs` consumes it as a `workspace:*` dependency with
`transpilePackages` (the package ships raw TS). See
`frontend-nextjs/lib/types.ts` for the bridge aliases.