import { RouteStub } from "@/components/route-stub";
import { AuthGuard } from "@/components/auth-guard";

export default function Page() {
  return (
    <AuthGuard>
      <RouteStub title="Workspace" cljs="app.main.ui.workspace" />
    </AuthGuard>
  );
}