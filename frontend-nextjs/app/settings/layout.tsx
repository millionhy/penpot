import { AuthGuard } from "@/components/auth-guard";

// Settings routes require an authenticated profile (F1.4 guard); the CLJS
// settings screens are only reachable through the profile-checked navigation
// flow.
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthGuard>{children}</AuthGuard>;
}