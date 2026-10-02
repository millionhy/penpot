"use client";

// Change-email dialog (F4). Port of app.main.ui.settings.change-email: two
// matching email fields, request-email-change, then either a profile refresh
// (the backend applied it straight away) or an info toast telling the user a
// verification email is on its way.

import { useState } from "react";
import { ContextNotification } from "@/components/context-notification";
import { Field, Form, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { RpcError } from "@/lib/errors";
import { useForm, type FormValidator } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { requestEmailChange, type RuntimeProfile } from "@/lib/settings";

interface EmailChangeResult {
  changed?: boolean;
}

export function ChangeEmailModal() {
  const { profile, refresh } = useSession();
  const runtime = (profile ?? null) as RuntimeProfile | null;
  const { close } = useModal();
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);

  const validators: FormValidator[] = [
    {
      field: "email-2",
      message: tr("errors.invalid-email-confirmation"),
      check: (values) => values["email-1"] === values["email-2"],
    },
  ];
  const form = useForm({
    specs: { "email-1": { type: "email" }, "email-2": { type: "email" } },
    validators,
  });

  const onSubmit = async (email: string) => {
    setBusy(true);
    try {
      const result = (await requestEmailChange(email)) as EmailChangeResult | null;
      if (result?.changed === true) {
        await refresh();
        close();
        return;
      }
      notifications.info(tr("notifications.validation-email-sent", runtime?.email ?? ""));
      close();
    } catch (err) {
      const data = err instanceof RpcError ? err.data : null;
      switch (data?.code) {
        case "email-already-exists":
          form.setFieldError("email-1", tr("errors.email-already-exists"));
          break;
        case "profile-is-muted":
          notifications.error(tr("errors.profile-is-muted"));
          break;
        case "email-has-permanent-bounces":
        case "email-has-complaints": {
          const rejected = typeof data?.email === "string" ? (data.email as string) : email;
          notifications.error(tr("errors.email-has-permanent-bounces", rejected));
          break;
        }
        default:
          notifications.error(tr("generic.error"));
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={tr("modals.change-email.title")}
      titleTestId="change-email-title"
      closeLabel={tr("labels.cancel")}
      footer={
        <div className="pp-modal-actions" data-testid="change-email-submit">
          <SubmitButton label={tr("modals.change-email.submit")} disabled={busy} />
        </div>
      }
    >
      <Form
        form={form}
        onSubmit={(data) => {
          void onSubmit(String(data["email-1"] ?? ""));
        }}
      >
        <ContextNotification level="info">
          {tr("modals.change-email.info", runtime?.email ?? "")}
        </ContextNotification>
        <div className="pp-fields-row">
          <Field type="email" name="email-1" label={tr("modals.change-email.new-email")} />
        </div>
        <div className="pp-fields-row">
          <Field type="email" name="email-2" label={tr("modals.change-email.confirm-email")} />
        </div>
      </Form>
    </ModalShell>
  );
}
