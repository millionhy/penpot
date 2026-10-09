"use client";

// team-form-modal in app.main.ui.dashboard.team-form (F5.5): create or rename
// a team. The shell wires it for the F5.7 team switcher; the modal keeps the
// CLJS contract of both flows.
//
// Deviations from the CLJS original, documented:
// - update-team in app.main.data.team assocs the new name into the store and
//   fires the command with rx/ignore, so the CLJS update never toasts nor
//   surfaces an error; the shell keeps that behavior (close on submit, then
//   refresh the teams).
// - dtm/create-team relies on the route change to fetch-teams through
//   team-container*; the shell awaits onTeamsChanged before navigating so the
//   new team id resolves in the dashboard provider.

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { Field, Form, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { dashboardHref } from "@/lib/dashboard";
import { RpcError } from "@/lib/errors";
import { useForm } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import {
  TEAM_FORM_SUCCESS_MESSAGE,
  createTeam,
  globalEnabledFeatures,
  teamFormErrorMessage,
  updateTeam,
} from "@/lib/team";

export interface TeamFormModalProps {
  // Present for the rename flow; absent for creation.
  team?: { id: string; name: string } | null;
  organizationId?: string | null;
  onToast: (message: string) => void;
  onNoPermission: () => void;
  onTeamsChanged: () => Promise<void>;
}

export function TeamFormModal({
  team,
  organizationId,
  onToast,
  onNoPermission,
  onTeamsChanged,
}: TeamFormModalProps) {
  const { close } = useModal();
  const router = useRouter();

  const validators = useMemo(
    () => [
      {
        field: "name",
        message: tr("errors.team-name-invalid-chars"),
        check: (values: Record<string, string | boolean>) => !/[.:/]/.test(String(values.name)),
      },
    ],
    [],
  );
  const form = useForm({
    specs: { name: { type: "text", max: 250 } },
    initial: team !== null && team !== undefined ? { name: team.name } : {},
    validators,
  });

  const onSubmit = async (data: Record<string, string | boolean>) => {
    const name = String(data.name);
    if (team !== null && team !== undefined) {
      // on-update-submit: the modal hides immediately and the command runs
      // with its result ignored.
      close();
      try {
        await updateTeam(team.id, name);
      } catch {
        // update-team swallows the transport error (rx/ignore).
      }
      await onTeamsChanged();
      return;
    }
    try {
      const created = await createTeam(name, globalEnabledFeatures(), organizationId ?? null);
      onToast(TEAM_FORM_SUCCESS_MESSAGE);
      close();
      await onTeamsChanged();
      router.push(dashboardHref("dashboard-recent", { teamId: created.id }));
    } catch (err) {
      const code = err instanceof RpcError ? err.data.code : undefined;
      if (code === "not-allowed") {
        onNoPermission();
        return;
      }
      onToast(teamFormErrorMessage(false));
    }
  };

  return (
    <ModalShell
      title={team !== null && team !== undefined ? tr("labels.rename-team") : tr("labels.create-team")}
      closeLabel={tr("labels.close")}
    >
      <Form
        form={form}
        onSubmit={(data) => {
          void onSubmit(data);
        }}
        className="pp-team-form"
      >
        <Field
          name="name"
          label={tr("labels.create-team.placeholder")}
          placeholder="E.g. Design"
          autoFocus
          testId="team-name-input"
        />
        <div className="pp-modal-actions">
          <SubmitButton
            label={
              team !== null && team !== undefined
                ? tr("labels.update-team")
                : tr("labels.create-team")
            }
          />
        </div>
      </Form>
    </ModalShell>
  );
}
