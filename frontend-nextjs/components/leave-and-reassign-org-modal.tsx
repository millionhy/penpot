"use client";

// leave-and-reassign-organization-modal in app.main.ui.dashboard.change-owner
// (F5.7a): before leaving an organization, the user promotes a successor for
// every team they want to keep, one select per transferable team. Reached
// from the leave-organization flow when the summary counts transferable
// teams.
//
// Deviations from the CLJS original, documented:
// - The CLJS modal stays open while the leave request runs (the navigation
//   away unmounts it); the shell closes it on accept and lets the caller run
//   the command, like leave-and-reassign-modal does.
// - The per-team selects follow team-member-select*: the leaver is filtered
//   out by email (the backend already excludes them from transferable-teams),
//   a team without candidates renders the forbidden message instead of a
//   select, and the whole form stays invalid until every select has a value.
// - The CLJS selects carry no placeholder option; the shell seeds each one
//   with the same default (first admin, else first member) and keeps the
//   accept button disabled until all of them are valid.

import { useMemo } from "react";
import { Form, Select, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { useForm, type FieldSpecs } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import type { LeaveOrganizationTransferableTeam } from "@/lib/nitrate";

export interface LeaveAndReassignOrgModalProps {
  teams: LeaveOrganizationTransferableTeam[];
  numTeamsToDelete: number;
  profileEmail: string | null | undefined;
  onAccept: (teamsToTransfer: Array<{ id: string; "reassign-to": string }>) => void;
}

export function LeaveAndReassignOrgModal({
  teams,
  numTeamsToDelete,
  profileEmail,
  onAccept,
}: LeaveAndReassignOrgModalProps) {
  const { close } = useModal();

  // team-fields of leave-and-reassign-organization-modal: one entry per
  // transferable team with its candidates and the seeded default member.
  const teamFields = useMemo(
    () =>
      teams.map((team) => {
        const candidates = (team.members ?? []).filter(
          (member) => member.email !== profileEmail,
        );
        const firstAdmin = candidates.find((member) => member["is-admin"] === true);
        const defaultMemberId = firstAdmin?.id ?? candidates[0]?.id ?? "";
        return { team, candidates, fieldName: `member-id-${team.id}`, defaultMemberId };
      }),
    [teams, profileEmail],
  );

  // The CLJS schema is a plain ::sm/text per team plus an all-valid? scan for
  // blanks; oneOf over the candidate ids is the same gate (an empty candidate
  // list can never validate).
  const specs = useMemo(() => {
    const result: FieldSpecs = {};
    for (const field of teamFields) {
      result[field.fieldName] = {
        type: "select",
        oneOf: field.candidates.map((member) => member.id),
      };
    }
    return result;
  }, [teamFields]);

  const initial = useMemo(() => {
    const values: Record<string, string> = {};
    for (const field of teamFields) values[field.fieldName] = field.defaultMemberId;
    return values;
  }, [teamFields]);

  const form = useForm({ specs, initial });

  const onSubmit = () => {
    close();
    onAccept(
      teamFields.map((field) => ({
        id: field.team.id,
        "reassign-to": String(form.cleanData[field.fieldName] ?? ""),
      })),
    );
  };

  return (
    <ModalShell title={tr("modals.before-leave-organization.title")} closeLabel={tr("labels.close")}>
      {numTeamsToDelete === 0 ? (
        <p className="pp-modal-message">{tr("modals.leave-organization-and-reassign.hint")}</p>
      ) : (
        <>
          <p className="pp-modal-message">
            {tr("modals.leave-organization-and-reassign.hint-delete")}
          </p>
          <p className="pp-modal-message">
            {tr("modals.leave-organization-and-reassign.hint-promote")}
          </p>
        </>
      )}
      <Form form={form} onSubmit={onSubmit} className="pp-leave-reassign-form">
        <div className="pp-leave-reassign-teams">
          {teamFields.map((field) => (
            <div key={field.team.id} className="pp-leave-reassign-team">
              <div className="pp-leave-reassign-team-name">{field.team.name}</div>
              {field.candidates.length === 0 ? (
                <p className="pp-modal-message">{tr("modals.leave-and-reassign.forbidden")}</p>
              ) : (
                <Select
                  name={field.fieldName}
                  testId={`promote-member-${field.team.id}`}
                  options={field.candidates.map((member) => ({
                    value: member.id,
                    label: member.name ?? member.email ?? member.id,
                  }))}
                />
              )}
            </div>
          ))}
        </div>
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          {/* css-case of the CLJS input: the accept button picks the danger
              style once every select is valid, disabled until then. */}
          <SubmitButton
            label={tr("modals.leave-and-reassign.promote-and-leave")}
            className={form.valid ? "pp-btn-danger" : "pp-btn-primary"}
            testId="promote-and-leave-org"
          />
        </div>
      </Form>
    </ModalShell>
  );
}
