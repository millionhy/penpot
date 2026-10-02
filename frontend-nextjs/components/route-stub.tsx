// Shared placeholder for migrated-but-not-yet-implemented routes. Keeps the App
// Router tree complete and compilable while each page is ported from
// frontend/src/app/main/ui/<area> during Phase F.
export function RouteStub({ title, cljs }: { title: string; cljs: string }) {
  return (
    <main className="pp-page">
      <h1>{title}</h1>
      <p className="pp-muted">
        Route scaffolded in the Next.js shell. Not yet migrated from the
        ClojureScript reference <code>{cljs}</code>.
      </p>
      <p className="pp-muted">
        Tracking: rewrite.md Phase F. The Clojure backend is unchanged.
      </p>
    </main>
  );
}