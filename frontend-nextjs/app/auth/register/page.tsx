"use client";

// Port of app.main.ui.auth.register/register-page* and register-form*.
//
// Registration is two RPC calls: prepare-register-profile validates the
// attempt and mints a prepared-register token, register-profile exchanges it
// for the profile. The three success branches (invitation token, already
// active, verification email sent) live in useRegisterSuccess.
//
// Not migrated yet: the SSO buttons (sso-buttons*). They need the OIDC
// provider list and login-with-oidc, which no shell page consumes so far.

import { useCallback, useState } from "react";
import Link from "next/link";
import { ContextNotification } from "@/components/context-notification";
import { QueryParams } from "@/components/query-params";
import { useNotifications } from "@/components/notifications";
import {
  createDemoProfile,
  prepareRegisterProfile,
  registerFieldError,
  registerProfile,
} from "@/lib/auth";
import { cmd } from "@/lib/rpc";
import { hasFlag } from "@/lib/config";
import { Checkbox, Field, Form, SubmitButton } from "@/components/form";
import { Tr } from "@/components/tr";
import { useForm, type CleanData, type FieldSpecs } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { usePostLogin, useRegisterSuccess } from "@/lib/auth-flow";

const requireTerms = hasFlag("terms-and-privacy-checkbox");

// schema:register-form in register.cljs.
const specs: FieldSpecs = {
  fullname: { type: "text", max: 250 },
  email: { type: "email" },
  password: { type: "password" },
  "accept-terms-and-privacy": {
    type: "checkbox",
    optional: !requireTerms,
    mustBeTrue: requireTerms,
  },
  "accept-newsletter-updates": { type: "checkbox", optional: true },
};

function RegisterForm({
  invitationToken,
  initialEmail,
}: {
  invitationToken: string | null;
  initialEmail: string | null;
}) {
  const form = useForm({ specs, initial: { email: initialEmail ?? "" } });
  const onSuccess = useRegisterSuccess();
  const { error: notifyError } = useNotifications();

  const onSubmit = useCallback(
    async (data: CleanData) => {
      form.setSubmitted(true);
      form.clearFieldErrors();
      const newsletter = data["accept-newsletter-updates"] === true;
      try {
        const prepared = await prepareRegisterProfile({
          fullname: String(data.fullname),
          email: String(data.email),
          password: String(data.password),
          ...(newsletter ? { "accept-newsletter-updates": true } : {}),
          ...(invitationToken !== null ? { "invitation-token": invitationToken } : {}),
        });
        // register-profile only takes the prepared token: the newsletter
        // preference already travelled inside it.
        const result = await registerProfile({ token: prepared.token });
        await onSuccess(result);
      } catch (err) {
        const mapped = registerFieldError(err);
        if (mapped !== null) form.setFieldError(mapped.field, mapped.message);
        else notifyError(tr("errors.generic"));
      } finally {
        form.setSubmitted(false);
      }
    },
    [form, invitationToken, onSuccess, notifyError],
  );

  return (
    <Form form={form} onSubmit={onSubmit} className="auth-form">
      <Field name="fullname" label={tr("auth.fullname")} autoComplete="name" />
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
        hint={tr("auth.password-length-hint")}
        type="password"
        autoComplete="new-password"
      />

      {requireTerms ? (
        <Checkbox
          name="accept-terms-and-privacy"
          label={<Tr k="auth.terms-and-privacy-agreement" />}
        />
      ) : null}

      <Checkbox name="accept-newsletter-updates" label={tr("onboarding-v2.newsletter.updates")} />

      <SubmitButton label={tr("auth.register-submit")} testId="register-form-submit" />
    </Form>
  );
}

function RegisterContent({ params }: { params: URLSearchParams }) {
  const { error: notifyError } = useNotifications();
  const completeLogin = usePostLogin();
  const [creatingDemo, setCreatingDemo] = useState(false);

  // create-demo-profile answers with the generated credentials, which are then
  // fed straight into the login command (da/create-demo-profile).
  const onCreateDemo = useCallback(async () => {
    setCreatingDemo(true);
    try {
      const demo = await createDemoProfile();
      await cmd("login-with-password", { email: demo.email, password: demo.password });
      if (!(await completeLogin())) notifyError(tr("errors.generic"));
    } catch {
      notifyError(tr("errors.generic"));
    } finally {
      setCreatingDemo(false);
    }
  }, [completeLogin, notifyError]);

  return (
    <div className="auth-wrapper auth-wrapper-register">
      <h1 className="auth-title" data-testid="registration-title">
        {tr("auth.register-title")}
      </h1>

      {hasFlag("demo-warning") ? (
        <ContextNotification level="warning">{tr("auth.demo-warning")}</ContextNotification>
      ) : null}

      {hasFlag("login-with-password") ? (
        <RegisterForm
          invitationToken={params.get("invitation-token")}
          initialEmail={params.get("email")}
        />
      ) : null}

      <div className="auth-links">
        <div className="auth-row">
          <span className="auth-row-text">{tr("auth.already-have-account")} </span>
          <Link className="auth-row-link" href={routePaths["auth-login"]} data-testid="login-here-link">
            {tr("auth.login-here")}
          </Link>
        </div>

        {hasFlag("demo-users") ? (
          <>
            <hr className="auth-separator" />
            <div className="auth-row">
              <button
                type="button"
                className="auth-row-link"
                onClick={() => void onCreateDemo()}
                disabled={creatingDemo}
              >
                {tr("auth.create-demo-account")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <QueryParams>
      {(params) => <RegisterContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
