"use client";

// Settings / password (F4). Port of app.main.ui.settings.password, including the
// three server-side failure modes it maps onto fields: a wrong old password, the
// email reused as the password, and a weak password (whose reasons arrive as
// translation keys under :details).

import { Field, Form, SubmitButton } from "@/components/form";
import { useNotifications } from "@/components/notifications";
import { useDocumentTitle } from "@/lib/dom";
import { useForm, type CleanData, type FormValidator } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { passwordError, passwordParams, updateProfilePassword } from "@/lib/settings";

export default function SettingsPasswordPage() {
  const notifications = useNotifications();
  useDocumentTitle(tr("title.settings.password"));

  const validators: FormValidator[] = [
    {
      field: "password-2",
      message: tr("errors.password-invalid-confirmation"),
      check: (values) => values["password-1"] === values["password-2"],
    },
  ];

  const form = useForm({
    specs: {
      // The old password is checked by the backend, so it only has to be
      // present; it may predate the current minimum length policy. That is why
      // the spec is a plain bounded text field while the input renders masked.
      "password-old": { type: "text", max: 500 },
      "password-1": { type: "password" },
      "password-2": { type: "password" },
    },
    validators,
  });

  const onSubmit = async (data: CleanData) => {
    form.setSubmitted(true);
    try {
      await updateProfilePassword(
        passwordParams({
          "password-old": String(data["password-old"] ?? ""),
          "password-1": String(data["password-1"] ?? ""),
        }),
      );
      form.reset();
      notifications.success(tr("dashboard.notifications.password-saved"));
    } catch (err) {
      const mapped = passwordError(err);
      if (mapped.kind === "field") form.setFieldError(mapped.field, mapped.message);
      else notifications.error(tr("generic.error"));
      form.setSubmitted(false);
    }
  };

  return (
    <section className="pp-dashboard-settings" aria-labelledby="password-section-title">
      <div className="pp-form-container">
        <h2 id="password-section-title">{tr("dashboard.password-change")}</h2>

        <Form
          className="pp-password-form"
          form={form}
          onSubmit={(data) => {
            void onSubmit(data);
          }}
        >
          <div className="pp-fields-row">
            <Field
              name="password-old"
              type="password"
              label={tr("labels.old-password")}
              autoFocus
              autoComplete="current-password"
            />
          </div>

          <div className="pp-fields-row">
            <Field
              name="password-1"
              type="password"
              label={tr("labels.new-password")}
              autoComplete="new-password"
            />
          </div>

          <div className="pp-fields-row">
            <Field
              name="password-2"
              type="password"
              label={tr("labels.confirm-password")}
              autoComplete="new-password"
            />
          </div>

          <SubmitButton
            label={tr("dashboard.password-change")}
            testId="submit-password"
            className="pp-btn-primary"
          />
        </Form>
      </div>
    </section>
  );
}
