"use client";

// Settings / notifications (F4). Port of
// app.main.ui.settings.notifications: three radio groups over the
// props.notifications map, seeded from default-notification-settings and saved
// with update-profile-notifications.

import { useMemo } from "react";
import { Form, RadioGroup, SubmitButton } from "@/components/form";
import { useNotifications } from "@/components/notifications";
import { useDocumentTitle } from "@/lib/dom";
import { useForm, type CleanData, type FormValues } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  notificationsFromProfile,
  updateProfileNotifications,
  type NotificationSettings,
  type RuntimeProfile,
} from "@/lib/settings";

const settingValues = ["all", "partial", "none"] as const;
const inviteValues = ["all", "none"] as const;

export default function SettingsNotificationsPage() {
  const { profile, refresh } = useSession();
  const runtime = (profile ?? null) as RuntimeProfile | null;
  const notifications = useNotifications();
  useDocumentTitle(tr("title.settings.notifications"));

  const initial = useMemo<FormValues>(
    () => ({ ...notificationsFromProfile(runtime) }),
    [runtime],
  );
  const form = useForm({
    specs: {
      "dashboard-comments": { type: "radio", oneOf: settingValues },
      "email-comments": { type: "radio", oneOf: settingValues },
      "email-invites": { type: "radio", oneOf: inviteValues },
    },
    initial,
  });

  // fm/submit-button* with :disabled (= (:data @form) (:initial @form)).
  const unchanged = JSON.stringify(form.values) === JSON.stringify(initial);

  const onSubmit = async (data: CleanData) => {
    form.setSubmitted(true);
    try {
      await updateProfileNotifications(data as unknown as NotificationSettings);
      await refresh();
      notifications.success(tr("dashboard.notifications.notifications-saved"));
    } catch {
      notifications.error(tr("generic.error"));
    } finally {
      form.setSubmitted(false);
    }
  };

  return (
    <section className="pp-dashboard-settings" aria-labelledby="notifications-section-title">
      <Form
        className="pp-notifications-form"
        form={form}
        onSubmit={(data) => {
          void onSubmit(data);
        }}
      >
        <div className="pp-form-container">
          <h2 id="notifications-section-title">
            {tr("dashboard.settings.notifications.title")}
          </h2>

          <h3>{tr("dashboard.settings.notifications.dashboard.title")}</h3>
          <h4>{tr("dashboard.settings.notifications.dashboard-comments.title")}</h4>
          <div className="pp-fields-row">
            <RadioGroup
              name="dashboard-comments"
              testId="dashboard-comments"
              options={[
                {
                  label: tr("dashboard.settings.notifications.dashboard-comments.all"),
                  value: "all",
                },
                {
                  label: tr("dashboard.settings.notifications.dashboard-comments.partial"),
                  value: "partial",
                },
                {
                  label: tr("dashboard.settings.notifications.dashboard-comments.none"),
                  value: "none",
                },
              ]}
            />
          </div>

          <h3>{tr("dashboard.settings.notifications.email.title")}</h3>
          <h4>{tr("dashboard.settings.notifications.email-comments.title")}</h4>
          <div className="pp-fields-row">
            <RadioGroup
              name="email-comments"
              testId="email-comments"
              options={[
                {
                  label: tr("dashboard.settings.notifications.email-comments.all"),
                  value: "all",
                },
                {
                  label: tr("dashboard.settings.notifications.email-comments.partial"),
                  value: "partial",
                },
                {
                  label: tr("dashboard.settings.notifications.email-comments.none"),
                  value: "none",
                },
              ]}
            />
          </div>

          <h4>{tr("dashboard.settings.notifications.email-invites.title")}</h4>
          <div className="pp-fields-row">
            {/* The "partial" invite mode has no backend support yet, so the CLJS
                form offers only all/none here as well. */}
            <RadioGroup
              name="email-invites"
              testId="email-invites"
              options={[
                {
                  label: tr("dashboard.settings.notifications.email-invites.all"),
                  value: "all",
                },
                {
                  label: tr("dashboard.settings.notifications.email-invites.none"),
                  value: "none",
                },
              ]}
            />
          </div>

          <SubmitButton
            label={tr("dashboard.settings.notifications.submit")}
            disabled={unchanged}
            testId="submit-settings"
            className="pp-btn-primary"
          />
        </div>
      </Form>
    </section>
  );
}
