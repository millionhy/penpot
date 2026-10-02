"use client";

// P0 vertical slice: the first page migrated end-to-end. Proves the transport by
// calling login-with-password, then refreshes the shared session (get-profile),
// exactly like app.main.data.auth in the CLJS frontend.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cmd } from "@/lib/rpc";
import { RpcError } from "@/lib/errors";
import { isAuthenticatedProfile, useSession } from "@/lib/session";
import { routePaths } from "@/lib/routes";
import type { LoginWithPasswordParams } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const params: LoginWithPasswordParams = { email, password };
      await cmd("login-with-password", params);
      const profile = await refresh();
      if (!isAuthenticatedProfile(profile)) {
        throw new RpcError("not authenticated", { type: "authorization" });
      }
      router.push(routePaths["dashboard-recent"]);
    } catch (err) {
      const data = err instanceof RpcError ? err.data : { type: "internal" };
      const code = data.code ? " / " + String(data.code) : "";
      setError(String(data.type) + code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pp-page">
      <h1>Log in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <br />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <br />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="pp-muted">
          {error}
        </p>
      ) : null}
      <p className="pp-muted">Next.js shell - migrated route: auth-login</p>
    </main>
  );
}