"use client";

// Port of app.main.ui.auth.recovery-request/recovery-request-page*: ask the
// backend to mail a recovery token.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useNotifications } from "@/components/notifications";
import { requestProfileRecovery, recoveryRequestError } from "@/lib/auth";
import { Field, Form, SubmitButton } from "@/components/form";
import { useForm, type CleanData, type FieldSpecs } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";

// schema:recovery-request-form in recovery_request.cljs.
const specs: FieldSpecs = {
  email: { type: "email" },
};

export default function RecoveryRequestPage() {
  const router = useRouter();
  const { info, error: notifyError } = useNotifications();
  const form = useForm({ specs });

  const onSubmit = useCallback(
    async (data: CleanData) => {
      form.setSubmitted(true);
      const email = String(data.email);
      try {
        await requestProfileRecovery(email);
        form.reset();
        info(tr("auth.notifications.recovery-token-sent"));
      } catch (err) {
        const message = recoveryRequestError(err, email);
        notifyError(message ?? tr("errors.generic"));
      } finally {
        form.setSubmitted(false);
      }
    },
    [form, info, notifyError],
  );

  return (
    <div className="auth-wrapper">
      <h1 className="auth-title">{tr("auth.recovery-request-title")}</h1>
      <div className="auth-subtitle">{tr("auth.recovery-request-subtitle")}</div>
      <hr className="auth-separator" />

      <Form form={form} onSubmit={onSubmit} className="auth-form">
        <Field name="email" label={tr("auth.work-email")} type="email" autoComplete="email" />
        <SubmitButton label={tr("auth.recovery-request-submit")} testId="recovery-resquest-submit" />
      </Form>

      <hr className="auth-separator" />
      <div className="auth-go-back-row">
        <button type="button" className="auth-go-back" onClick={() => router.push(routePaths["auth-login"])}>
          {tr("labels.go-back")}
        </button>
      </div>
    </div>
  );
}
