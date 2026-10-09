"use client";

// Invitations section (F5.5). Port of invitation-section* and
// team-invitations-page* of app.main.ui.dashboard.team: the sortable table
// with row checkboxes, the role selector, the copy-link action, the
// resend/delete confirmations and the selected-rows toolbar.
//
// Deviations from the CLJS original, documented:
// - invitation-section* keeps a local copy of the rows and sorts that copy in
//   place; the shell sorts the context rows on every render through
//   sortedInvitations and resets the sort state when the rows change, which
//   is what the [team] effect of the CLJS view does.
// - on-confirm-delete emits one delete-invitation per selected email and each
//   success refreshes the list; the shell awaits the deletes one by one,
//   toasts per row and refreshes once at the end.
// - The copy action hides the CLJS attach modal on success; the shell has no
//   attach modal for invitations, so it shows the tick and the toast only.
// - The row icons come from the shell table classes instead of the ds icon
//   components until @penpot/ui is wired.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { TeamHeader } from "@/components/team-header";
import { useInviteMembers } from "@/components/team-invite";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  canSendInvitations,
  copyInvitationLink,
  createInvitations,
  deleteInvitation,
  invitationStatus,
  nextSortState,
  roleLabel,
  selectedInvitations,
  sortedInvitations,
  updateInvitationRole,
  type InvitationSortField,
  type InvitationSortState,
  type TeamInvitation,
  type TeamRole,
} from "@/lib/team";

// invitation-modal: the selected rows with their roles, the resend keeping a
// cancel button and the delete going straight to labels.continue.
function InvitationModal({
  selected,
  isDelete,
  onConfirm,
}: {
  selected: TeamInvitation[];
  isDelete: boolean;
  onConfirm: () => void;
}) {
  const { close } = useModal();
  return (
    <ModalShell
      title={
        isDelete
          ? tr("dashboard.invitation-modal.title.delete-invitations")
          : tr("dashboard.invitation-modal.title.resend-invitations")
      }
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          {isDelete ? null : (
            <button type="button" className="pp-btn-secondary" onClick={close}>
              {tr("labels.cancel")}
            </button>
          )}
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="invitation-confirm"
            onClick={() => {
              close();
              onConfirm();
            }}
          >
            {isDelete ? tr("labels.continue") : tr("labels.resend")}
          </button>
        </div>
      }
    >
      <p className="pp-modal-message">
        {isDelete
          ? tr("dashboard.invitation-modal.delete")
          : tr("dashboard.invitation-modal.resend")}
      </p>
      <div className="pp-invitation-list">
        {selected.map((row) => (
          <p key={row.email}>{"- " + row.email + " (" + roleLabel(row.role) + ")"}</p>
        ))}
      </div>
    </ModalShell>
  );
}

interface RoleSelector {
  email: string;
  anchor: MenuAnchor;
}

export default function DashboardInvitationsPage() {
  const { team, teamId, invitations, refreshInvitations } = useDashboard();
  const { profile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const { openInvite } = useInviteMembers(team, profile?.id);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sortState, setSortState] = useState<InvitationSortState>({
    field: null,
    direction: "asc",
  });
  const [roleSelector, setRoleSelector] = useState<RoleSelector | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const viewerId = profile?.id ?? null;
  const canInvite = canSendInvitations(team, viewerId);

  // team-invitations-page*: fetch-invitations on every team change.
  useEffect(() => {
    void refreshInvitations();
  }, [teamId, refreshInvitations]);

  // The [team] effect of invitation-section*: a fresh team row resets the
  // sort state (the shell watches the rows it reads instead).
  useEffect(() => {
    setSortState({ field: null, direction: "asc" });
  }, [invitations]);

  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.team-invitations",
          team["is-default"] === true ? tr("dashboard.personal-projects") : team.name,
        ),
  );

  const rows = useMemo(
    () => sortedInvitations(invitations ?? [], sortState),
    [invitations, sortState],
  );
  const selectedRows = useMemo(() => selectedInvitations(rows, selected), [rows, selected]);
  const selectedCount = selected.size;

  const onSelectChange = useCallback(
    (email: string) => {
      if (!canInvite) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(email)) next.delete(email);
        else next.add(email);
        return next;
      });
    },
    [canInvite],
  );

  const onChangeRole = useCallback(
    async (email: string, role: TeamRole) => {
      if (teamId === null) return;
      try {
        await updateInvitationRole(teamId, email, role);
        await refreshInvitations();
      } catch {
        notifications.error(tr("errors.generic"));
      }
    },
    [teamId, refreshInvitations, notifications],
  );

  // on-error of invitation-actions* (the copy flow).
  const onCopyError = useCallback(
    (err: unknown, email: string) => {
      const data = err instanceof RpcError ? err.data : null;
      const type = data?.type;
      const code = data?.code;
      if (type === "validation" && code === "profile-is-muted") {
        notifications.error(tr("errors.profile-is-muted"));
      } else if (type === "validation" && code === "member-is-muted") {
        notifications.error(tr("errors.member-is-muted"));
      } else if (
        type === "restriction" &&
        (code === "email-has-permanent-bounces" || code === "email-has-complaints")
      ) {
        notifications.error(tr("errors.email-has-permanent-bounces", email));
      } else {
        notifications.error(tr("errors.generic"));
      }
    },
    [notifications],
  );

  const onCopy = useCallback(
    async (email: string) => {
      if (teamId === null) return;
      try {
        await copyInvitationLink(teamId, email);
      } catch (err) {
        onCopyError(err, email);
        return;
      }
      setCopiedEmail(email);
      window.setTimeout(() => {
        setCopiedEmail((current) => (current === email ? null : current));
      }, 1000);
      notifications.success(tr("notifications.invitation-link-copied"));
    },
    [teamId, onCopyError, notifications],
  );

  // on-error of invitation-section* (the resend flow).
  const onResendError = useCallback(
    (err: unknown) => {
      const data = err instanceof RpcError ? err.data : null;
      const type = data?.type;
      const code = data?.code;
      if (type === "validation" && code === "profile-is-muted") {
        notifications.error(tr("errors.profile-is-muted"));
      } else if (type === "validation" && code === "max-invitations-by-request") {
        notifications.error(
          tr("errors.maximum-invitations-by-request-reached", data?.threshold),
        );
      } else if (type === "restriction" && code === "max-quote-reached") {
        notifications.error(tr("errors.max-quota-reached", data?.target));
      } else if (
        code === "member-is-muted" ||
        code === "email-has-permanent-bounces" ||
        code === "email-has-complaints"
      ) {
        notifications.error(tr("errors.email-spam-or-permanent-bounces", data?.email));
      } else {
        notifications.error(tr("errors.generic"));
      }
    },
    [notifications],
  );

  // on-confirm-resend: one create-invitations call carrying the selected rows
  // with their individual roles.
  const onConfirmResend = useCallback(async () => {
    if (teamId === null) return;
    setBusy(true);
    try {
      await createInvitations({
        teamId,
        invitations: selectedRows.map((row) => ({ email: row.email, role: row.role ?? "viewer" })),
        resend: true,
      });
    } catch (err) {
      onResendError(err);
      setBusy(false);
      return;
    }
    notifications.success(tr("notifications.invitation-email-sent"));
    setSelected(new Set());
    await refreshInvitations();
    setBusy(false);
  }, [teamId, selectedRows, onResendError, notifications, refreshInvitations]);

  // on-confirm-delete: one delete-invitation per selected email, one toast per
  // answer, then a single refresh.
  const onConfirmDelete = useCallback(async () => {
    if (teamId === null) return;
    setBusy(true);
    const emails = [...selected];
    setSelected(new Set());
    for (const email of emails) {
      try {
        await deleteInvitation(teamId, email);
        notifications.success(tr("notifications.invitation-deleted"));
      } catch {
        notifications.error(tr("errors.generic"));
      }
    }
    await refreshInvitations();
    setBusy(false);
  }, [teamId, selected, notifications, refreshInvitations]);

  const onResend = useCallback(() => {
    modal.open(
      <InvitationModal
        selected={selectedRows}
        isDelete={false}
        onConfirm={() => {
          void onConfirmResend();
        }}
      />,
    );
  }, [modal, selectedRows, onConfirmResend]);

  const onDelete = useCallback(() => {
    modal.open(
      <InvitationModal
        selected={selectedRows}
        isDelete={true}
        onConfirm={() => {
          void onConfirmDelete();
        }}
      />,
    );
  }, [modal, selectedRows, onConfirmDelete]);

  const onOrderBy = useCallback((field: InvitationSortField) => {
    setSortState((current) => nextSortState(current, field));
  }, []);

  if (team === null || teamId === null) return null;

  const sortIcon = (field: InvitationSortField): string => {
    if (sortState.field === field && sortState.direction === "desc") return "\u2191";
    return "\u2193";
  };

  // The roles-dropdown entries of invitation-role-selector*: admin, editor,
  // viewer, in that order.
  const roleEntriesFor = (email: string): MenuEntry[] =>
    (["admin", "editor", "viewer"] as TeamRole[]).map((role) => ({
      type: "item",
      id: "invitation-role-" + email + "-" + role,
      label: roleLabel(role),
      onSelect: () => {
        setRoleSelector(null);
        void onChangeRole(email, role);
      },
    }));

  return (
    <>
      <TeamHeader
        section="invitations"
        team={team}
        profileId={viewerId}
        invitations={invitations}
        onInvite={(inviteEmail) => {
          void openInvite(inviteEmail);
        }}
      />

      <section
        className="pp-dashboard-container pp-dashboard-team-invitations"
        data-testid="team-invitations-section"
      >
        <div className="pp-team-table pp-team-invitations">
          {!canInvite && rows.length > 0 ? (
            <div className="pp-empty-invitations">
              <div className="pp-no-permission-text">
                {tr("dashboard.invitations.no-permission")}
              </div>
            </div>
          ) : null}

          {canInvite && selectedCount > 0 ? (
            <div className="pp-invitations-actions">
              <div>{tr("team.invitations-selected", selectedCount)}</div>
              <button
                type="button"
                className="pp-btn-secondary"
                disabled={busy}
                data-testid="resend-invitations"
                onClick={onResend}
              >
                {tr("labels.resend-invitation")}
              </button>
              <button
                type="button"
                className="pp-icon-btn"
                aria-label={tr("labels.delete-invitation")}
                disabled={busy}
                data-testid="delete-invitations"
                onClick={onDelete}
              >
                <span aria-hidden="true">{"\u2715"}</span>
              </button>
            </div>
          ) : null}

          <div className="pp-team-table-header">
            <div className="pp-team-field pp-field-email">{tr("labels.invitations")}</div>
            <div className="pp-team-field pp-field-role">
              {tr("labels.role")}
              <button
                type="button"
                className="pp-sort-btn"
                aria-label={tr("dashboard.order-invitations-by-role")}
                aria-pressed={sortState.field === "role"}
                data-testid="order-by-role"
                onClick={() => onOrderBy("role")}
              >
                <span aria-hidden="true">{sortIcon("role")}</span>
              </button>
            </div>
            <div className="pp-team-field pp-field-status">
              {tr("labels.status")}
              <button
                type="button"
                className="pp-sort-btn"
                aria-label={tr("dashboard.order-invitations-by-status")}
                aria-pressed={sortState.field === "status"}
                data-testid="order-by-status"
                onClick={() => onOrderBy("status")}
              >
                <span aria-hidden="true">{sortIcon("status")}</span>
              </button>
            </div>
            <div className="pp-team-field pp-field-actions" />
          </div>

          {rows.length === 0 ? (
            <div className="pp-empty-invitations">
              <div>{tr("labels.no-invitations")}</div>
              {canInvite ? (
                <>
                  <div>{tr("labels.no-invitations-gather-people")}</div>
                  <button
                    type="button"
                    className="pp-btn-primary"
                    data-testid="invite-member"
                    onClick={() => {
                      void openInvite(null);
                    }}
                  >
                    {tr("dashboard.invite-profile")}
                  </button>
                </>
              ) : (
                <div className="pp-no-permission-text">
                  {tr("dashboard.invitations.no-permission")}
                </div>
              )}
            </div>
          ) : (
            <div className="pp-team-table-rows">
              {rows.map((invitation) => {
                const email = invitation.email;
                const status = invitationStatus(invitation);
                const checked = selected.has(email);
                const roleOpen = roleSelector !== null && roleSelector.email === email;
                return (
                  <div className="pp-team-table-row pp-team-row-invitation" key={email}>
                    <div className="pp-team-field pp-field-email">
                      {canInvite ? (
                        <label className="pp-invitation-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            data-testid={"invitation-check-" + email}
                            onChange={() => onSelectChange(email)}
                          />
                          <span>{email}</span>
                        </label>
                      ) : (
                        <div>{email}</div>
                      )}
                    </div>

                    <div className="pp-team-field pp-field-role">
                      {canInvite && status === "pending" ? (
                        <button
                          type="button"
                          className="pp-role-selector pp-has-priv"
                          aria-haspopup="menu"
                          aria-expanded={roleOpen}
                          data-testid={"invitation-role-" + email}
                          onClick={(event) => {
                            event.stopPropagation();
                            const element = event.currentTarget;
                            setRoleSelector((current) =>
                              current !== null && current.email === email
                                ? null
                                : { email, anchor: menuAnchorFromElement(element) },
                            );
                          }}
                        >
                          <span className="pp-role-label">{roleLabel(invitation.role)}</span>
                          <span aria-hidden="true">{"\u25be"}</span>
                        </button>
                      ) : (
                        <div className="pp-role-selector">
                          <span className="pp-role-label">{roleLabel(invitation.role)}</span>
                        </div>
                      )}
                    </div>

                    <div className="pp-team-field pp-field-status">
                      <span
                        className={
                          status === "expired" ? "pp-badge pp-badge-warning" : "pp-badge"
                        }
                      >
                        {status === "expired"
                          ? tr("labels.expired-invitation")
                          : tr("labels.pending-invitation")}
                      </span>
                    </div>

                    <div className="pp-team-field pp-field-actions">
                      {canInvite ? (
                        <button
                          type="button"
                          className="pp-icon-btn"
                          aria-label={tr("labels.copy-invitation-link")}
                          data-testid={"copy-invitation-" + email}
                          onClick={() => {
                            void onCopy(email);
                          }}
                        >
                          <span aria-hidden="true">
                            {copiedEmail === email ? "\u2713" : "\u29C9"}
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {roleSelector !== null ? (
        <DashboardMenu
          anchor={roleSelector.anchor}
          entries={roleEntriesFor(roleSelector.email)}
          onClose={() => setRoleSelector(null)}
        />
      ) : null}
    </>
  );
}
