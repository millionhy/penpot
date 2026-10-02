import { RouteStub } from "@/components/route-stub";
import { AuthGuard } from "@/components/auth-guard";

export default function Page() {
  return (
    <AuthGuard>
      <RouteStub title="Viewer" cljs="app.main.ui.viewer" />
    </AuthGuard>
  );
}