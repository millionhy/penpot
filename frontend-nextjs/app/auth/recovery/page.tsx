"use client";

// Port of app.main.ui.auth.recovery/recovery-page*: set a new password with the
// token from the recovery email (?token=...).

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { QueryParams } from "@/components/query-params";
import { useNotifications } from "@/components/notifications";
import { recoverProfile, recoveryError } from "@/lib/auth";
import { Field, Form, SubmitButton } from "@/components/form";
import {
  useForm,
  type CleanData,
  type FieldSpecs,
  type FormValidator,
} from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";

// schema:recovery-form in recovery.cljs. The token is part of the form (it comes
// from the query string and has no visible input), and the [:fn] constraint
// becomes the password-2 validator below.
const specs: FieldSpecs = {
  token: { type: "text" },
  "password-1": { type: "password" },
  "password-2": { type: "password" },
};

function RecoveryContent({ params }: { params: URLSearchParams }) {
  const router = useRouter();
  const { info, error: notifyError } = useNotifications();

  const validators = useMemo<FormValidator[]>(
    () => [
      {
        field: "password-2",
        message: tr("errors.password-invalid-confirmation"),
        check: (values) => values["password-1"] === values["password-2"],
      },
    ],
    [],
  );

  const form = useForm({
    specs,
    initial: { token: params.get("token") ?? "" },
    validators,
  });

  const onSubmit = useCallback(
    async (data: CleanData) => {
      form.setSubmitted(true);
      form.clearFieldErrors();
      try {
        await recoverProfile(String(data.token), String(data["password-2"]));
        info(tr("auth.notifications.password-changed-successfully"));
        router.push(routePaths["auth-login"]);
      } catch (err) {
        const mapped = recoveryError(err);
        if (mapped === "invalid-token") notifyError(tr("errors.invalid-recovery-token"));
        else form.setFieldError(mapped.field, mapped.message);
      } finally {
        form.setSubmitted(false);
      }
    },
    [form, info, notifyError, router],
  );

  return (
    <div className="auth-wrapper">
      <h1 className="auth-title">{tr("auth.recovery-request-title")}</h1>
      <div className="auth-subtitle">{tr("auth.recovery-request-subtitle")}</div>
      <hr className="auth-separator" />

      <Form form={form} onSubmit={onSubmit} className="auth-form">
        <Field
          name="password-1"
          label={tr("auth.new-password")}
          type="password"
          autoComplete="new-password"
          autoFocus
        />
        <Field
          name="password-2"
          label={tr("auth.confirm-password")}
          type="password"
          autoComplete="new-password"
        />
        <SubmitButton label={tr("auth.recovery-submit")} />
      </Form>

      <div className="auth-links">
        <div className="auth-go-back-row">
          <button
            type="button"
            className="auth-go-back"
            onClick={() => router.push(routePaths["auth-login"])}
          >
            {tr("profile.recovery.go-to-login")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RecoveryPage() {
  return (
    <QueryParams>
      {(params) => <RecoveryContent params={params} key={params.toString()} />}
    </QueryParams>
  );
}
