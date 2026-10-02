"use client";

// Session bootstrap (F1.4). Mirrors the profile-driven branches of
// on-query-navigate in frontend/src/app/main/ui/routes.cljs: the shell calls
// get-profile once on load; a zero-uuid profile means anonymous (the backend
// returns it for auth-less requests because ::rpc/auth is false), anything
// else means authenticated. The cookie (auth-token) is HttpOnly, so this must
// run client-side with credentials included by lib/rpc.ts.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cmd } from "@/lib/rpc";
import type { Profile } from "@/lib/types";

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface SessionState {
  status: SessionStatus;
  profile: Profile | null;
  // Re-fetch get-profile (after login/logout). Resolves to the new profile.
  refresh: () => Promise<Profile | null>;
}

const defaultValue: SessionState = {
  status: "loading",
  profile: null,
  refresh: async () => null,
};

const SessionContext = createContext<SessionState>(defaultValue);

export function isAuthenticatedProfile(profile: Profile | null): boolean {
  return profile !== null && profile !== undefined && profile.id !== ZERO_UUID;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");

  const refresh = useCallback(async (): Promise<Profile | null> => {
    try {
      const next = (await cmd<Profile>("get-profile")) ?? null;
      setProfile(next);
      setStatus(isAuthenticatedProfile(next) ? "authenticated" : "anonymous");
      return next;
    } catch {
      // Network/backend failure: treat as anonymous so guards can redirect to
      // login; pages that need hard failures call cmd() directly.
      setProfile(null);
      setStatus("anonymous");
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({ status, profile, refresh }),
    [status, profile, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}