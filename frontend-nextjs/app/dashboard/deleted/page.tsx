import { RouteStub } from "@/components/route-stub";

// Rendered inside the F5.1 dashboard shell (layout.tsx); the page itself
// migrates in F5.3.
export default function Page() {
  return <RouteStub title="Dashboard / Deleted" cljs="app.main.ui.dashboard.deleted" />;
}
