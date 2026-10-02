import { redirect } from "next/navigation";

// Bootstrap route. Mirrors the empty-token branch of on-navigate in
// frontend/src/app/main/ui/routes.cljs: an authenticated profile lands on
// /dashboard/recent, an anonymous one on /auth/login. Authentication is a
// client-side concern (cookie auth-token), so the shell starts at login; the
// login page forwards to the dashboard once get-profile succeeds.
export default function RootPage() {
  redirect("/auth/login");
}