"use client";

// webhook-modal in app.main.ui.dashboard.team (F5.5): create or edit a team
// webhook.
//
// Deviations from the CLJS original, documented:
// - Notifications and the post-save webhook refresh are caller callbacks: the
//   modal host lives outside the notifications and dashboard providers here,
//   while dtm/create-webhook toasts ntf/success and fetches the webhooks from
//   the event stream itself.
// - The CLJS clean-data keeps every initial key (the malli decode passes
//   unknown keys through), so its on-submit branches on (:id data); the shell
//   form only carries uri/mtype/is-active and branches on the webhook prop.

import { useMemo } from "react";
import { Checkbox, Field, Form, Select, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { RpcError } from "@/lib/errors";
import { useForm, type CleanData, type FormValues } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import {
  createWebhook,
  translateErrorHint,
  updateWebhook,
  type Webhook,
  type WebhookMtype,
} from "@/lib/team";

// valid-webhook-mtypes.
const WEBHOOK_MTYPES = [
  { label: "application/json", value: "application/json" },
  { label: "application/transit+json", value: "application/transit+json" },
];

const MTYPE_VALUES = ["application/json", "application/transit+json"];

export interface WebhookModalProps {
  teamId: string;
  // Present for the edit flow.
  webhook?: Webhook | null;
  onSaved: () => void;
  onErrorToast: (message: string) => void;
}

export function WebhookModal({ teamId, webhook, onSaved, onErrorToast }: WebhookModalProps) {
  const { close } = useModal();
  const stored = webhook ?? null;
  const isEdit = stored !== null;

  // initial of webhook-modal: the stored webhook with a stringified uri, or
  // the inactive json defaults.
  const initial = useMemo<FormValues>(() => {
    const values: FormValues = { uri: "", mtype: "application/json", "is-active": false };
    if (stored !== null) {
      values.uri = String(stored.uri);
      values.mtype = typeof stored.mtype === "string" ? stored.mtype : "application/json";
      values["is-active"] = stored["is-active"] === true;
    }
    return values;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // schema:webhook-form declares ::sm/uri with max 4069 and the http(s)://
  // prefix; every failure carries errors.webhooks.invalid-uri.
  const validators = useMemo(
    () => [
      {
        field: "uri",
        message: tr("errors.webhooks.invalid-uri"),
        check: (values: Record<string, string | boolean>) => {
          const uri = String(values.uri);
          if (uri.length > 4069 || !/^http[s]?:\/\//.test(uri)) return false;
          try {
            new URL(uri);
            return true;
          } catch {
            return false;
          }
        },
      },
    ],
    [],
  );

  const form = useForm({
    specs: {
      uri: { type: "text", max: 4069 },
      mtype: { type: "select", oneOf: MTYPE_VALUES },
      "is-active": { type: "checkbox" },
    },
    initial,
    validators,
  });

  const onSubmit = async (data: CleanData) => {
    const uri = String(data.uri);
    const mtype = String(data.mtype) as WebhookMtype;
    const isActive = data["is-active"] === true;
    try {
      if (stored !== null) {
        await updateWebhook(stored.id, uri, mtype, isActive);
      } else {
        await createWebhook(teamId, uri, mtype, isActive);
      }
      close();
      onSaved();
    } catch (err) {
      const cause = err instanceof RpcError ? err.data : null;
      if (cause !== null && cause.type === "validation" && cause.code === "webhook-validation") {
        // on-error: the translated hint lands on the uri field as an
        // extra-error and the modal stays open.
        form.setFieldError("uri", translateErrorHint(cause.hint));
        return;
      }
      onErrorToast(tr("errors.generic"));
    }
  };

  return (
    <ModalShell
      title={isEdit ? tr("modals.edit-webhook.title") : tr("modals.create-webhook.title")}
      closeLabel={tr("labels.close")}
    >
      <Form
        form={form}
        onSubmit={(data) => {
          void onSubmit(data);
        }}
        className="pp-webhook-form"
      >
        <Field
          name="uri"
          label={tr("modals.create-webhook.url.label")}
          placeholder={tr("modals.create-webhook.url.placeholder")}
          autoFocus
          testId="webhook-uri-input"
        />
        <div className="pp-webhook-content-type">
          <div className="pp-select-title">{tr("dashboard.webhooks.content-type")}</div>
          <Select name="mtype" options={WEBHOOK_MTYPES} testId="webhook-mtype" />
        </div>
        <Checkbox
          name="is-active"
          label={tr("dashboard.webhooks.active")}
          testId="webhook-is-active"
        />
        <p className="pp-field-hint">{tr("dashboard.webhooks.active.explain")}</p>
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          <SubmitButton
            label={
              isEdit
                ? tr("modals.edit-webhook.submit-label")
                : tr("modals.create-webhook.submit-label")
            }
            testId="webhook-submit"
          />
        </div>
      </Form>
    </ModalShell>
  );
}
