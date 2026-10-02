import { AuthGuard } from "@/components/auth-guard";

// Dashboard routes require an authenticated profile (F1.4 guard); the CLJS
// dashboard is only reachable through the profile-checked navigation flow.
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}