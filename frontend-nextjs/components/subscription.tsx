"use client";

// Subscription blocks of the dashboard sidebar (F5.7b). Port of the
// :subscriptions / :admin-console branches of profile-section* in
// app.main.ui.dashboard.sidebar plus the views they mount from
// app.main.ui.dashboard.subscription: the power-up CTA of the free plans, the
// growth CTA once the seat window breaks (dashboard-cta*), the nitrate
// sidebar with its three banners and the current-plan block.
//
// Deviations from the CLJS original, documented:
// - ev/event telemetry (open-subscription-modal, start-nitrate-checkout) is
//   not sent; the shell has no analytics seam yet (same note as
//   components/org-leave-flows.tsx). The account-age read of the event goes
//   with it.
// - The renewal warning hides on /settings/subscriptions, the shell path of
//   the :settings-subscription route. The dashboard sidebar renders only
//   under /dashboard, so the guard is inert for now; it stays for parity.
// - rt/nav-raw targets (the admin console, the legacy ?screen= URL) use
//   window.location.assign, like the switcher and the nitrate dialogs.
// - cta-power-up* receives its bottom description as a node: <Tr> for the
//   variants whose copy carries a |target:self link, a plain string next to
//   the button. The CLJS picks the renderer from `has-dropdown`.
// - The ds cta* frame is inlined (pp-cta) instead of importing @penpot/ui.

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useModal } from "@/components/modal";
import {
  NitrateCodeActivationModal,
  useNitrateFormPopup,
} from "@/components/nitrate-modals";
import { Tr } from "@/components/tr";
import { hasFlag } from "@/lib/config";
import { useDashboard } from "@/lib/dashboard-context";
import { tr } from "@/lib/i18n";
import {
  adminConsoleCreateOrganizationHref,
  fetchSubscriptionWarning,
  goToSubscriptionUrl,
  type SubscriptionWarning,
} from "@/lib/nitrate";
import { routePaths } from "@/lib/routes";
import { useSession } from "@/lib/session";
import {
  formatMonthDay,
  isNitrateActive,
  profileSubscriptionType,
  showSubscriptionDashboardBanner,
  subscriptionType,
  subscriptionWarningInfo,
  type SubscriptionProfile,
} from "@/lib/subscription";

// The arrow-up / arrow-down icons of ds/foundations/assets/icon (16px
// viewBox), the chevron the power-up CTA toggles.
const ARROW_UP_PATH = "m4 10 4-4 4 4";
const ARROW_DOWN_PATH = "m4 6 4 4 4-4";

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      className="pp-cta-icon"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={up ? ARROW_UP_PATH : ARROW_DOWN_PATH} />
    </svg>
  );
}

// --- cta-power-up* -----------------------------------------------------------

interface CtaPowerUpProps {
  topTitle: string;
  topDescription: string;
  bottomDescription?: ReactNode;
  bottomButton?: string;
  bottomButtonHref?: string;
  hasDropdown?: boolean;
  isHighlighted?: boolean;
}

function CtaPowerUp({
  topTitle,
  topDescription,
  bottomDescription,
  bottomButton,
  bottomButtonHref,
  hasDropdown = false,
  isHighlighted = false,
}: CtaPowerUpProps) {
  const [showData, setShowData] = useState(false);

  const onToggle = (event: MouseEvent) => {
    event.stopPropagation();
    setShowData((value) => !value);
  };

  // handle-navigation: the CLJS emits rt/nav-raw :href, a full page load for
  // the legacy ?screen= target.
  const onNavigate = (event: MouseEvent) => {
    event.stopPropagation();
    if (bottomButtonHref !== undefined) window.location.assign(bottomButtonHref);
  };

  return (
    <div
      className={isHighlighted ? "pp-cta-power-up pp-highlighted" : "pp-cta-power-up"}
      onClick={onToggle}
    >
      <button
        type="button"
        className={
          hasDropdown ? "pp-cta-top-section" : "pp-cta-top-section pp-cta-without-dropdown"
        }
      >
        <div className="pp-cta-top-content">
          <span className="pp-cta-title">{topTitle}</span>
          <span className="pp-cta-text" data-testid="subscription-name">
            {topDescription}
          </span>
        </div>
        {hasDropdown ? (
          <span className="pp-cta-icon-dropdown">
            <ChevronIcon up={showData} />
          </span>
        ) : null}
      </button>

      {hasDropdown && showData && bottomDescription !== undefined ? (
        <div className="pp-cta-bottom-section">
          <span className="pp-cta-bottom-content">{bottomDescription}</span>
        </div>
      ) : null}

      {bottomDescription !== undefined && bottomButton !== undefined ? (
        <div className="pp-cta-bottom-section">
          <span className="pp-cta-bottom-content">{bottomDescription}</span>
          <button
            type="button"
            className="pp-btn-primary pp-cta-bottom-button"
            onClick={onNavigate}
          >
            {bottomButton}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// --- dashboard-cta* ----------------------------------------------------------

// The ds cta* frame (app.main.ui.ds.product.cta) with its headline-small
// title and a message passed as children.
function DsCta({
  className,
  title,
  children,
}: {
  className: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={className + " pp-cta"} data-testid="cta">
      <div className="pp-cta-title">
        <span className="pp-cta-placeholder-title">{title}</span>
      </div>
      <div className="pp-cta-message">{children}</div>
    </div>
  );
}

export function DashboardCta({ profile }: { profile: SubscriptionProfile | null }) {
  const subscription = profile?.props?.subscription ?? null;
  const planType = subscriptionType(subscription);
  const href = goToSubscriptionUrl();
  const seats = subscription?.quantity ?? 0;
  const editors = subscription?.editors?.length ?? 0;

  // show-subscription-dashboard-banner? only lets professional and unlimited
  // plans through; the CLJS cond falls through to nil for anything else, so
  // the CTA renders nothing.
  if (planType === "professional") {
    return (
      <DsCta
        className="pp-dashboard-cta"
        title={tr("subscription.dashboard.professional-dashboard-cta-title", editors)}
      >
        <Tr
          k="subscription.dashboard.professional-dashboard-cta-upgrade-owner"
          args={[href]}
          tagName="span"
          className="pp-subscription-cta-message"
        />
      </DsCta>
    );
  }
  if (planType === "unlimited") {
    return (
      <DsCta
        className="pp-dashboard-cta"
        title={tr("subscription.dashboard.unlimited-dashboard-cta-title", seats, editors)}
      >
        <Tr
          k="subscription.dashboard.unlimited-dashboard-cta-upgrade-owner"
          args={[href]}
          tagName="span"
          className="pp-subscription-cta-message"
        />
      </DsCta>
    );
  }
  return null;
}

// --- subscription-sidebar* ---------------------------------------------------

function SubscriptionSidebar({ profile }: { profile: SubscriptionProfile | null }) {
  const subscription = profile?.props?.subscription ?? null;
  const planType = subscriptionType(subscription);
  const isTrial = subscription?.status === "trialing";
  const href = goToSubscriptionUrl();

  switch (planType) {
    case "professional":
      return (
        <CtaPowerUp
          topTitle={tr("subscription.dashboard.power-up.your-subscription")}
          topDescription={tr("subscription.dashboard.power-up.professional.top-title")}
          bottomDescription={tr(
            "subscription.dashboard.power-up.professional.bottom-description",
          )}
          bottomButton={tr("subscription.dashboard.power-up.professional.bottom-button")}
          bottomButtonHref={href}
          hasDropdown={false}
          isHighlighted
        />
      );
    case "unlimited":
      return isTrial ? (
        <CtaPowerUp
          topTitle={tr("subscription.dashboard.power-up.your-subscription")}
          topDescription={tr("subscription.dashboard.power-up.trial.top-title")}
          bottomDescription={
            <Tr
              k="subscription.dashboard.power-up.trial.bottom-description"
              args={[href]}
              tagName="span"
              className="pp-cta-bottom-content"
            />
          }
          hasDropdown
        />
      ) : (
        <CtaPowerUp
          topTitle={tr("subscription.dashboard.power-up.your-subscription")}
          topDescription={tr("subscription.dashboard.power-up.unlimited-plan")}
          bottomDescription={
            <Tr
              k="subscription.dashboard.power-up.unlimited.bottom-text"
              args={[href]}
              tagName="span"
              className="pp-cta-bottom-content"
            />
          }
          hasDropdown
        />
      );
    case "enterprise":
      return isTrial ? (
        <CtaPowerUp
          topTitle={tr("subscription.dashboard.power-up.your-subscription")}
          topDescription={tr("subscription.dashboard.power-up.enterprise-trial.top-title")}
          hasDropdown={false}
        />
      ) : (
        <CtaPowerUp
          topTitle={tr("subscription.dashboard.power-up.your-subscription")}
          topDescription={tr("subscription.dashboard.power-up.enterprise-plan")}
          hasDropdown={false}
        />
      );
    default:
      return null;
  }
}

// --- nitrate-sidebar* --------------------------------------------------------

export function NitrateSidebar({ profile }: { profile: SubscriptionProfile | null }) {
  const { teams } = useDashboard();
  const pathname = usePathname();
  const modal = useModal();
  const openNitrateForm = useNitrateFormPopup();

  const nitrateActive = isNitrateActive(profile);
  const manualLicense = profile?.subscription?.manual === true;
  const [warning, setWarning] = useState<SubscriptionWarning | null>(null);

  // The CLJS effect keys off manual-license?: fetch the warning for manual
  // licences, clear it otherwise. A failed fetch leaves the banner hidden,
  // like the rx/subs! with no error branch.
  useEffect(() => {
    if (!manualLicense) {
      setWarning(null);
      return;
    }
    let alive = true;
    fetchSubscriptionWarning()
      .then((result) => {
        if (alive) setWarning(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [manualLicense]);

  const warningInfo = subscriptionWarningInfo(warning);
  const expirationDateText =
    warningInfo === null ? null : formatMonthDay(warningInfo.expirationDate);
  const warningText =
    warningInfo === null || expirationDateText === null
      ? null
      : warningInfo.daysUntilExpiry < 0
        ? tr("subscription.dashboard.banner.subscription-expired", expirationDateText)
        : tr(
            "subscription.dashboard.banner.subscription-expire-days",
            warningInfo.daysUntilExpiry,
            expirationDateText,
          );

  const planType = profileSubscriptionType(profile);
  const teamCount = teams.length;
  const teamsLoaded = teamCount > 0;
  const noOrganizationsCreated =
    teamsLoaded && !teams.some((team) => Boolean(team.organization));

  const showWarning =
    nitrateActive &&
    manualLicense &&
    pathname !== routePaths["settings-subscription"] &&
    warningText !== null;

  // handle-click without the telemetry: open the nitrate form and force the
  // contact-sales branch for the unlimited plan type.
  const onUnlockClick = () => {
    openNitrateForm(planType === "unlimited" ? { "show-contact-sales-option": true } : {});
  };

  const onGoToCreateOrganization = () => {
    window.location.assign(
      adminConsoleCreateOrganizationHref("dashboard:first-organization-promotional-banner"),
    );
  };

  const onOpenRenewModal = () => {
    modal.open(<NitrateCodeActivationModal renew />);
  };

  return (
    <>
      {nitrateActive && teamsLoaded && noOrganizationsCreated && !showWarning ? (
        <div className="pp-nitrate-banner pp-highlighted">
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-title">
              {tr("subscription.banner.see-enterprise")}
            </span>
          </div>
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-info">
              {tr("subscription.banner.create-organization-info")}
            </span>
            <button
              type="button"
              className="pp-btn-primary pp-nitrate-bottom-button"
              onClick={onGoToCreateOrganization}
            >
              {tr("nitrate.activation-success.create-organization")}
            </button>
          </div>
        </div>
      ) : null}

      {!nitrateActive ? (
        <div className="pp-nitrate-banner pp-highlighted">
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-title">
              {tr("subscription.dashboard.banner.unlock-features")}
            </span>
          </div>
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-info">
              {tr("subscription.dashboard.banner.unlock-features-description-text")}
            </span>
            <button
              type="button"
              className="pp-btn-primary pp-nitrate-bottom-button"
              onClick={onUnlockClick}
            >
              {profile?.subscription != null
                ? tr("subscription.dashboard.banner.upgrade-nitrate")
                : tr("nitrate.form.try-free")}
            </button>
          </div>
        </div>
      ) : null}

      {showWarning ? (
        <div className="pp-nitrate-banner pp-highlighted">
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-title">
              {tr("subscription.dashboard.banner.renew-subscription")}
            </span>
          </div>
          <div className="pp-nitrate-content">
            <span className="pp-nitrate-info">{warningText}</span>
            <button
              type="button"
              className="pp-btn-primary pp-nitrate-bottom-button"
              onClick={onOpenRenewModal}
            >
              {tr("subscription.dashboard.banner.renew")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// --- nitrate-current-plan* ---------------------------------------------------

export function NitrateCurrentPlan({ profile }: { profile: SubscriptionProfile | null }) {
  const router = useRouter();
  const nitrateActive = isNitrateActive(profile);
  const license = profile?.subscription ?? null;
  const planType = profileSubscriptionType(profile);
  const active = nitrateActive ? license : (profile?.props?.subscription ?? null);
  const isTrial = active?.status === "trialing";

  // go-to-subscription: rt/nav :settings-subscription, an in-app route.
  const onGoToSubscription = () => {
    router.push(routePaths["settings-subscription"]);
  };

  let planName: string | null;
  switch (planType) {
    case "professional":
      planName = tr("subscription.current-plan.professional");
      break;
    case "unlimited":
      planName = isTrial
        ? tr("subscription.current-plan.unlimited-trial")
        : tr("subscription.current-plan.unlimited");
      break;
    case "nitrate":
      planName = isTrial
        ? tr("subscription.current-plan.nitrate-trial")
        : tr("subscription.current-plan.nitrate");
      break;
    case "enterprise":
      planName = tr("subscription.current-plan.enterprise");
      break;
    default:
      planName = null;
  }

  return (
    <div className="pp-nitrate-current-plan">
      <div className="pp-nitrate-current-plan-label">
        {tr("subscription.current-plan.title")}
      </div>
      <button
        type="button"
        className="pp-nitrate-current-plan-text"
        onClick={onGoToSubscription}
      >
        {planName}
      </button>
    </div>
  );
}

// --- the profile-section* branch ---------------------------------------------

// The subscription seam of profile-section*: under :admin-console it mounts
// the nitrate pair, under :subscriptions either the growth CTA or the
// power-up CTA. Comments-section (also profile-section*) is not ported yet.
export function SubscriptionSection() {
  const { profile } = useSession();
  const runtime = (profile ?? null) as SubscriptionProfile | null;

  if (hasFlag("admin-console")) {
    return (
      <>
        <NitrateSidebar profile={runtime} />
        <NitrateCurrentPlan profile={runtime} />
      </>
    );
  }

  if (!hasFlag("subscriptions")) return null;

  return showSubscriptionDashboardBanner(runtime) ? (
    <DashboardCta profile={runtime} />
  ) : (
    <SubscriptionSidebar profile={runtime} />
  );
}
