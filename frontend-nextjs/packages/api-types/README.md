# @penpot/api-types (placeholder)

Generated TypeScript types for the Penpot RPC surface. Type generation (F1.2)
is not implemented yet; the RPC inventory (S1) is available.

- Source of truth: the backend RPC registry (`/api/main/methods/*`) and, once
  available, `api/openapi.json`.
- Inventory: `rpc-inventory.json`, regenerate with
  `node scripts/scan-rpc-inventory.mjs` (static, read-only scan of every
  `sv/defmethod` in `backend/src`). Records name, namespace, file, line,
  auth requirement, docstring, `::doc/added` version and the raw
  `::sm/params` / `::sm/result` schema references of each command.
- Status: the shell currently uses the hand-written slice in
  `frontend-nextjs/lib/types.ts`.
- Wiring it into the app (add as a dependency + `transpilePackages`) plus the
  malli-schema to TS type generator are tracked as rewrite.md task F1.2.