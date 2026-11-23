# Frontend (retired)

The ClojureScript SPA that used to live in `frontend/src` was deleted in G4.7.
The Next.js application in `frontend-nextjs/` replaces it; read
`mem:frontend-nextjs/core` for the current conventions.

What remains under `frontend/`:

- `packages/draft-js`, `packages/mousetrap`, `packages/tokenscript`,
  `packages/ui` and `text-editor`: framework-free JavaScript packages.
- `packages/ui/src/styles/ds/`: the design-system SCSS foundation, moved out of
  the deleted CLJS tree so `@penpot/ui` can still build.
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`: the small workspace
  that installs those packages. Build the design system with
  `pnpm run build:ui`.

Do not add Clojure or ClojureScript here. Read old `.cljs` sources from git
history when a port needs the original behaviour.
