"use client";

// Delete-account dialog (F4). Port of app.main.ui.settings.delete_account.
//
// The owned-organizations list is not ported: that branch only renders under the
// :admin-console flag (off by default) and needs
// get-owned-organizations-summary, which belongs to the dashboard work.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ContextNotification } from "@/components/context-notification";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import { routePaths } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { deleteProfile } from "@/lib/settings";

export function DeleteAccountModal() {
  const notifications = useNotifications();
  const router = useRouter();
  const { refresh } = useSession();
  const { close } = useModal();
  const [busy, setBusy] = useState(false);

  const onAccept = async () => {
    setBusy(true);
    try {
      await deleteProfile();
      await refresh();
      router.replace(routePaths["auth-login"]);
    } catch (err) {
      const code = err instanceof RpcError ? err.data.code : undefined;
      notifications.error(
        code === "owner-teams-with-people"
          ? tr("notifications.profile-deletion-not-allowed")
          : tr("generic.error"),
      );
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={tr("modals.delete-account.title")}
      closeLabel={tr("modals.delete-account.cancel")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" disabled={busy} onClick={close}>
            {tr("modals.delete-account.cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-danger"
            data-testid="delete-account-btn"
            disabled={busy}
            onClick={() => {
              void onAccept();
            }}
          >
            {tr("modals.delete-account.confirm")}
          </button>
        </div>
      }
    >
      <ContextNotification level="warning">{tr("modals.delete-account.info")}</ContextNotification>
    </ModalShell>
  );
}
