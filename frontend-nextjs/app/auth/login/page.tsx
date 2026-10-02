"use client";

// Port of app.main.ui.auth.login/login-page* and login-form*. This was the P0
// vertical slice (login-with-password plus a get-profile refresh); F3 brings it
// onto the shared form, i18n, notification and layout primitives and adds the
// error mapping, the login-redirect handshake and the register/forgot links.
//
// Not migrated yet: sso-buttons* and the get-sso-provider detour that reveals
// the password field for custom-SSO deployments. Both need the OIDC provider
// configuration, so the password field is always shown and the password is a
// required field here (the CLJS schema marks it optional only for that flow).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { QueryParams } from "@/components/query-params";
import { ContextNotification } from "@/components/context-notification";
import { useNotifications } from "@/components/notifications";
import { loginError } from "@/lib/auth";
import { usePostLogin } from "@/lib/auth-flow";
import { hasFlag } from "@/lib/config";
import { Field, Form, SubmitButton } from "@/components/form";
import { useForm, type CleanData, type FieldSpecs } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { cmd } from "@/lib/rpc";
import { routePaths } from "@/lib/routes";
import { clearLoginRedirect, storeLoginRedirect } from "@/lib/storage";
import type { LoginWithPasswordParams } from "@/lib/types";

const showPasswordLogin = hasFlag("login") || hasFlag("login-with-password");
const showRegistration = hasFlag("registration");

// schema:login-form in login.cljs.
const specs: FieldSpecs = {
  email: { type: "email" },
  password: { type: "text" },
};

function LoginContent({ params }: { params: URLSearchParams }) {
  const form = useForm({ specs, initial: { email: params.get("email") ?? "" } });
  const notifications = useNotifications();
  const completeLogin = usePostLogin();
  const [banner, setBanner] = useState<string | null>(null);
  const callbackUrl = params.get("callback-url");
  const invitationToken = params.get("invitation-token");

  // store-login-redirect / clear-login-redirect in login.cljs: an OIDC
  // callback-url is remembered so logged-in can send the user back.
  useEffect(() => {
    if (callbackUrl !== null && callbackUrl.length > 0) storeLoginRedirect(callbackUrl);
    else clearLoginRedirect();
  }, [callbackUrl]);

  const onSubmit = useCallback(
    async (data: CleanData) => {
      form.setSubmitted(true);
      setBanner(null);
      try {
        const request: LoginWithPasswordParams = {
          email: String(data.email),
          password: String(data.password ?? ""),
          ...(invitationToken !== null ? { "invitation-token": invitationToken } : {}),
        };
        // NOTE: the profile is re-read with get-profile rather than taken from
        // the login response, because a successful login can still leave the
        // cookie unset on a misconfigured deployment (see da/login).
        await cmd("login-with-password", request);
        if (!(await completeLogin())) setBanner(tr("errors.generic"));
      } catch (err) {
        const mapped = loginError(err);
        if (mapped.kind === "banner") setBanner(mapped.message);
        else notifications.error(mapped.message);
      } finally {
        form.setSubmitted(false);
      }
    },
    [form, invitationToken, completeLogin, notifications],
  );

  return (
    <div className="auth-wrapper">
      <h1 className="auth-title" data-testid="login-title">
        {tr("auth.login-account-title")}
      </h1>
      <p className="auth-tagline">{tr("auth.login-tagline")}</p>

      {hasFlag("demo-warning") ? (
        <ContextNotification level="warning">{tr("auth.demo-warning")}</ContextNotification>
      ) : null}

      {banner !== null ? <ContextNotification level="error">{banner}</ContextNotification> : null}

      <Form form={form} onSubmit={onSubmit} className="auth-form">
        <Field
          name="email"
          label={tr("auth.work-email")}
          type="email"
          autoComplete="email"
          testId="email-input"
        />
        <Field
          name="password"
          label={tr("auth.password")}
          type="password"
          autoComplete="current-password"
          autoFocus
        />

        {showPasswordLogin ? (
          <div className="auth-row">
            <Link className="auth-row-link" href={routePaths["auth-recovery-request"]} data-testid="forgot-password">
              {tr("auth.forgot-password")}
            </Link>
          </div>
        ) : null}

        {showPasswordLogin ? (
          <SubmitButton label={tr("labels.continue")} testId="login-submit" />
        ) : null}
      </Form>

      <hr className="auth-separator" />

      <div className="auth-links">
        {showRegistration ? (
          <div className="auth-row">
            <span className="auth-row-text">{tr("auth.register")} </span>
            <Link className="auth-row-link" href={routePaths["auth-register"]} data-testid="register-submit">
              {tr("auth.register-submit")}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <QueryParams>
      {(params) => <LoginContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
