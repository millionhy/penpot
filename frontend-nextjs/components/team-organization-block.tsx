"use client";

// The organization block of the team settings page (F5.7b), the port of the
// (when nitrate? ...) section of team-settings-page* in
// app.main.ui.dashboard.team. It shows the organization the team belongs to,
// the owner's "..." menu (change organization, remove from organization) and,
// for a team without one, the "add" link. Everything sits behind the
// :admin-console flag, exactly like the CLJS section.
//
// Deviations from the CLJS original, documented:
// - change-team-organization and add-team-to-organization fetch fresh teams
//   first (get-teams), then run the permission gate on that row, like the CLJS
//   show-*-modal events.
// - add-team-to-organization in data/nitrate sends an audit event and can park
//   a pending action while it redirects to the organization's SSO provider.
//   The shell keeps the check-nitrate-sso gate and the redirect; see the note
//   in lib/team-organization.ts about the pending action and the audit event.
// - The CLJS combobox, dropdown and context-notification components are
//   replaced by the shared shell pieces (DashboardMenu, SelectOrganizationModal
//   and ContextNotification); the stylesheet lives in styles/dashboard.css.

import { useCallback, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
} from "@/components/dashboard-menu";
import { ConfirmDialog, ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { NoPermissionModal } from "@/components/team-invite";
import { SelectOrganizationModal } from "@/components/select-organization-modal";
import { initials } from "@/lib/avatars";
import { getTeams } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import { teamToOrganization } from "@/lib/org-switch";
import { RpcError } from "@/lib/errors";
import { useSession } from "@/lib/session";
import type { TeamOrganization, TeamWithOrganization } from "@/lib/team";
import {
  addTeamToOrganization,
  allOrganizations,
  canAddToOrganization,
  canChangeOrganization,
  canRemoveFromOrganization,
  changeTargetOrganizations,
  checkNitrateSso,
  organizationsAllowedToCreateTeams,
  organizationsAllowedToJoin,
  removeTeamFromOrganization,
} from "@/lib/team-organization";

// The menu icon of organization-options-btn (resources/images/icons/menu.svg,
// the vertical three dots), stroked like the CLJS icon-xref renders it.
const MENU_PATH =
  "m8 7.333c.368 0 .667.299.667.667s-.299.667-.667.667-.667-.299-.667-.667.299-.667.667-.667zm0-4.666c.368 0 .667.298.667.666s-.299.667-.667.667-.667-.299-.667-.667.299-.666.667-.666zm0 9.333c.368 0 .667.299.667.667s-.299.666-.667.666-.667-.298-.667-.666.299-.667.667-.667z";

function MenuIcon() {
  return (
    <svg
      className="pp-organization-menu-icon"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={MENU_PATH} />
    </svg>
  );
}

// organization-avatar* at the xxxl size of the settings block (30px).
function OrganizationAvatar({ organization }: { organization: TeamOrganization }) {
  const name = organization.name ?? "";
  const customPhoto = organization["custom-photo"];
  const background = organization["avatar-bg-url"];
  const letters = initials(name);

  if (typeof customPhoto === "string" && customPhoto !== "") {
    return (
      <img
        className="pp-organization-avatar pp-organization-avatar-xxxl pp-organization-avatar-custom"
        src={customPhoto}
        alt={name}
      />
    );
  }
  return (
    <div className="pp-organization-avatar pp-organization-avatar-xxxl" aria-hidden="true">
      {typeof background === "string" && background !== "" ? (
        <img className="pp-organization-avatar-bg" src={background} alt="" />
      ) : null}
      {letters.length > 0 ? (
        <span className="pp-organization-avatar-initials">{letters}</span>
      ) : null}
    </div>
  );
}

type FreshTeams =
  | { ok: true; teams: TeamWithOrganization[] }
  | { ok: false };

// with-refreshed-team steps: the organization flows never trust the stored
// row, so every action starts from a get-teams round trip.
async function fetchFreshTeams(): Promise<FreshTeams> {
  try {
    const teams = (await getTeams()) as unknown as TeamWithOrganization[];
    return { ok: true, teams: Array.isArray(teams) ? teams : [] };
  } catch {
    return { ok: false };
  }
}

export function TeamOrganizationBlock({ team }: { team: TeamWithOrganization }) {
  const { teams, refreshTeams } = useDashboard();
  const { profile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

  const profileId = profile?.id ?? null;
  const organizations = allOrganizations(teams);
  const organization = teamToOrganization(team);
  const permissions = team.permissions;
  const canAdd = canAddToOrganization(team, organizations);
  const showOptions =
    permissions?.["is-owner"] === true && team["is-default"] !== true && organization !== null;

  const openNoPermission = useCallback(
    (organizationName: string | null | undefined) => {
      modal.open(
        <NoPermissionModal
          permissionType="no-organizations-change"
          organizationName={organizationName ?? null}
        />,
      );
    },
    [modal],
  );

  const openNoValidOrganizations = useCallback(
    (title: string) => {
      modal.open(
        <ModalShell title={title} closeLabel={tr("labels.close")}>
          <p className="pp-modal-message">
            {tr("dashboard.team-organization.add.no-valid-organizations")}
          </p>
        </ModalShell>,
      );
    },
    [modal],
  );

  // add-team-to-organization: the SSO gate first, then the command; without an
  // authorized session the backend answers with the provider redirect.
  const applyOrganization = useCallback(
    async (teamId: string, organizationId: string) => {
      try {
        const url = typeof window !== "undefined" ? window.location.href : "";
        const sso = await checkNitrateSso(organizationId, url);
        if (sso.authorized === true) {
          await addTeamToOrganization(teamId, organizationId);
          await refreshTeams();
          return;
        }
        const redirect = sso["redirect-uri"];
        if (typeof redirect === "string" && redirect.length > 0) {
          window.location.assign(redirect);
        }
      } catch {
        notifications.error(tr("errors.generic"));
      }
    },
    [notifications, refreshTeams],
  );

  // on-change-team-organization: fresh rows, the move/create rules, the
  // per-organization membership check, then the select modal.
  const openChangeOrganization = useCallback(async () => {
    setAnchor(null);
    if (organization === null) return;
    const fresh = await fetchFreshTeams();
    if (!fresh.ok) return;
    await refreshTeams();
    const all = allOrganizations(fresh.teams);
    const targets = changeTargetOrganizations(all, organization, profileId);
    if (targets.length === 0) {
      openNoPermission(organization.name);
      return;
    }
    let allowed: Record<string, boolean>;
    try {
      allowed = await organizationsAllowedToJoin(team.id, targets);
    } catch {
      return;
    }
    if (!targets.some((target) => allowed[target.id] === true)) {
      openNoValidOrganizations(tr("dashboard.change-organization-modal.title"));
      return;
    }
    const hasFiltered = organizationsAllowedToCreateTeams(all, profileId).length < all.length;
    modal.open(
      <SelectOrganizationModal
        organizations={targets}
        organizationsAllowed={allowed}
        currentOrganization={organization}
        teamId={team.id}
        title={tr("dashboard.change-organization-modal.title")}
        description={tr("dashboard.change-organization-modal.description")}
        choose={tr("dashboard.change-organization-modal.choose")}
        placeholder={tr("dashboard.change-organization-modal.select")}
        accept={tr("dashboard.change-organization-modal.accept")}
        cancel={tr("labels.cancel")}
        infoMessage={
          hasFiltered
            ? tr("dashboard.select-organization-modal.permission-info")
            : undefined
        }
        onConfirm={(organizationId) => {
          void applyOrganization(team.id, organizationId);
        }}
      />,
    );
  }, [
    applyOrganization,
    modal,
    openNoPermission,
    openNoValidOrganizations,
    organization,
    profileId,
    refreshTeams,
    team.id,
  ]);

  // show-add-team-to-organization-modal: the same shape without a source
  // organization, matching the CLJS permission filter.
  const openAddToOrganization = useCallback(async () => {
    const fresh = await fetchFreshTeams();
    if (!fresh.ok) return;
    await refreshTeams();
    const all = allOrganizations(fresh.teams);
    const targets = organizationsAllowedToCreateTeams(all, profileId);
    if (targets.length === 0) {
      modal.open(<NoPermissionModal permissionType="no-organizations-create" />);
      return;
    }
    let allowed: Record<string, boolean>;
    try {
      allowed = await organizationsAllowedToJoin(team.id, targets);
    } catch {
      return;
    }
    if (!targets.some((target) => allowed[target.id] === true)) {
      openNoValidOrganizations(tr("dashboard.select-organization-modal.title"));
      return;
    }
    modal.open(
      <SelectOrganizationModal
        organizations={targets}
        organizationsAllowed={allowed}
        teamId={team.id}
        title={tr("dashboard.select-organization-modal.title")}
        choose={tr("dashboard.select-organization-modal.choose")}
        placeholder={tr("dashboard.select-organization-modal.select")}
        accept={tr("dashboard.select-organization-modal.accept")}
        cancel={tr("labels.cancel")}
        infoMessage={
          targets.length < all.length
            ? tr("dashboard.select-organization-modal.permission-info-add")
            : undefined
        }
        onConfirm={(organizationId) => {
          void applyOrganization(team.id, organizationId);
        }}
      />,
    );
  }, [
    applyOrganization,
    modal,
    openNoValidOrganizations,
    profileId,
    refreshTeams,
    team.id,
  ]);

  // remove-team-from-organization: fresh rows, the move rule, the confirm
  // dialog, then the command (a :not-allowed answer reopens the no-permission
  // modal, like the CLJS rpc/catch branch).
  const openRemoveFromOrganization = useCallback(async () => {
    setAnchor(null);
    const fresh = await fetchFreshTeams();
    if (!fresh.ok) return;
    const freshTeam = fresh.teams.find((row) => row.id === team.id) ?? null;
    if (freshTeam === null) return;
    const source = freshTeam.organization ?? null;
    if (source === null) return;
    if (!canRemoveFromOrganization(freshTeam, profileId)) {
      openNoPermission(source.name);
      return;
    }
    modal.open(
      <ConfirmDialog
        title={tr("modals.remove-team-organization.title")}
        message={tr(
          "modals.remove-team-organization.text",
          freshTeam.name,
          source.name ?? "",
        )}
        hint={tr("modals.remove-team-organization.info")}
        acceptLabel={tr("modals.remove-team-organization.accept")}
        cancelLabel={tr("labels.cancel")}
        destructive
        onAccept={() => {
          void (async () => {
            try {
              await removeTeamFromOrganization(team.id, source.id, source.name ?? "");
              await refreshTeams();
            } catch (error) {
              const code = error instanceof RpcError ? error.data.code : undefined;
              if (code === "not-allowed") {
                openNoPermission(source.name);
                return;
              }
              notifications.error(tr("errors.generic"));
            }
          })();
        }}
      />,
    );
  }, [modal, notifications, openNoPermission, profileId, refreshTeams, team.id]);

  if (organization === null) {
    return (
      <div className="pp-settings-block pp-team-organization">
        <div className="pp-block-label">{tr("dashboard.team-organization")}</div>
        <div className="pp-block-content">
          <span className="pp-block-text">{tr("dashboard.team-organization.none")}</span>
        </div>
        {canAdd ? (
          <div className="pp-block-content">
            <span className="pp-block-text">
              <a
                className="pp-link"
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  void openAddToOrganization();
                }}
              >
                {tr("dashboard.team-organization.add")}
              </a>
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pp-settings-block pp-team-organization">
      <div className="pp-block-label">{tr("dashboard.team-organization")}</div>
      <div className="pp-block-content">
        <div className="pp-organization-block-content">
          <OrganizationAvatar organization={organization} />
          <span className="pp-block-text">{organization.name}</span>
          {showOptions ? (
            <button
              type="button"
              className={
                anchor !== null
                  ? "pp-organization-options-btn pp-organization-options-btn-open"
                  : "pp-organization-options-btn"
              }
              aria-label={tr("dashboard.options")}
              aria-haspopup="menu"
              aria-expanded={anchor !== null}
              data-testid="organization-options"
              onClick={(event) => {
                setAnchor(anchor === null ? menuAnchorFromElement(event.currentTarget) : null);
              }}
            >
              <MenuIcon />
            </button>
          ) : null}
        </div>
      </div>

      {anchor !== null ? (
        <DashboardMenu
          anchor={anchor}
          ariaLabel={tr("dashboard.options")}
          onClose={() => setAnchor(null)}
          entries={[
            ...(canChangeOrganization(organizations)
              ? [
                  {
                    type: "item" as const,
                    id: "change-organization",
                    label: tr("dashboard.team-organization.change"),
                    onSelect: () => {
                      void openChangeOrganization();
                    },
                  },
                ]
              : []),
            {
              type: "item" as const,
              id: "remove-organization",
              label: tr("dashboard.team-organization.remove"),
              onSelect: () => {
                void openRemoveFromOrganization();
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}
