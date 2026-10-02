"use client";

// Settings / feedback (F4). Port of app.main.ui.settings.feedback, reachable
// only under the :user-feedback flag.
//
// The error-report attachment is not ported: the report blob, its download link
// and the error-report-id lookup all read app.main.errors/last-report, and the
// shell has no crash-reporting pipeline yet.

import { useState } from "react";
import { Field, Form, Select, SubmitButton, Textarea } from "@/components/form";
import { useNotifications } from "@/components/notifications";
import { useDocumentTitle } from "@/lib/dom";
import { useForm, type CleanData } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { feedbackError, sendUserFeedback, type FeedbackParams } from "@/lib/settings";

export default function SettingsFeedbackPage() {
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);
  useDocumentTitle(tr("title.settings.feedback"));

  const form = useForm({
    specs: {
      subject: { type: "text", max: 250 },
      // The CLJS form starts with an empty type. A native select cannot show a
      // blank row without an extra empty option, so the shell preselects the
      // first entry instead.
      type: { type: "select", oneOf: ["idea", "issue", "doubt"] },
      content: { type: "textarea", max: 5000 },
      "error-href": { type: "text", optional: true, max: 2048 },
    },
    initial: { type: "idea" },
  });

  const onSubmit = async (data: CleanData) => {
    setBusy(true);
    form.setSubmitted(true);
    const params: FeedbackParams = {
      subject: String(data["subject"] ?? ""),
      type: String(data["type"] ?? ""),
      content: String(data["content"] ?? ""),
    };
    const href = String(data["error-href"] ?? "");
    if (href.length > 0) params["error-href"] = href;
    try {
      await sendUserFeedback(params);
      form.reset();
      notifications.success(tr("labels.feedback-sent"));
    } catch (err) {
      notifications.error(feedbackError(err));
    } finally {
      setBusy(false);
      form.setSubmitted(false);
    }
  };

  return (
    <section className="pp-dashboard-settings" aria-labelledby="feedback-section-title">
      <div className="pp-form-container">
        <Form
          className="pp-feedback-form"
          form={form}
          onSubmit={(data) => {
            void onSubmit(data);
          }}
        >
          <h2 id="feedback-section-title">{tr("feedback.title-contact-us")}</h2>
          <p className="pp-field-text">{tr("feedback.subtitle")}</p>

          <div className="pp-fields-row">
            <Field name="subject" label={tr("feedback.subject")} />
          </div>

          <div className="pp-fields-row">
            <Select
              name="type"
              label={tr("feedback.type")}
              options={[
                { label: tr("feedback.type.idea"), value: "idea" },
                { label: tr("feedback.type.issue"), value: "issue" },
                { label: tr("feedback.type.doubt"), value: "doubt" },
              ]}
            />
          </div>

          <div className="pp-fields-row">
            <Textarea
              name="content"
              label={tr("feedback.description")}
              placeholder={tr("feedback.description-placeholder")}
              rows={5}
            />
          </div>

          <div className="pp-fields-row">
            <p className="pp-field-text">{tr("feedback.penpot.link")}</p>
            <Field name="error-href" label="" placeholder="https://penpot.app/" />
          </div>

          <SubmitButton
            label={busy ? tr("labels.sending") : tr("labels.send")}
            disabled={busy}
            className="pp-btn-primary"
          />

          <hr className="pp-separator" />

          <h2>{tr("feedback.other-ways-contact")}</h2>
          <a
            className="pp-link"
            href="https://community.penpot.app"
            target="_blank"
            rel="noreferrer"
          >
            {tr("feedback.discourse-title")}
          </a>
          <p className="pp-field-text">{tr("feedback.discourse-subtitle1")}</p>

          <a className="pp-link" href="https://x.com/penpotapp" target="_blank" rel="noreferrer">
            {tr("feedback.twitter-title")}
          </a>
          <p className="pp-field-text">{tr("feedback.twitter-subtitle1")}</p>
        </Form>
      </div>
    </section>
  );
}
