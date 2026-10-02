"use client";

// Port of app.main.ui.auth.register/register-validate-page*. Reached from the
// OIDC signup redirect (?screen=auth-register-validate&token=...&fullname=...
// in backend/src/app/auth/oidc.clj redirect-to-register), where the profile is
// already prepared and only has to be confirmed.

import Link from "next/link";
import { QueryParams } from "@/components/query-params";
import { useNotifications } from "@/components/notifications";
import { registerProfile } from "@/lib/auth";
import { useRegisterSuccess } from "@/lib/auth-flow";
import { hasFlag } from "@/lib/config";
import { Checkbox, Field, Form, SubmitButton } from "@/components/form";
import { Tr } from "@/components/tr";
import { useForm, type CleanData, type FieldSpecs } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";

const requireTerms = hasFlag("terms-and-privacy-checkbox");

// schema:register-validate-form in register.cljs.
const specs: FieldSpecs = {
  token: { type: "text" },
  fullname: { type: "text", max: 250 },
  "accept-terms-and-privacy": {
    type: "checkbox",
    optional: !requireTerms,
    mustBeTrue: requireTerms,
  },
  "accept-newsletter-updates": { type: "checkbox", optional: true },
};

function ValidateContent({ params }: { params: URLSearchParams }) {
  const form = useForm({
    specs,
    initial: {
      token: params.get("token") ?? "",
      fullname: params.get("fullname") ?? "",
    },
  });
  const onSuccess = useRegisterSuccess();
  const { error: notifyError } = useNotifications();

  const onSubmit = async (data: CleanData) => {
    form.setSubmitted(true);
    try {
      // The backend reads only :token and :accept-newsletter-updates
      // (register-profile in backend/src/app/rpc/commands/auth.clj); the
      // editable fullname travels inside the prepared-register token.
      const newsletter = data["accept-newsletter-updates"] === true;
      const result = await registerProfile({
        token: String(data.token),
        ...(newsletter ? { "accept-newsletter-updates": true } : {}),
      });
      await onSuccess(result);
    } catch {
      notifyError(tr("errors.generic"));
    } finally {
      form.setSubmitted(false);
    }
  };

  return (
    <div className="auth-wrapper auth-wrapper-register">
      <div className="auth-title-wrapper">
        <h2 className="auth-title" data-testid="register-title">
          {tr("auth.register-account-title")}
        </h2>
        <div className="auth-subtitle">{tr("auth.register-account-tagline")}</div>
      </div>

      <Form form={form} onSubmit={onSubmit} className="auth-form">
        <Field name="fullname" label={tr("auth.fullname")} autoComplete="name" />

        {requireTerms ? (
          <Checkbox
            name="accept-terms-and-privacy"
            label={<Tr k="auth.terms-and-privacy-agreement" />}
          />
        ) : null}

        <Checkbox name="accept-newsletter-updates" label={tr("onboarding-v2.newsletter.updates")} />

        <SubmitButton label={tr("auth.register-submit")} />
      </Form>

      <div className="auth-links">
        <div className="auth-go-back-row">
          <Link className="auth-go-back" href={routePaths["auth-register"]}>
            {tr("labels.go-back")}
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function RegisterValidatePage() {
  return (
    <QueryParams>
      {(params) => <ValidateContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
