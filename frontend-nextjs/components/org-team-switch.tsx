"use client";

// organization-team-switch* in app.main.ui.dashboard.organization-team-switch
// (F5.7a): the two-level dropdown that merges the organization switcher and
// the team switcher — the left column lists the user's organizations, the
// right column the teams of the organization currently selected on the left.
// The "..." team-management menu stays in components/team-options-menu.tsx
// (TeamOptionsButton), and the organization right-click menu ported from
// organization-team-switch-menus lives here, since it is just one entry.
//
// Deviations from the CLJS original, documented:
// - The CLJS dropdown-menu* is a global-click component; the shell dropdown
//   renders in place and closes on a mousedown outside the switcher root and
//   on Escape. A mousedown inside a DashboardMenu popup (the "..." menu or
//   the context menu, both portaled) is ignored so those menus can open from
//   within the dropdown. Rows that must not close the dropdown stop the
//   event, matching the rows the CLJS version stops propagation on.
// - The organization context menu uses DashboardMenu's point anchor instead
//   of the CLJS fixed-position dropdown; DashboardMenu closes itself on
//   outside clicks and Escape.
// - The CLJS "..." menu and this dropdown close each other through the
//   :dropdown/open store event; the shell wires TeamOptionsButton's onOpen
//   callback to close the dropdown instead.
// - resolve-team-photo-url falls back to a generated avatar without a photo
//   id; the shell generates it client-side (canvas), like member-avatar does,
//   so SSR never paints a broken image.
// - go-to-nitrate-ac-create-organization navigates away with a full page
//   load (nav-raw :href); window.location.assign has the same effect. The
//   no-license branch of on-create-organization opens the nitrate
//   subscription popup instead; that flow arrives with F5.7b, so until then
//   both branches land on the admin-console page.
// - The profile subscription slice (props.subscription for the plan lookups,
//   the top-level one for the license check) is runtime-flag shaped and not
//   part of the generated Profile type, so it is read through a documented
//   cast, like lib/nitrate.ts explains for LicensedProfile.

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DashboardMenu,
  menuAnchorFromEvent,
  type MenuAnchor,
} from "@/components/dashboard-menu";
import { useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { useOrganizationLeaveFlows } from "@/components/org-leave-flows";
import { NoPermissionModal } from "@/components/team-invite";
import { TeamFormModal } from "@/components/team-form-modal";
import { TeamOptionsButton } from "@/components/team-options-menu";
import { generateAvatar, initials } from "@/lib/avatars";
import { config, hasFlag } from "@/lib/config";
import { dashboardHref, getTeams, subscriptionType } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import {
  adminConsoleCreateOrganizationHref,
  isValidLicense,
  type LicensedProfile,
} from "@/lib/nitrate";
import {
  PERSONAL_BUCKET_ID,
  canLeaveOrganization,
  closedControlLine2,
  createTeamTargetId,
  hasOrganizations,
  organizationAllowed,
  organizationBucketId,
  organizationsFromTeams,
  resolveAdminConsoleHref,
  showCreateOrganizationInTeamsColumn,
  showSubscriptionBadge,
  showTeamOptionsButton,
  simplifiedMode,
  sortAllTeams,
  sortOrganizations,
  teamDisplayName,
  teamHref,
  teamSelectTarget,
  teamToOrganization,
  teamsForOrganization,
} from "@/lib/org-switch";
import { useSession } from "@/lib/session";
import { isMacos } from "@/lib/shortcuts";
import {
  teamPhotoUrl,
  type TeamOrganization,
  type TeamWithOrganization,
} from "@/lib/team";

// new-tab-click? (organization-team-switch): a click with the platform's
// primary modifier keeps the browser's own new-tab behavior, so the anchor
// must not run the SPA navigation. lib/shortcuts splits the modifier the same
// way (macOS: meta, elsewhere: ctrl). Middle clicks never reach onClick and
// the browser handles them natively.
function modifiedClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacos() ? event.metaKey : event.ctrlKey;
}

// The sprite paths of the icons the switcher uses, inlined because the shell
// has no icon sprite (frontend/resources/images/icons).
const FILES_PATHS = [
  "M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8",
  "M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z",
  "M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1",
];
const TICK_PATH = "m13.333 4-7.333 7.333-3.333-3.333";
const ARROW_RIGHT_PATH = "m6 12 4-4-4-4";
const ADD_PATH = "m8 3.333v4.667 4.667m-4.667-4.667h4.667 4.667";
const ARROW_UP_RIGHT_PATH = "M2.667 13.333 13.333 2.667m0 0H2.667m10.666 0v10.666";
// penpot-logo-subtle.svg (frontend/resources/images/assets), the mark of the
// "Other teams" bucket row.
const PENPOT_LOGO_PATH =
  "M8.376953125,2L6.275421142578125,4.960968017578125L6.275421142578125,6.636688232421875L4.4433746337890625,7.5078125L4.427734375,7.500030517578125L4.427734375,18.42181396484375L11.564437866210938,21.792938232421875L11.998077392578125,22L12.435546875,21.792938232421875L19.572250366210938,18.42181396484375L19.572250366210938,7.500030517578125L19.560562133789062,7.5078125L17.728515625,6.636688232421875L17.728515625,4.960968017578125L17.666030883789062,4.87109375L15.623046875,2L13.521514892578125,4.960968017578125L13.521514892578125,4.96478271484375L11.990234375,2.808563232421875L10.470687866210938,4.94921875L10.416046142578125,4.87109375ZM8.748046875,3.71875L9.560562133789062,4.863311767578125L7.1894378662109375,4.863311767578125L7.994171142578125,3.730499267578125ZM15.994140625,3.71875L16.806655883789062,4.863311767578125L14.435531616210938,4.863311767578125L15.240264892578125,3.730499267578125ZM12.361328125,4.531280517578125L13.173843383789062,5.67584228515625L10.802719116210938,5.67584228515625L11.607452392578125,4.54302978515625ZM6.966796875,5.445281982421875L8.091827392578125,5.445281982421875L8.091827392578125,9.23052978515625L6.966796875,8.69921875ZM8.669921875,5.445281982421875L9.787094116210938,5.445281982421875L9.787094116210938,10.03131103515625L8.669921875,9.50396728515625ZM14.212890625,5.445281982421875L15.337921142578125,5.445281982421875L15.337921142578125,9.5L14.212890625,10.03131103515625ZM15.912109375,5.445281982421875L17.029296875,5.445281982421875L17.029296875,8.69921875L15.912109375,9.2265625ZM10.576187133789062,6.25384521484375L11.701156616210938,6.25384521484375L11.701156616210938,10.937530517578125L10.576187133789062,10.406219482421875ZM12.279296875,6.25384521484375L13.396484375,6.25384521484375L13.396484375,10.41400146484375L12.279296875,10.94134521484375ZM17.724624633789062,7.496063232421875L18.712875366210938,7.90240478515625L17.724624633789062,8.37115478515625ZM6.2714691162109375,7.500030517578125L6.2714691162109375,8.37115478515625L5.2832183837890625,7.90240478515625ZM5.298858642578125,8.875L11.560546875,11.832000732421875L11.560546875,20.828125L5.298858642578125,17.871124267578125ZM18.697296142578125,8.875L18.697296142578125,17.871124267578125L12.435546875,20.828125L12.435546875,11.835968017578125Z";

// personal-projects-icon*: the "Personal projects" icon at the 20px size the
// design asks for, which icon* has no size for.
function PersonalProjectsIcon() {
  return (
    <svg
      className="pp-org-switch-personal-icon-svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {FILES_PATHS.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

// The 16px-viewBox sprite icons at their CLJS display sizes.
function SpriteIcon({ path, size }: { path: string; size: number }) {
  return (
    <svg
      className="pp-org-switch-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

// menu-team-icon* (app.main.ui.dashboard.subscription): the one-letter plan
// badge next to a team name. The CLJS icon font renders i/character-u and
// i/character-e; the shell renders the letters directly. Rendered only behind
// showSubscriptionBadge, so the type is unlimited or enterprise.
function SubscriptionBadge({ subscriptionType: planType }: { subscriptionType: string }) {
  const unlimited = planType === "unlimited";
  return (
    <span className="pp-org-switch-sub-icon-wrapper">
      <span
        className="pp-org-switch-sub-icon"
        title={tr(
          unlimited
            ? "subscription.dashboard.power-up.unlimited-plan"
            : "subscription.dashboard.power-up.enterprise-plan",
        )}
        data-testid="subscription-icon"
      >
        {unlimited ? "U" : "E"}
      </span>
    </span>
  );
}

// cf/resolve-team-photo-url: the team picture, or a generated avatar without
// a photo id. The canvas runs client-side only (see the file header).
function TeamPicture({ team, className }: { team: TeamWithOrganization; className: string }) {
  const photo = teamPhotoUrl(team, config.publicUri);
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    if (photo !== null) {
      setAvatar(null);
      return;
    }
    setAvatar(generateAvatar({ name: team.name }));
  }, [photo, team.name]);

  return <img className={className} src={photo ?? avatar ?? ""} alt={team.name} />;
}

// organization-avatar* (app.main.ui.components.organization-avatar, size
// xxl): the custom photo when the organization uploaded one (the backend
// resolves it to a public URI), otherwise the background image with the
// initials.
function OrganizationAvatar({ organization }: { organization: TeamOrganization }) {
  const name = organization.name ?? "";
  const customPhoto = organization["custom-photo"];
  if (typeof customPhoto === "string" && customPhoto !== "") {
    return (
      <img
        className="pp-org-switch-org-avatar pp-org-switch-org-avatar-custom"
        src={customPhoto}
        alt={name}
      />
    );
  }
  const background = organization["avatar-bg-url"];
  const letters = initials(name);
  return (
    <div className="pp-org-switch-org-avatar" aria-hidden="true">
      {typeof background === "string" && background !== "" ? (
        <img className="pp-org-switch-org-avatar-bg" src={background} alt="" />
      ) : null}
      {letters.length > 0 ? (
        <span className="pp-org-switch-org-avatar-initials">{letters}</span>
      ) : null}
    </div>
  );
}

// use-scroll-fade: whether a column's scroll area has more content below its
// visible part, so the fade over its bottom edge shows only then and never
// covers the last row. Rechecks on scroll and whenever `items` change.
function useScrollFade(items: ReadonlyArray<unknown>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState(false);

  const recompute = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    const hasMore = node.scrollHeight - node.scrollTop - node.clientHeight > 1;
    setFade((current) => (current === hasMore ? current : hasMore));
  }, []);

  useLayoutEffect(() => {
    recompute();
  }, [items, recompute]);

  return { ref, onScroll: recompute, fade };
}

interface OrganizationItemProps {
  // nil for the "Other teams" bucket.
  organization: TeamOrganization | null;
  selectedId: string;
  currentId: string;
  onSelect: (bucketId: string) => void;
  onContextMenu: (event: React.MouseEvent, organization: TeamOrganization | null) => void;
}

// One row of OrganizationsColumn.
function OrganizationItem({
  organization,
  selectedId,
  currentId,
  onSelect,
  onContextMenu,
}: OrganizationItemProps) {
  const bucketId = organizationBucketId(organization);
  const personal = bucketId === PERSONAL_BUCKET_ID;
  const label = personal ? tr("dashboard.other-teams") : (organization?.name ?? "");

  return (
    <li
      className={
        bucketId === selectedId
          ? "pp-org-switch-item pp-org-switch-selected"
          : "pp-org-switch-item"
      }
      role="menuitem"
      data-value={bucketId}
      onClick={() => onSelect(bucketId)}
      onContextMenu={(event) => onContextMenu(event, organization)}
    >
      {personal ? (
        <span className="pp-org-switch-my-teams-icon">
          <svg
            className="pp-org-switch-my-teams-svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d={PENPOT_LOGO_PATH} />
          </svg>
        </span>
      ) : organization !== null ? (
        <OrganizationAvatar organization={organization} />
      ) : null}
      <span className="pp-org-switch-org-text-group">
        <span className="pp-org-switch-org-text" title={label}>
          {label}
        </span>
        {bucketId === currentId ? (
          <span className="pp-org-switch-tick">
            <SpriteIcon path={TICK_PATH} size={12} />
          </span>
        ) : null}
      </span>
      <span className="pp-org-switch-chevron">
        <SpriteIcon path={ARROW_RIGHT_PATH} size={12} />
      </span>
    </li>
  );
}

interface OrganizationsColumnProps {
  organizations: Array<TeamOrganization | null>;
  selectedId: string;
  currentId: string;
  hasOrganizations: boolean;
  validLicense: boolean;
  adminConsoleHref: string;
  onSelect: (bucketId: string) => void;
  onCreateOrganization: () => void;
  onAdminConsoleClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onOrganizationContextMenu: (
    event: React.MouseEvent,
    organization: TeamOrganization | null,
  ) => void;
  onDismissContextMenu: (event: React.MouseEvent) => void;
}

// organizations-column*: the left column.
function OrganizationsColumn({
  organizations,
  selectedId,
  currentId,
  hasOrganizations: includesOrganizations,
  validLicense,
  adminConsoleHref,
  onSelect,
  onCreateOrganization,
  onAdminConsoleClick,
  onOrganizationContextMenu,
  onDismissContextMenu,
}: OrganizationsColumnProps) {
  // "Other teams" is always last (see sortOrganizations). It stays out of the
  // scroll area so it sits right under a short list and sticks above the
  // actions under a long one. Its entry is a bare null, hence the filter
  // rather than looking the value up.
  const listed = organizations.filter((organization) => organization !== null);
  const hasOther = organizations.some((organization) => organization === null);

  const { ref, onScroll, fade } = useScrollFade(organizations);

  return (
    <div className="pp-org-switch-column pp-org-switch-organizations-column" role="presentation">
      <div
        className={
          fade ? "pp-org-switch-column-scroll pp-org-switch-fade" : "pp-org-switch-column-scroll"
        }
        ref={ref}
        onScroll={onScroll}
      >
        <div className="pp-org-switch-column-label">{tr("dashboard.section.organizations")}</div>

        <ul className="pp-org-switch-column-list">
          {!includesOrganizations ? (
            <li className="pp-org-switch-empty-state">
              {tr("dashboard.no-organizations-yet")}
            </li>
          ) : null}

          {listed.map((organization) => (
            <OrganizationItem
              key={organization.id}
              organization={organization}
              selectedId={selectedId}
              currentId={currentId}
              onSelect={onSelect}
              onContextMenu={onOrganizationContextMenu}
            />
          ))}
        </ul>
      </div>

      {hasOther ? (
        <ul className="pp-org-switch-column-bucket">
          <li role="separator" className="pp-org-switch-column-separator" />
          <OrganizationItem
            organization={null}
            selectedId={selectedId}
            currentId={currentId}
            onSelect={onSelect}
            onContextMenu={onOrganizationContextMenu}
          />
        </ul>
      ) : null}

      <ul className="pp-org-switch-column-actions">
        <li role="separator" className="pp-org-switch-column-separator" />

        {validLicense ? (
          <li
            className="pp-org-switch-item pp-org-switch-action pp-org-switch-with-link"
            role="menuitem"
            onContextMenu={onDismissContextMenu}
          >
            <a
              className="pp-org-switch-item-link"
              href={adminConsoleHref}
              onClick={onAdminConsoleClick}
            >
              <span className="pp-org-switch-icon-wrapper">
                <SpriteIcon path={ARROW_UP_RIGHT_PATH} size={16} />
              </span>
              <span className="pp-org-switch-org-text">
                {tr("dashboard.go-to-admin-console")}
              </span>
            </a>
          </li>
        ) : null}

        <li className="pp-org-switch-item pp-org-switch-action" role="menuitem">
          <button
            type="button"
            className="pp-org-switch-action-button"
            onClick={onCreateOrganization}
          >
            <span className="pp-org-switch-icon-wrapper">
              <SpriteIcon path={ADD_PATH} size={16} />
            </span>
            <span className="pp-org-switch-org-text">
              {tr("dashboard.create-new-organization")}
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}

interface TeamItemProps {
  team: TeamWithOrganization;
  selectedTeamId: string;
  onSelect: (event: React.MouseEvent<HTMLAnchorElement>, team: TeamWithOrganization) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

// One row of TeamsColumn.
function TeamItem({ team, selectedTeamId, onSelect, onContextMenu }: TeamItemProps) {
  const displayName = teamDisplayName(team);
  return (
    <li
      className="pp-org-switch-item pp-org-switch-with-link"
      role="menuitem"
      data-value={team.id}
      onContextMenu={onContextMenu}
    >
      <a
        className="pp-org-switch-item-link"
        href={teamHref(team)}
        onClick={(event) => onSelect(event, team)}
      >
        {team["is-default"] === true ? (
          <span className="pp-org-switch-team-personal-icon">
            <PersonalProjectsIcon />
          </span>
        ) : (
          <TeamPicture team={team} className="pp-org-switch-team-item-picture" />
        )}
        <span className="pp-org-switch-team-text-group">
          <span className="pp-org-switch-team-text" title={displayName}>
            {displayName}
          </span>
          {showSubscriptionBadge(team) ? (
            <SubscriptionBadge subscriptionType={subscriptionType(team.subscription)} />
          ) : null}
          {team.id === selectedTeamId ? (
            <span className="pp-org-switch-tick">
              <SpriteIcon path={TICK_PATH} size={12} />
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}

interface TeamsColumnProps {
  teams: TeamWithOrganization[];
  selectedTeamId: string;
  onSelect: (event: React.MouseEvent<HTMLAnchorElement>, team: TeamWithOrganization) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onCreateTeam: () => void;
  // Only present in simplified mode (no separate organizations column to
  // host it).
  onCreateOrganization?: (() => void) | null;
}

// teams-column*: the right column, or the only one in simplified mode.
function TeamsColumn({
  teams,
  selectedTeamId,
  onSelect,
  onContextMenu,
  onCreateTeam,
  onCreateOrganization,
}: TeamsColumnProps) {
  // "Personal projects" is always last (see the sort helpers). It stays out
  // of the scroll area so it sits right under a short list and sticks above
  // the actions under a long one.
  const listed = teams.filter((team) => team["is-default"] !== true);
  const personal = teams.find((team) => team["is-default"] === true) ?? null;

  const { ref, onScroll, fade } = useScrollFade(teams);

  return (
    <div className="pp-org-switch-column pp-org-switch-teams-column" role="presentation">
      <div
        className={
          fade ? "pp-org-switch-column-scroll pp-org-switch-fade" : "pp-org-switch-column-scroll"
        }
        ref={ref}
        onScroll={onScroll}
      >
        <div className="pp-org-switch-column-label">{tr("dashboard.section.teams")}</div>

        <ul className="pp-org-switch-column-list">
          {listed.map((team) => (
            <TeamItem
              key={team.id}
              team={team}
              selectedTeamId={selectedTeamId}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      </div>

      {personal !== null ? (
        <ul className="pp-org-switch-column-bucket">
          {/* Skipped when it's the only team: there's nothing above it to
              set it apart from. */}
          {listed.length > 0 ? (
            <li role="separator" className="pp-org-switch-column-separator" />
          ) : null}
          <TeamItem
            team={personal}
            selectedTeamId={selectedTeamId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
        </ul>
      ) : null}

      <ul className="pp-org-switch-column-actions">
        <li role="separator" className="pp-org-switch-column-separator" />

        <li className="pp-org-switch-item pp-org-switch-action" role="menuitem">
          <button type="button" className="pp-org-switch-action-button" onClick={onCreateTeam}>
            <span className="pp-org-switch-icon-wrapper">
              <SpriteIcon path={ADD_PATH} size={16} />
            </span>
            <span className="pp-org-switch-team-text">{tr("dashboard.create-new-team")}</span>
          </button>
        </li>

        {onCreateOrganization ? (
          <li className="pp-org-switch-item pp-org-switch-action" role="menuitem">
            <button
              type="button"
              className="pp-org-switch-action-button"
              onClick={onCreateOrganization}
            >
              <span className="pp-org-switch-icon-wrapper">
                <SpriteIcon path={ADD_PATH} size={16} />
              </span>
              <span className="pp-org-switch-team-text">
                {tr("dashboard.create-new-organization")}
              </span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

interface ContextMenuState {
  anchor: MenuAnchor;
  organization: TeamOrganization;
}

export function OrgTeamSwitch() {
  const { teams, team, refreshTeams } = useDashboard();
  const { profile } = useSession();
  const router = useRouter();
  const modal = useModal();
  const notifications = useNotifications();
  const { onLeaveOrganization } = useOrganizationLeaveFlows();

  const currentOrganization = useMemo(() => teamToOrganization(team), [team]);
  const currentOrganizationId = organizationBucketId(currentOrganization);

  // Which organization the right column previews; reset to the active one
  // every time the dropdown is (re)opened.
  const [showMenu, setShowMenu] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(currentOrganizationId);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const canLeave = canLeaveOrganization(currentOrganization, profile?.id);
  const showOptionsButton = showTeamOptionsButton(team, canLeave);

  // is-valid-license? reads the top-level :subscription the backend adds
  // under the :admin-console flag; the generated Profile type has no such
  // field, hence the cast (see lib/nitrate.ts).
  const validLicense = isValidLicense(profile as LicensedProfile | null);
  const currentTeamSubscriptionType = subscriptionType(team?.subscription);

  const organizations = useMemo(
    () => organizationsFromTeams(teams, currentOrganization),
    [teams, currentOrganization],
  );
  const includesOrganizations = hasOrganizations(organizations);
  const simplified = simplifiedMode(validLicense, includesOrganizations);

  const sortedOrganizations = useMemo(
    () => sortOrganizations(Object.values(organizations)),
    [organizations],
  );
  const allTeamsSorted = useMemo(() => sortAllTeams(teams), [teams]);
  const selectedOrganizationTeams = useMemo(
    () => teamsForOrganization(teams, selectedOrganizationId),
    [teams, selectedOrganizationId],
  );

  // "Go to admin console" targets the active team's organization (the one
  // with the tick), not the one previewed on the left column.
  const adminConsoleHref = useMemo(
    () => resolveAdminConsoleHref(currentOrganization, profile?.id),
    [currentOrganization, profile],
  );

  const line2 = closedControlLine2(includesOrganizations, currentOrganization);

  const onOpenClick = useCallback(() => {
    setSelectedOrganizationId(currentOrganizationId);
    setShowMenu((value) => !value);
  }, [currentOrganizationId]);

  const onOrganizationSelect = useCallback((bucketId: string) => {
    setSelectedOrganizationId(bucketId);
  }, []);

  // on-team-select: a plain click closes the switcher and navigates; a
  // modified click keeps the anchor's own new-tab behavior; selecting the
  // active team is a no-op beyond closing.
  const onTeamSelect = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, selectedTeam: TeamWithOrganization) => {
      if (modifiedClick(event)) return;
      event.preventDefault();
      setShowMenu(false);
      const target = teamSelectTarget(selectedTeam.id, team);
      if (target !== null) {
        router.push(dashboardHref("dashboard-recent", { teamId: target }));
      }
    },
    [team, router],
  );

  const openTeamForm = useCallback(
    (organizationId: string | null) => {
      modal.open(
        <TeamFormModal
          organizationId={organizationId}
          onToast={(message) => notifications.success(message)}
          onNoPermission={() =>
            modal.open(
              <NoPermissionModal
                permissionType="create-team"
                organizationName={currentOrganization?.name ?? null}
              />,
            )
          }
          onTeamsChanged={refreshTeams}
        />,
      );
    },
    [modal, notifications, currentOrganization, refreshTeams],
  );

  // check-and-create-team: fresh team rows first (the organization
  // permissions must be current), then the refreshed store, then the
  // team-form or the no-permission modal on the fresh target row.
  const checkAndCreateTeam = useCallback(async () => {
    const targetTeamId = createTeamTargetId(organizations, selectedOrganizationId);
    let freshTeams: TeamWithOrganization[];
    try {
      const rows = (await getTeams()) as TeamWithOrganization[];
      freshTeams = Array.isArray(rows) ? rows : [];
    } catch {
      // with-refreshed-team propagates the error and no modal opens.
      return;
    }
    await refreshTeams();
    const targetTeam =
      targetTeamId !== null ? (freshTeams.find((row) => row.id === targetTeamId) ?? null) : null;
    const organization = targetTeam?.organization ?? null;
    const inOrganization =
      hasFlag("admin-console") && organization !== null && organization !== undefined;
    const canCreate = inOrganization
      ? organizationAllowed("create-team", {
          organizationPerms: organization,
          profileId: profile?.id,
          teamPerms: targetTeam?.permissions,
        })
      : true;
    if (canCreate) {
      // The team-form modal takes the organization id (Nitrate assocs the
      // new team through it), not the default team id.
      openTeamForm(inOrganization ? organization.id : null);
    } else {
      modal.open(
        <NoPermissionModal
          permissionType="create-team"
          organizationName={currentOrganization?.name ?? null}
        />,
      );
    }
  }, [
    organizations,
    selectedOrganizationId,
    refreshTeams,
    profile,
    openTeamForm,
    modal,
    currentOrganization,
  ]);

  const onAdminConsoleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (modifiedClick(event)) return;
      event.preventDefault();
      setShowMenu(false);
      // nav-raw :href: a full page load, not an SPA navigation.
      window.location.assign(adminConsoleHref);
    },
    [adminConsoleHref],
  );

  const onCreateTeam = useCallback(() => {
    setShowMenu(false);
    if (hasFlag("admin-console")) {
      void checkAndCreateTeam();
    } else {
      openTeamForm(null);
    }
  }, [checkAndCreateTeam, openTeamForm]);

  // on-create-organization: go-to-nitrate-ac-create-organization navigates
  // away with a full page load. The CLJS handler opens the nitrate
  // subscription popup instead when there is no valid license (or the plan is
  // already unlimited); that flow arrives with F5.7b, so until then both
  // branches land on the admin-console create-organization page, which
  // registers the sign-up origin.
  const onCreateOrganization = useCallback(() => {
    setShowMenu(false);
    window.location.assign(
      adminConsoleCreateOrganizationHref("dashboard:organization-switcher"),
    );
  }, []);

  // on-organization-context-menu: the organization owner cannot leave their
  // own organization, which is the only action offered here, so right-clicking
  // an owned organization (or the personal bucket) never opens a menu; it
  // just dismisses whichever one might already be open.
  const onOrganizationContextMenu = useCallback(
    (event: React.MouseEvent, organization: TeamOrganization | null) => {
      event.stopPropagation();
      if (organization !== null && canLeaveOrganization(organization, profile?.id)) {
        event.preventDefault();
        setContextMenu({ anchor: menuAnchorFromEvent(event), organization });
      } else {
        setContextMenu(null);
      }
    },
    [profile],
  );

  // Right-clicking a row with no context menu of its own (team rows, the
  // admin-console link) still dismisses an open one.
  const onDismissContextMenu = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setContextMenu(null);
  }, []);

  // The CLJS :dropdown/open event closes every other dropdown when one opens;
  // the "..." menu reports its open so the dropdown underneath closes.
  const onOptionsOpen = useCallback(() => {
    setShowMenu(false);
  }, []);

  const onLeaveOrganizationClick = useCallback(
    (organization: TeamOrganization) => {
      setContextMenu(null);
      setShowMenu(false);
      onLeaveOrganization(organization);
    },
    [onLeaveOrganization],
  );

  // dropdown-menu* closes on a click anywhere in the document (save for the
  // rows that stop the event) and on Escape; the shell checks the mousedown
  // target against the switcher root and the portaled DashboardMenu popups.
  useEffect(() => {
    if (!showMenu) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest(".pp-menu-popup") !== null) return;
      setShowMenu(false);
      setContextMenu(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showMenu]);

  useEffect(() => {
    if (!showMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showMenu]);

  // The provider only mounts the dashboard tree on status ready, so the
  // active team exists; bail out defensively like the sidebar does.
  if (team === null) return null;

  const displayName = teamDisplayName(team);

  return (
    <div className="pp-org-switch" ref={rootRef}>
      <div className="pp-org-switch-button-row">
        <button
          type="button"
          className={
            showOptionsButton
              ? "pp-org-switch-current"
              : "pp-org-switch-current pp-org-switch-no-options"
          }
          onClick={onOpenClick}
          aria-expanded={showMenu}
          aria-haspopup="menu"
        >
          {team["is-default"] === true ? (
            <span className="pp-org-switch-personal-icon">
              <PersonalProjectsIcon />
            </span>
          ) : (
            <TeamPicture team={team} className="pp-org-switch-team-picture" />
          )}
          <span className="pp-org-switch-current-text">
            <span className="pp-org-switch-current-team-group">
              <span className="pp-org-switch-current-team-name" title={displayName}>
                {displayName}
              </span>
              {showSubscriptionBadge(team) ? (
                <SubscriptionBadge subscriptionType={currentTeamSubscriptionType} />
              ) : null}
            </span>
            {line2 !== null ? (
              <span className="pp-org-switch-current-org-name" title={line2}>
                {line2}
              </span>
            ) : null}
          </span>
        </button>

        {showOptionsButton ? <TeamOptionsButton onOpen={onOptionsOpen} /> : null}

        {showMenu ? (
          <div
            className={
              simplified
                ? "pp-org-switch-dropdown pp-org-switch-single-column"
                : "pp-org-switch-dropdown"
            }
            id="organization-team-switch"
            role="menu"
          >
            {simplified ? (
              <TeamsColumn
                teams={allTeamsSorted}
                selectedTeamId={team.id}
                onSelect={onTeamSelect}
                onContextMenu={onDismissContextMenu}
                onCreateTeam={onCreateTeam}
                onCreateOrganization={
                  showCreateOrganizationInTeamsColumn(config.flags)
                    ? onCreateOrganization
                    : null
                }
              />
            ) : (
              <>
                <OrganizationsColumn
                  organizations={sortedOrganizations}
                  selectedId={selectedOrganizationId}
                  currentId={currentOrganizationId}
                  hasOrganizations={includesOrganizations}
                  validLicense={validLicense}
                  adminConsoleHref={adminConsoleHref}
                  onSelect={onOrganizationSelect}
                  onCreateOrganization={onCreateOrganization}
                  onAdminConsoleClick={onAdminConsoleClick}
                  onOrganizationContextMenu={onOrganizationContextMenu}
                  onDismissContextMenu={onDismissContextMenu}
                />
                <TeamsColumn
                  teams={selectedOrganizationTeams}
                  selectedTeamId={team.id}
                  onSelect={onTeamSelect}
                  onContextMenu={onDismissContextMenu}
                  onCreateTeam={onCreateTeam}
                />
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Context menu for leave organization */}
      {contextMenu !== null ? (
        <DashboardMenu
          anchor={contextMenu.anchor}
          entries={[
            {
              type: "item",
              id: "leave-organization",
              label: tr("dashboard.leave-organization"),
              onSelect: () => onLeaveOrganizationClick(contextMenu.organization),
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
