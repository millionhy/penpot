---
title: 3.05. Frontend Guide
desc: "See Penpot's technical guide: self-hosting, configuration, developer insights (architecture, data model), frontend, backend, and integrations & more!"
---

# Frontend Guide

The web application lives in `frontend-nextjs/`. It is a Next.js 15 App Router
project written in TypeScript. The old ClojureScript application in `frontend/`
was removed in G4.7, after every route and canvas runtime had moved to the new
shell.

## Layout

- `frontend-nextjs/app/` holds the route tree: auth, settings, dashboard, view
  and workspace.
- `frontend-nextjs/components/` holds the view components.
- `frontend-nextjs/lib/` holds the headless logic. This includes the RPC
  transport, the Transit codec, the i18n catalogs, and the TypeScript render
  engine under `lib/render-wasm/`.
- `frontend-nextjs/translations/` holds the gettext sources.
- `frontend-nextjs/public/fonts/` holds the builtin Source Sans Pro faces that
  the render engine fetches at runtime.

The render engine is TypeScript. It drives the same `render-wasm` artifact as
before: one module per page, with the workspace, viewer and thumbnail worker
each using a single WebGL or OffscreenCanvas context. See
`frontend-nextjs/README.md` for the engine internals.

## Commands

Run these from `frontend-nextjs/`:

```bash
pnpm install
pnpm dev          # http://localhost:3450
pnpm typecheck
pnpm test
pnpm translations # regenerate lib/translations/*.ts
```

The shell talks to the Clojure backend over Transit RPC at `/api/main/methods`.
It does not require the removed ClojureScript build, Shadow CLJS, or Storybook.

## Shared packages

`frontend/packages/` and `frontend/text-editor/` remain as a small JavaScript
workspace. The Next.js shell does not import them today; they stay available
for the design-system and text-editor work that follows. Build the design
system with `pnpm run build:ui` from `frontend/`.
