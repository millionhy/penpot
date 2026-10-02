"use client";

// Settings / options (F4). Port of app.main.ui.settings.options: the language
// and theme selects plus the webgl renderer switch gated by :render-switch.
// Saving calls update-profile, the same command the profile page uses, because
// profile-update-params only ever carries fullname/lang/theme.
//
// The theme select writes through to <html> via components/theme.tsx once the
// refreshed profile lands in the session, which is what activate-theme does in
// the CLJS store.

import { useMemo, useState } from "react";
import { Form, Select, SubmitButton } from "@/components/form";
import { useNotifications } from "@/components/notifications";
import { hasFlag } from "@/lib/config";
import { useDocumentTitle } from "@/lib/dom";
import { useForm, type CleanData, type FormValues } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  localeOptions,
  profileUpdateParams,
  rendererFromProfile,
  themeFormValue,
  updateProfile,
  updateProfileProps,
  type RuntimeProfile,
} from "@/lib/settings";

function WebglSettings({ renderer }: { renderer: "svg" | "wasm" }) {
  const { refresh } = useSession();
  const notifications = useNotifications();
  const [busy, setBusy] = useState(false);
  const enabled = renderer === "wasm";

  const onChange = async (next: boolean) => {
    setBusy(true);
    try {
      await updateProfileProps({ renderer: next ? "wasm" : "svg" });
      await refresh();
      notifications.success(
        next
          ? tr("webgl.toast.webgl-render-enabled")
          : tr("webgl.toast.webgl-render-disabled"),
      );
    } catch {
      notifications.error(tr("generic.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pp-webgl-container">
      <header className="pp-webgl-header">
        <h2 className="pp-typ-title-large">{tr("dashboard.webgl-switch.title")}</h2>
        <span className="pp-typ-body-small pp-badge">{tr("dashboard.webgl-switch.beta")}</span>
      </header>
      <p className="pp-typ-body-medium">{tr("dashboard.webgl-switch.description")}</p>

      <div className="pp-webgl-form">
        <h3 className="pp-typ-headline-small">{tr("dashboard.webgl-switch.status")}</h3>
        <label className="pp-switch">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy}
            onChange={(event) => {
              void onChange(event.target.checked);
            }}
          />
          <span>
            {enabled
              ? tr("dashboard.webgl-switch.enabled")
              : tr("dashboard.webgl-switch.disabled")}
          </span>
        </label>
      </div>
    </section>
  );
}

export default function SettingsOptionsPage() {
  const { profile, refresh } = useSession();
  const runtime = (profile ?? null) as RuntimeProfile | null;
  const notifications = useNotifications();
  useDocumentTitle(tr("title.settings.options"));

  const initial = useMemo<FormValues>(
    () => ({ lang: runtime?.lang ?? "", theme: themeFormValue(runtime?.theme) }),
    [runtime],
  );
  const form = useForm({
    specs: {
      lang: { type: "select", optional: true, max: 20 },
      theme: { type: "select", optional: true, max: 250, oneOf: ["light", "dark", "system"] },
    },
    initial,
  });

  const unchanged = JSON.stringify(form.values) === JSON.stringify(initial);

  const onSubmit = async (data: CleanData) => {
    form.setSubmitted(true);
    try {
      await updateProfile(
        profileUpdateParams({
          fullname: runtime?.fullname ?? "",
          lang: String(data["lang"] ?? ""),
          theme: String(data["theme"] ?? ""),
        }),
      );
      await refresh();
      notifications.success(tr("notifications.profile-saved"));
    } catch {
      notifications.error(tr("generic.error"));
    } finally {
      form.setSubmitted(false);
    }
  };

  return (
    <section className="pp-dashboard-settings" aria-labelledby="options-section-title">
      <div className="pp-form-container" data-testid="settings-form">
        <h2 className="pp-typ-title-large" id="options-section-title">
          {tr("labels.settings")}
        </h2>

        <Form
          className="pp-options-form"
          form={form}
          onSubmit={(data) => {
            void onSubmit(data);
          }}
        >
          <h3>{tr("labels.language")}</h3>
          <div className="pp-fields-row">
            <Select
              name="lang"
              label={tr("dashboard.select-ui-language")}
              options={localeOptions("Auto (browser)")}
              testId="setting-lang"
            />
          </div>

          <h3>{tr("dashboard.theme-change")}</h3>
          <div className="pp-fields-row">
            <Select
              name="theme"
              label={tr("dashboard.select-ui-theme")}
              options={[
                { label: tr("dashboard.select-ui-theme.dark"), value: "dark" },
                { label: tr("dashboard.select-ui-theme.light"), value: "light" },
                { label: tr("dashboard.select-ui-theme.system"), value: "system" },
              ]}
              testId="setting-theme"
            />
          </div>

          <SubmitButton
            label={tr("dashboard.update-settings")}
            disabled={unchanged}
            testId="submit-lang-change"
            className="pp-btn-primary"
          />
        </Form>
      </div>

      {hasFlag("render-switch") ? (
        <WebglSettings renderer={rendererFromProfile(runtime)} />
      ) : null}
    </section>
  );
}
