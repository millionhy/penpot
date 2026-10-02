"use client";

// Settings / profile (F4). Port of app.main.ui.settings.profile: the avatar
// uploader with its delete confirmation, the fullname form, and the two links
// that open the change-email and delete-account dialogs.
//
// The email field is display-only because profile-update-params only ever sends
// fullname/lang/theme; changing the address goes through request-email-change.

import { useEffect, useRef, useState } from "react";
import { ChangeEmailModal } from "@/components/change-email-modal";
import { DeleteAccountModal } from "@/components/delete-account-modal";
import { Field, Form, SubmitButton } from "@/components/form";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { generateAvatar } from "@/lib/avatars";
import { config } from "@/lib/config";
import { useDocumentTitle } from "@/lib/dom";
import { useForm, type CleanData } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  deleteProfilePhoto,
  profilePhotoUrl,
  profileUpdateParams,
  updateProfile,
  updateProfilePhoto,
  type RuntimeProfile,
} from "@/lib/settings";

function ProfilePhotoForm({ runtime }: { runtime: RuntimeProfile | null }) {
  const { refresh } = useSession();
  const notifications = useNotifications();
  const modal = useModal();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const photo = profilePhotoUrl(runtime, config.publicUri);
  const fullname = runtime?.fullname ?? "";
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (photo !== null) {
      setAvatar(null);
      return;
    }
    setAvatar(generateAvatar({ name: fullname }));
  }, [photo, fullname]);

  const hasPhoto = typeof runtime?.["photo-id"] === "string" && runtime?.["photo-id"] !== "";

  const onSelected = async (file: File | null) => {
    if (file === null) return;
    setBusy(true);
    try {
      await updateProfilePhoto(file);
      await refresh();
    } catch {
      notifications.error(tr("generic.error"));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    try {
      await deleteProfilePhoto();
      await refresh();
    } catch {
      notifications.error(tr("generic.error"));
    }
  };

  const confirmDelete = () => {
    modal.open(
      <ConfirmDialog
        title={tr("labels.delete-profile-photo.title")}
        message={tr("labels.delete-profile-photo.message")}
        acceptLabel={tr("labels.delete")}
        cancelLabel={tr("labels.cancel")}
        destructive
        onAccept={() => {
          void onDelete();
        }}
      />,
    );
  };

  return (
    <form className="pp-avatar-form">
      <div className="pp-image-change-field">
        <span className="pp-update-overlay">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {tr("labels.update")}
          </button>
        </span>

        <img className="pp-avatar-image" src={photo ?? avatar ?? ""} alt="" width={80} height={80} />

        {hasPhoto ? (
          <button
            type="button"
            className="pp-delete-overlay"
            title={tr("labels.delete")}
            aria-label={tr("labels.delete")}
            data-testid="profile-image-delete"
            disabled={busy}
            onClick={confirmDelete}
          >
            ×
          </button>
        ) : null}

        <input
          ref={inputRef}
          className="pp-file-input"
          type="file"
          accept="image/jpeg,image/png"
          data-testid="profile-image-input"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            void onSelected(file);
          }}
        />
      </div>
    </form>
  );
}

function ProfileForm({ runtime }: { runtime: RuntimeProfile | null }) {
  const { refresh } = useSession();
  const notifications = useNotifications();
  const modal = useModal();

  const form = useForm({
    specs: { fullname: { type: "text", max: 250 }, email: { type: "email" } },
    initial: { fullname: runtime?.fullname ?? "", email: runtime?.email ?? "" },
  });

  // fm/submit-button* with :disabled (empty? (:touched @form)): nothing to save
  // until a field changes.
  const untouched = Object.keys(form.touched).length === 0;

  const onSubmit = async (data: CleanData) => {
    form.setSubmitted(true);
    try {
      await updateProfile(
        profileUpdateParams({ fullname: String(data["fullname"] ?? "") }),
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
    <Form
      className="pp-profile-form"
      form={form}
      onSubmit={(data) => {
        void onSubmit(data);
      }}
    >
      <div className="pp-fields-row">
        <Field name="fullname" label={tr("dashboard.your-name")} />
      </div>

      <div className="pp-fields-row">
        <Field name="email" type="email" label={tr("dashboard.your-email")} disabled />
        <div className="pp-field-links">
          <button
            type="button"
            className="pp-link"
            onClick={() => modal.open(<ChangeEmailModal />)}
          >
            {tr("dashboard.change-email")}
          </button>
        </div>
      </div>

      <SubmitButton
        label={tr("dashboard.save-settings")}
        disabled={untouched}
        className="pp-btn-primary"
      />

      <div className="pp-links">
        <button
          type="button"
          className="pp-link pp-link-danger"
          data-testid="remove-acount-btn"
          onClick={() => modal.open(<DeleteAccountModal />)}
        >
          {tr("dashboard.remove-account")}
        </button>
      </div>
    </Form>
  );
}

export default function SettingsProfilePage() {
  const { profile } = useSession();
  const runtime = (profile ?? null) as RuntimeProfile | null;
  useDocumentTitle(tr("title.settings.profile"));

  return (
    <section className="pp-dashboard-settings" aria-labelledby="profile-section-title">
      <div className="pp-form-container">
        <h2 id="profile-section-title">{tr("labels.profile")}</h2>
        <ProfilePhotoForm runtime={runtime} />
        <ProfileForm runtime={runtime} />
      </div>
    </section>
  );
}
