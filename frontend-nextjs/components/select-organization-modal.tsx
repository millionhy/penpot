"use client";

// select-organization-modal in app.main.ui.dashboard.team (F5.7b): the dialog
// the team settings block opens to add a team to an organization or move it
// to another one. The caller narrows the list and supplies the copy, exactly
// like the CLJS modal receives them from data/nitrate.
//
// Deviations from the CLJS original, documented:
// - The CLJS combobox is a custom listbox with an avatar per row; the shell
//   uses a native select inside the shared form-field markup, the same
//   temporary stand-in as components/form.tsx Select until @penpot/ui lands.
// - The external-invitations warning is fetched on every selection change,
//   like the CLJS :on-change, but the answer of a superseded request is
//   dropped through a request counter (the CLJS subscription replaces the
//   previous one; React state needs the guard).

import { useEffect, useMemo, useRef, useState } from "react";
import { ContextNotification } from "@/components/context-notification";
import { ModalShell, useModal } from "@/components/modal";
import { tr } from "@/lib/i18n";
import { checkTeamExternalInvitations, type ExternalInvitationsStatus } from "@/lib/team-organization";
import type { TeamOrganization } from "@/lib/team";

export interface SelectOrganizationModalProps {
  organizations: ReadonlyArray<TeamOrganization>;
  // organization id -> whether it can be selected; a missing entry means yes.
  organizationsAllowed?: Record<string, boolean> | null;
  currentOrganization?: TeamOrganization | null;
  teamId?: string | null;
  title: string;
  choose: string;
  placeholder: string;
  accept: string;
  cancel: string;
  description?: string;
  infoMessage?: string;
  onConfirm: (organizationId: string) => void;
}

export function SelectOrganizationModal({
  organizations,
  organizationsAllowed,
  currentOrganization,
  teamId,
  title,
  choose,
  placeholder,
  accept,
  cancel,
  description,
  infoMessage,
  onConfirm,
}: SelectOrganizationModalProps) {
  const { close } = useModal();
  const initialId = currentOrganization?.id ?? "";
  const [selectedId, setSelectedId] = useState(initialId);
  const [warning, setWarning] = useState<ExternalInvitationsStatus | null>(null);
  const requestId = useRef(0);

  // The CLJS modal lists all-organizations: the filtered rows plus the current
  // organization even when the caller dropped it, so the box starts on the
  // source and the accept button stays disabled until the user moves away.
  const options = useMemo(() => {
    if (currentOrganization === null || currentOrganization === undefined) {
      return organizations;
    }
    if (organizations.some((organization) => organization.id === currentOrganization.id)) {
      return organizations;
    }
    return [currentOrganization, ...organizations];
  }, [organizations, currentOrganization]);

  // on-change: every selection re-checks whether moving the team would cancel
  // invitations to people outside the target organization.
  useEffect(() => {
    requestId.current += 1;
    const current = requestId.current;
    if (teamId === null || teamId === undefined || selectedId === "") {
      setWarning(null);
      return;
    }
    checkTeamExternalInvitations(teamId, selectedId)
      .then((result) => {
        if (requestId.current === current) setWarning(result);
      })
      .catch(() => {
        if (requestId.current === current) setWarning(null);
      });
  }, [teamId, selectedId]);

  const disabled =
    selectedId === "" || (initialId !== "" && selectedId === initialId);
  const selectedOrganization =
    options.find((organization) => organization.id === selectedId) ?? null;
  const showWarning =
    warning !== null &&
    warning["has-external-invitations"] === true &&
    warning["allows-anybody"] !== true &&
    selectedOrganization !== null;

  return (
    <ModalShell
      title={title}
      closeLabel={cancel}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {cancel}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            disabled={disabled}
            onClick={() => {
              close();
              onConfirm(selectedId);
            }}
          >
            {accept}
          </button>
        </div>
      }
    >
      {description !== undefined || infoMessage !== undefined ? (
        <div className="pp-select-organization-info">
          {description !== undefined ? <div>{description}</div> : null}
          {infoMessage !== undefined ? <div>{infoMessage}</div> : null}
        </div>
      ) : null}

      <div className="pp-select-organization-body">
        <div className="pp-select-organization-content">{choose}</div>
        {/* The CLJS modal labels the box with the choose line above it, so the
            native select carries the label as its accessible name instead of
            repeating it as a visible field label. */}
        <div className="pp-field">
          <select
            id="pp-select-organization"
            className="pp-field-input"
            aria-label={choose}
            value={selectedId}
            data-testid="select-organization"
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">{placeholder}</option>
            {options.map((organization) => (
              <option
                key={organization.id}
                value={organization.id}
                disabled={organizationsAllowed?.[organization.id] === false}
              >
                {organization.name ?? ""}
              </option>
            ))}
          </select>
        </div>

        {showWarning ? (
          <div className="pp-select-organization-warning">
            <ContextNotification level="warning">
              {tr("dashboard.select-organization-modal.external-invitations-will-be-canceled")}
            </ContextNotification>
            <div className="pp-select-organization-content">
              {tr(
                "dashboard.select-organization-modal.external-invitations-warning",
                selectedOrganization.name ?? "",
              )}
            </div>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}
