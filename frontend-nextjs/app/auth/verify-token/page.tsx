"use client";

// Port of app.main.ui.auth.verify-token/verify-token*: exchange a token from an
// email link (or an invitation) for whatever it stands for, then route on.
// The command is anonymous and the backend creates the session cookie for the
// :verify-email issuer, so the shell re-reads get-profile instead of trusting
// the profile carried in the response.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QueryParams } from "@/components/query-params";
import { InvalidToken } from "@/components/invalid-token";
import { useNotifications } from "@/components/notifications";
import {
  applyPostLoginTarget,
  classifyVerifyToken,
  classifyVerifyTokenError,
  postLoginTarget,
  verifyToken,
  type InvalidTokenReason,
  type VerifyTokenOutcome,
} from "@/lib/auth";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { isAuthenticatedProfile, useSession } from "@/lib/session";

function dashboardRecent(teamId?: string): string {
  const base = routePaths["dashboard-recent"];
  return teamId !== undefined && teamId.length > 0
    ? base + "?team-id=" + encodeURIComponent(teamId)
    : base;
}

function Loader() {
  return (
    <div className="auth-loader">
      <img className="auth-loader-spinner" src="/images/loader.svg" alt="" />
      <span className="auth-notification-text">{tr("labels.loading")}</span>
    </div>
  );
}

function VerifyTokenContent({ params }: { params: URLSearchParams }) {
  const router = useRouter();
  const { refresh, profile } = useSession();
  const notifications = useNotifications();
  const [reason, setReason] = useState<InvalidTokenReason | null>(null);
  const token = params.get("token");
  const processed = useRef<string | null>(null);
  const handleRef = useRef<(outcome: VerifyTokenOutcome) => Promise<void>>(async () => undefined);

  const handle = useCallback(
    async (outcome: VerifyTokenOutcome) => {
      switch (outcome.kind) {
        case "logged-in": {
          const next = await refresh();
          if (!isAuthenticatedProfile(next)) {
            notifications.error(tr("errors.generic"));
            router.push(routePaths["auth-login"]);
            return;
          }
          if (outcome.iss === "verify-email") {
            notifications.success(tr("dashboard.notifications.email-verified-successfully"));
          }
          const withInvitation =
            outcome.invitationToken !== undefined
              ? { ...next, "invitation-token": outcome.invitationToken }
              : next;
          applyPostLoginTarget(router, postLoginTarget(withInvitation, window.location.href));
          return;
        }
        case "email-changed": {
          notifications.success(tr("dashboard.notifications.email-changed-successfully"));
          await refresh();
          router.push(routePaths["settings-profile"]);
          return;
        }
        case "invitation-accepted": {
          await refresh();
          router.push(dashboardRecent(outcome.teamId));
          notifications.success(
            outcome.organizationName !== undefined
              ? tr("auth.notifications.organization-invitation-accepted", outcome.organizationName)
              : tr("auth.notifications.team-invitation-accepted"),
          );
          return;
        }
        case "invitation-pending": {
          const path = routePaths[outcome.route] ?? routePaths["auth-register"];
          const query =
            outcome.invitationToken !== undefined
              ? "?invitation-token=" + encodeURIComponent(outcome.invitationToken)
              : "";
          router.push(path + query);
          return;
        }
        case "invalid":
          setReason(outcome.reason);
          return;
        case "already-member":
          router.push(dashboardRecent(outcome.teamId));
          return;
        case "organization-not-found":
          router.push(dashboardRecent(outcome.teamId));
          notifications.error(tr("errors.organization-not-found"));
          return;
        case "canceled-invitation":
          if (isAuthenticatedProfile(profile)) router.push(dashboardRecent());
          else router.push(routePaths["auth-login"]);
          notifications.warn(tr("notifications.invitation-canceled"));
          return;
        case "email-already-exists":
          notifications.error(tr("errors.email-already-exists"));
          router.push(routePaths["auth-login"]);
          return;
        case "email-already-validated":
          notifications.warn(tr("errors.email-already-validated"));
          router.push(routePaths["auth-login"]);
          return;
        default:
          notifications.error(tr("errors.generic"));
          router.push(routePaths["auth-login"]);
      }
    },
    [notifications, profile, refresh, router],
  );

  useEffect(() => {
    handleRef.current = handle;
  }, [handle]);

  useEffect(() => {
    document.title = tr("title.default");
    if (token === null || token.length === 0) {
      setReason("invalid-token");
      return;
    }
    // verify-token is a one-shot exchange (an invitation token is unusable
    // after the first call), so this effect must not re-run when a dependency
    // such as the session profile changes: the handler is reached through a
    // ref and the token is recorded as processed, which also stops the React
    // StrictMode double invocation from spending the token twice.
    if (processed.current === token) return;
    processed.current = token;
    let active = true;
    verifyToken(token)
      .then((result) => {
        if (active) void handleRef.current(classifyVerifyToken(result));
      })
      .catch((err) => {
        if (active) void handleRef.current(classifyVerifyTokenError(err));
      });
    return () => {
      active = false;
    };
  }, [token]);

  return reason !== null ? <InvalidToken reason={reason} /> : <Loader />;
}

export default function VerifyTokenPage() {
  return (
    <QueryParams>
      {(params) => <VerifyTokenContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
