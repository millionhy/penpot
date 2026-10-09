"use client";

// leave-and-reassign-modal in app.main.ui.dashboard.change-owner (F5.5): the
// team owner picks the member to promote before leaving the team.
//
// Deviations from the CLJS original, documented:
// - The CLJS modal stays open while the leave request runs (the navigation
//   away unmounts it); the shell closes it on accept and lets the caller run
//   the command, since its modal host lives in the root layout.

import { useMemo } from "react";
import { Form, Select, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { useForm, type CleanData } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import type { TeamMember } from "@/lib/team";

export interface LeaveAndReassignModalProps {
  teamName: string;
  members: TeamMember[];
  profileEmail: string | null | undefined;
  onAccept: (memberId: string) => void;
}

export function LeaveAndReassignModal({
  teamName,
  members,
  profileEmail,
  onAccept,
}: LeaveAndReassignModalProps) {
  const { close } = useModal();

  // options of leave-and-reassign-modal: a placeholder plus every member
  // except the leaver, keyed by id.
  const others = useMemo(
    () => members.filter((member) => member.email !== profileEmail),
    [members, profileEmail],
  );
  const options = useMemo(
    () => [
      { value: "", label: tr("modals.leave-and-reassign.select-member-to-promote") },
      ...others.map((member) => ({ value: member.id, label: member.name ?? member.email })),
    ],
    [others],
  );

  const form = useForm({
    specs: { "member-id": { type: "select", oneOf: others.map((member) => member.id) } },
  });

  const onSubmit = (data: CleanData) => {
    close();
    onAccept(String(data["member-id"]));
  };

  return (
    <ModalShell title={tr("modals.leave-and-reassign.title")} closeLabel={tr("labels.close")}>
      <p className="pp-modal-message">{tr("modals.leave-and-reassign.hint1", teamName)}</p>
      {members.length === 0 ? (
        <p className="pp-modal-message">{tr("modals.leave-and-reassign.forbidden")}</p>
      ) : (
        <Form
          form={form}
          onSubmit={onSubmit}
          className="pp-leave-reassign-form"
        >
          <Select name="member-id" options={options} />
          <div className="pp-modal-actions">
            <button type="button" className="pp-btn-secondary" onClick={close}>
              {tr("labels.cancel")}
            </button>
            {/* css-case of the CLJS input: the accept button picks the danger
                style once the selection is valid, disabled until then. */}
            <SubmitButton
              label={tr("modals.leave-and-reassign.promote-and-leave")}
              disabled={others.length === 0}
              className={form.valid ? "pp-btn-danger" : "pp-btn-primary"}
              testId="promote-and-leave"
            />
          </div>
        </Form>
      )}
    </ModalShell>
  );
}
