"use client";

// P0 vertical slice: the first page migrated end-to-end. Proves the transport by
// calling login-with-password then get-profile, exactly like app.main.data.auth
// in the CLJS frontend. get-profile already declares ::sm/result in the backend,
// so it needs no backend change to consume.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cmd } from "@/lib/rpc";
import { RpcError } from "@/lib/errors";
import type { LoginWithPasswordParams, Profile } from "@/lib/types";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export default function LoginPage() {
  const router = useRouter();
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
      await cmd<Profile>("login-with-password", params);
      const profile = await cmd<Profile>("get-profile");
      if (!profile || profile.id === ZERO_UUID) {
        throw new RpcError("not authenticated", { type: "authorization" });
      }
      router.push("/dashboard/recent");
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