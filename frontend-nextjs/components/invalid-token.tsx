// Port of static/invalid-token in app.main.ui.static: the card verify-token
// renders when the token is unusable, with copy chosen by the failure reason.

import Link from "next/link";
import type { InvalidTokenReason } from "@/lib/auth";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";

export function InvalidToken({ reason }: { reason: InvalidTokenReason }) {
  return (
    <div className="auth-invalid-token">
      <img className="auth-invalid-token-logo" src="/images/logo-error-screen.svg" alt="" />

      {reason === "email-mismatch" ? (
        <div className="auth-invalid-token-main">{tr("errors.invite-email-mismatch")}</div>
      ) : null}

      {reason === "token-expired" ? (
        <div className="auth-invalid-token-main">{tr("errors.invite-expired")}</div>
      ) : null}

      {reason === "invalid-token" ? (
        <>
          <div className="auth-invalid-token-main">{tr("errors.invite-invalid")}</div>
          <div className="auth-invalid-token-desc">{tr("errors.invite-invalid.info")}</div>
        </>
      ) : null}

      <Link className="auth-go-back" href={routePaths["auth-login"]}>
        {tr("labels.login")}
      </Link>
    </div>
  );
}
