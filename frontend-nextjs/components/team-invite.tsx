"use client";

// Invitation flow of the F5.5 team pages: the invite-members modal, the
// no-permission modal shared by every team flow, and the useInviteMembers
// hook that runs the check-and-invite-members step (app.main.data.team) from
// the header, the team hero and the empty invitations table.
//
// Deviations from the CLJS original, documented:
// - check-and-submit-invite-members carries organization branches behind the
//   :admin-console flag (check-organization-members, all-organization-members-
//   in-team); the shell runs with the flag off and ports the fallback path,
//   like lib/team.ts does. The organization branches arrive with F5.7.
// - fm/form-multi-input (the email chips) is reimplemented as EmailsInput: the
//   same commit keys and the same caution flag for emails already in the team,
//   without the ds popover.
// - The modal element rendered by ModalProvider sits outside the notifications
//   and dashboard providers, so this modal never reads them: success, toast
//   and refresh come through callback props created by useInviteMembers.
// - The :repeated-invitation banner and the inline context-notification reuse
//   components/context-notification.tsx (the auth page frame).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { ContextNotification } from "@/components/context-notification";
import { Form, Select, SubmitButton } from "@/components/form";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { useDashboard } from "@/lib/dashboard-context";
import { RpcError, type RpcErrorData } from "@/lib/errors";
import { useForm, validateField, type CleanData } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import {
  availableRoles,
  createInvitations,
  getTeamMembers,
  refreshTeamPermissions,
  type TeamMember,
  type TeamRole,
  type TeamWithOrganization,
} from "@/lib/team";

// --- No-permission modal -----------------------------------------------------

export type NoPermissionType =
  | "create-team"
  | "delete-team"
  | "invite-members"
  | "no-organizations-create"
  | "no-organizations-change";

// no-permission-modal* in team_form.cljs: a title/message pair per type, no
// footer, the header close button is the only action.
export function NoPermissionModal({
  permissionType,
  organizationName,
}: {
  permissionType: NoPermissionType;
  organizationName?: string | null;
}) {
  let title: string;
  let message: string;
  switch (permissionType) {
    case "create-team":
      title = tr("labels.create-team");
      message = tr("dashboard.no-permission-create-team.message", organizationName ?? "");
      break;
    case "delete-team":
      title = tr("dashboard.delete-team");
      message = tr("dashboard.no-permission-delete-team.message", organizationName ?? "");
      break;
    case "invite-members":
      title = tr("modals.invite-team-member.title");
      message = tr("dashboard.invitations.no-permission");
      break;
    case "no-organizations-create":
      title = tr("dashboard.select-organization-modal.title");
      message = tr("dashboard.no-organization-allows-create-team.message");
      break;
    default:
      title = tr("dashboard.change-organization-modal.title");
      message = tr("dashboard.no-permission-move-team.message", organizationName ?? "");
      break;
  }
  return (
    <ModalShell title={title} closeLabel={tr("labels.close")}>
      <p className="pp-modal-message">{message}</p>
    </ModalShell>
  );
}

// --- Email chips input -------------------------------------------------------

interface EmailsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  autoFocus?: boolean;
  // current-members-emails: chips that repeat a team member render as caution
  // (the caution-item-fn of form-multi-input).
  memberEmails: ReadonlySet<string>;
}

// fm/form-multi-input with valid-item-fn sm/parse-email: Enter, comma and Tab
// commit the draft, Backspace on an empty draft removes the last chip, and an
// invalid draft stays in the input instead of becoming a chip.
function EmailsInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  memberEmails,
}: EmailsInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const email = raw.trim();
    setDraft("");
    if (email === "") return;
    if (validateField({ type: "email" }, email) !== null) return;
    if (value.includes(email)) return;
    onChange([...value, email]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "Tab") {
      if (event.key === "Tab" && draft.trim() === "") return;
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="pp-email-chips">
      {value.map((email) => (
        <span
          key={email}
          className={
            memberEmails.has(email) ? "pp-email-chip pp-email-chip-caution" : "pp-email-chip"
          }
        >
          {email}
          <button
            type="button"
            className="pp-email-chip-remove"
            aria-label={tr("labels.delete")}
            onClick={() => onChange(value.filter((row) => row !== email))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="pp-email-chips-input"
        id="invite-emails-input"
        type="email"
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        data-testid="invite-emails-input"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}

// --- Invite members modal ----------------------------------------------------

export interface InviteMembersModalProps {
  team: TeamWithOrganization;
  // :team | :workspace | :hero of check-and-invite-members; :workspace renders
  // the extra explanation paragraph.
  origin: "team" | "workspace" | "hero";
  inviteEmail?: string | null;
  // on-success of the CLJS form: the caller toasts when total > 0 and
  // refreshes the member and invitation lists.
  onSent: (total: number) => void;
  onErrorToast: (message: string) => void;
  onNoPermission: () => void;
}

// invite-members-modal in app.main.ui.dashboard.team.
export function InviteMembersModal({
  team,
  origin,
  inviteEmail,
  onSent,
  onErrorToast,
  onNoPermission,
}: InviteMembersModalProps) {
  const { close } = useModal();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [errorText, setErrorText] = useState("");
  const [emails, setEmails] = useState<string[]>(
    inviteEmail !== null && inviteEmail !== undefined && inviteEmail !== "" ? [inviteEmail] : [],
  );

  // The effect [team-id] fetch-members of the CLJS modal; the repeated-email
  // warning needs the fresh list. A :not-found team reads as empty, like
  // dtm/fetch-members.
  useEffect(() => {
    let cancelled = false;
    getTeamMembers(team.id)
      .then((rows) => {
        if (!cancelled) setMembers(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  const roles = useMemo(() => availableRoles(team), [team]);
  const memberEmails = useMemo(
    () => new Set(members.map((member) => member.email)),
    [members],
  );
  const repeated = emails.some((email) => memberEmails.has(email));
  const allRepeated = emails.length > 0 && emails.every((email) => memberEmails.has(email));

  const form = useForm({
    specs: { role: { type: "select", oneOf: ["viewer", "editor", "admin"] } },
    initial: { role: "editor" },
  });

  const onSubmit = async (data: CleanData) => {
    const role = String(data.role) as TeamRole;
    try {
      const response = await createInvitations({ teamId: team.id, emails, role });
      const total = ((response ?? {}) as { total?: number }).total ?? 0;
      close();
      onSent(total);
    } catch (err) {
      const data: RpcErrorData =
        err instanceof RpcError ? err.data : { type: "unknown" };
      const type = data.type;
      const code = data.code;
      // The on-error cond of invite-members-modal, same order.
      if (type === "validation" && code === "profile-is-muted") {
        onErrorToast(tr("errors.profile-is-muted"));
        close();
        return;
      }
      if (type === "validation" && code === "max-invitations-by-request") {
        setErrorText(tr("errors.maximum-invitations-by-request-reached", data.threshold));
        return;
      }
      if (type === "restriction" && code === "max-quote-reached") {
        setErrorText(tr("errors.max-quota-reached", data.target));
        return;
      }
      if (
        code === "member-is-muted" ||
        code === "email-has-permanent-bounces" ||
        code === "email-has-complaints"
      ) {
        setErrorText(tr("errors.email-spam-or-permanent-bounces", data.email));
        return;
      }
      if (type === "restriction" && code === "email-domain-is-not-allowed") {
        onErrorToast(tr("errors.email-domain-not-allowed"));
        close();
        return;
      }
      if (type === "validation" && code === "insufficient-permissions") {
        onNoPermission();
        return;
      }
      onErrorToast(tr("errors.generic"));
      close();
    }
  };

  return (
    <ModalShell title={tr("modals.invite-team-member.title")} closeLabel={tr("labels.close")}>
      <Form
        form={form}
        onSubmit={(data) => {
          void onSubmit(data);
        }}
        className="pp-invite-form"
      >
        {origin === "workspace" ? (
          <p className="pp-modal-message">{tr("modals.invite-team-member.text")}</p>
        ) : null}
        {errorText !== "" ? <ContextNotification level="error">{errorText}</ContextNotification> : null}
        {repeated ? (
          <ContextNotification level="warning">
            {tr("modals.invite-member.repeated-invitation")}
          </ContextNotification>
        ) : null}
        <Select
          name="role"
          label={tr("onboarding.choice.team-up.roles")}
          options={roles}
          testId="invite-role"
        />
        <div className="pp-field">
          <label className="pp-field-label" htmlFor="invite-emails-input">
            {tr("modals.invite-member.emails")}
          </label>
          <EmailsInput
            value={emails}
            onChange={setEmails}
            placeholder={tr("modals.invite-member.emails")}
            autoFocus
            memberEmails={memberEmails}
          />
        </div>
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          <SubmitButton label={tr("modals.invite-member-confirm.accept")} disabled={emails.length === 0 || allRepeated} />
        </div>
      </Form>
    </ModalShell>
  );
}

// --- Hook --------------------------------------------------------------------

// check-and-invite-members (with-refreshed-team): fetch the teams, decide
// can-send-invitations? on the fresh row, then open the invite modal or the
// no-permission modal. Lives in the page context (header, hero, tables) so the
// callbacks it closes over can reach the notifications and dashboard
// providers.
export function useInviteMembers(
  team: TeamWithOrganization | null,
  profileId: string | null | undefined,
  origin: "team" | "workspace" | "hero" = "team",
) {
  const modal = useModal();
  const notifications = useNotifications();
  const { refreshTeams, refreshMembers, refreshInvitations } = useDashboard();

  const openNoPermission = useCallback(
    (permissionType: NoPermissionType, organizationName?: string | null) => {
      modal.open(
        <NoPermissionModal permissionType={permissionType} organizationName={organizationName} />,
      );
    },
    [modal],
  );

  const openInvite = useCallback(
    async (inviteEmail?: string | null) => {
      if (team === null) return;
      let freshTeam: TeamWithOrganization | null = null;
      let canInvite = false;
      try {
        const result = await refreshTeamPermissions(team.id, profileId);
        freshTeam = result.team;
        canInvite = result.canInvite;
      } catch {
        // with-refreshed-team fails the whole event when get-teams fails; the
        // shell opens nothing, same as CLJS.
        return;
      }
      // teams-fetched: the same answer updates the stored teams list.
      void refreshTeams();
      if (freshTeam === null || !canInvite) {
        openNoPermission("invite-members", freshTeam?.organization?.name ?? null);
        return;
      }
      const opened = freshTeam;
      modal.open(
        <InviteMembersModal
          team={opened}
          origin={origin}
          inviteEmail={inviteEmail ?? null}
          onSent={(total) => {
            if (total > 0) notifications.success(tr("notifications.invitation-email-sent"));
            void refreshMembers();
            void refreshInvitations();
          }}
          onErrorToast={(message) => notifications.error(message)}
          onNoPermission={() => openNoPermission("invite-members", opened.organization?.name ?? null)}
        />,
      );
    },
    [
      team,
      profileId,
      origin,
      modal,
      notifications,
      refreshTeams,
      refreshMembers,
      refreshInvitations,
      openNoPermission,
    ],
  );

  return { openInvite, openNoPermission };
}
