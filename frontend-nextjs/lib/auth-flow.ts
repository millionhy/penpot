"use client";

// Shared navigation for the auth flows: what happens after a successful login
// and after a successful registration. Port of logged-in and
// login-from-register in app.main.data.auth plus the success branches of
// register-form* / register-validate-form*.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useNotifications } from "@/components/notifications";
import { applyPostLoginTarget, postLoginTarget } from "@/lib/auth";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { isAuthenticatedProfile, useSession } from "@/lib/session";
import { REGISTER_NS, userStorage } from "@/lib/storage";
import type { RegisterProfileResult } from "@/lib/types";

// Re-reads get-profile and, when the cookie really is set, navigates where
// logged-in would have navigated. Returns false when the backend did not
// authenticate the session (the misconfiguration case the CLJS login event
// comments about).
export function usePostLogin() {
  const router = useRouter();
  const { refresh } = useSession();
  return useCallback(async (): Promise<boolean> => {
    const profile = await refresh();
    if (!isAuthenticatedProfile(profile)) return false;
    applyPostLoginTarget(router, postLoginTarget(profile, window.location.href));
    return true;
  }, [router, refresh]);
}

// login-from-register: mark the session logged in after a registration that
// needs no email verification.
export function useRegisterSuccess() {
  const router = useRouter();
  const { error } = useNotifications();
  const completeLogin = usePostLogin();

  return useCallback(
    async (result: RegisterProfileResult): Promise<void> => {
      const invitationToken = result["invitation-token"];
      if (typeof invitationToken === "string" && invitationToken.length > 0) {
        const query = "?token=" + encodeURIComponent(invitationToken);
        router.push(routePaths["auth-verify-token"] + query);
        return;
      }
      if (result["is-active"] === true) {
        if (!(await completeLogin())) error(tr("errors.generic"));
        return;
      }
      // register-success-page* reads the address back from the user storage.
      userStorage.set(REGISTER_NS, "email", result.email);
      router.push(routePaths["auth-register-success"]);
    },
    [router, error, completeLogin],
  );
}
