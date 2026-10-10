"use client";

// Settings / subscription (F5.7b). Port of subscription-page* in
// app.main.ui.settings.subscription: the current plan card (the nitrate
// branch or the SaaS professional/unlimited/enterprise variants), the two
// membership lines, the four "other plans" cards, and the query-parameter
// handshake that opens the management/success dialogs and surfaces the
// nitrate checkout toast or the inline start error.
//
// Deviations from the CLJS, documented:
// - The telemetry events (ev/event) are not sent, like the other migrated
//   slices; only the navigation side of each click is kept.
// - The SPA-exiting navigations (payments, pricing, admin console) use the
//   shell's absolute paths; the CLJS resolves its relative hrefs against the
//   root query-string URL (nav-raw assigns location.href).
// - The CLJS `case` over subscription-type has no default branch; an unknown
//   type renders no plan card here instead of raising.
// - cf/saas? reads config.isSaas, resolved from the environment.

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useModal } from "@/components/modal";
import { NitrateActivationSuccessModal } from "@/components/nitrate-modals";
import { useNotifications } from "@/components/notifications";
import { QueryParams } from "@/components/query-params";
import { PlanCard } from "@/components/subscription-plan-card";
import {
  NitrateCancelContactSalesDialog,
  NitrateContactSalesDialog,
  SubscribeManagementDialog,
  SubscriptionSuccessDialog,
  useNitrateDialogPopup,
} from "@/components/subscription-dialogs";
import { config, hasFlag } from "@/lib/config";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import {
  buildAdminConsoleHref,
  goToNitrateBillingHref,
  nitrateCheckoutCancelledToken,
  nitrateCheckoutErrorToken,
  nitrateCheckoutFinishErrorToken,
  nitrateConnectivity,
  type NitrateConnectivity,
} from "@/lib/nitrate";
import { routePaths } from "@/lib/routes";
import {
  formatDayMonthYear,
  isNitrateActive,
  profileSubscriptionType,
  type Subscription,
  type SubscriptionProfile,
} from "@/lib/subscription";
import { useSession } from "@/lib/session";

// The crown and user membership icons (16px-viewBox sprite paths from
// resources/images/icons; the CLJS renders them through icon* at size "m").
const CROWN_PATH =
  "M8 1.8a.35.35 0 0 0-.3.18l-2.08 3.9a.7.7 0 0 1-1.06.21l-3-2.55a.35.35 0 0 0-.55.36l1.98 7.15a.7.7 0 0 0 .67.5h8.68a.7.7 0 0 0 .67-.5l1.98-7.15a.35.35 0 0 0-.56-.36l-3 2.55a.7.7 0 0 1-1.06-.2L8.31 1.98A.35.35 0 0 0 8 1.8ZM3.1 14.35h9.8z";
const USER_PATH =
  "M13.333 14v-1.333A2.667 2.667 0 0010.667 10H5.333a2.667 2.667 0 00-2.666 2.667V14M8 7.333A2.667 2.667 0 108 2a2.667 2.667 0 000 5.333z";

function MembershipIcon({ path, className }: { path: string; className: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
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

// plan-card* benefits: the SaaS/selfhost professional copy and the three
// unlimited and enterprise lists the page repeats across cards.
function professionalBenefits(): string[] {
  return config.isSaas
    ? [
        tr("subscription.settings.professional.storage-benefit"),
        tr("subscription.settings.professional.autosave-benefit"),
        tr("subscription.settings.professional.teams-editors-benefit"),
      ]
    : [
        tr("subscription.settings.professional.selfhost.control-over-data"),
        tr("subscription.settings.professional.selfhost.unlimited-users"),
        tr("subscription.settings.professional.selfhost.community-support"),
      ];
}

function unlimitedBenefits(): string[] {
  return [
    tr("subscription.settings.unlimited.storage-benefit"),
    tr("subscription.settings.unlimited.autosave-benefit"),
    tr("subscription.settings.unlimited.bill"),
  ];
}

function enterpriseBenefits(): string[] {
  return [
    tr("subscription.settings.enterprise.unlimited-storage-benefit"),
    tr("subscription.settings.enterprise.autosave"),
    tr("subscription.settings.enterprise.capped-bill"),
  ];
}

function nitrateBenefits(): Array<{ label: string; description: string }> {
  return [
    {
      label: tr("subscription.settings.enterprise.nitrate.multi-organization-management"),
      description: tr("subscription.settings.enterprise.nitrate.support-team"),
    },
    {
      label: tr("subscription.settings.enterprise.nitrate.enterprise-security"),
      description: tr("subscription.settings.enterprise.nitrate.native-sso"),
    },
    {
      label: tr("subscription.settings.enterprise.nitrate.advanced-control"),
      description: tr("subscription.settings.enterprise.nitrate.plugin-whitelisting"),
    },
  ];
}

function SubscriptionPageContent({ params }: { params: URLSearchParams }) {
  const router = useRouter();
  const modal = useModal();
  const notifications = useNotifications();
  const { status, profile } = useSession();
  const openNitrateDialog = useNitrateDialogPopup();

  const subscriptionProfile = profile as SubscriptionProfile | null;
  const [nitrateStartError, setNitrateStartError] = useState(false);
  const [connectivity, setConnectivity] = useState<NitrateConnectivity | null>(null);

  useDocumentTitle(tr("subscription.labels"));

  const nitrateLicense = subscriptionProfile?.subscription ?? null;
  const nitrate = isNitrateActive(subscriptionProfile);
  const subscription = subscriptionProfile?.props?.subscription ?? null;
  const editors = subscription?.editors ?? null;

  const paramsSubscription = params.get("subscription");
  const showTrialSubscriptionModal =
    paramsSubscription === "subscription-to-penpot-unlimited" ||
    paramsSubscription === "subscription-to-penpot-enterprise";
  const showSubscriptionSuccessModal =
    paramsSubscription === "subscribed-to-penpot-unlimited" ||
    paramsSubscription === "subscribed-to-penpot-enterprise" ||
    paramsSubscription === "subscribed-to-penpot-nitrate";
  const nitrateToastMessage =
    paramsSubscription === nitrateCheckoutFinishErrorToken
      ? tr("subscription.error.nitrate.checkout-failed")
      : paramsSubscription === nitrateCheckoutCancelledToken
        ? tr("subscription.error.nitrate.checkout-cancelled")
        : null;
  const showNitrateStartError = paramsSubscription === nitrateCheckoutErrorToken;
  const successModalIsTrial = params.get("trial");

  const subscriptionTypeValue = profileSubscriptionType(subscriptionProfile);
  const subscriptionIsTrial = subscription?.status === "trialing";
  const memberSince = formatDayMonthYear(subscriptionProfile?.["created-at"]);
  const subscribedSince = nitrate
    ? formatDayMonthYear(nitrateLicense?.["created-at"])
    : formatDayMonthYear(subscription?.["start-date"]);

  // get-subscription-name as the membership line uses it: the licence name
  // first, then the SaaS type.
  const subscriptionNameText = nitrate
    ? tr("subscription.settings.enterprise")
    : subscriptionTypeValue === "unlimited"
      ? tr("subscription.settings.unlimited")
      : subscriptionTypeValue === "enterprise"
        ? tr("subscription.settings.enterprise")
        : null;

  // (and (:licenses connectivity) (not (:manual nitrate-license))).
  const hasLicenseBilling = connectivity?.licenses === true && nitrateLicense?.manual !== true;

  const goToPricingPage = () => {
    window.open("https://penpot.app/pricing", "_blank", "noopener,noreferrer");
  };

  // go-to-payments: the payments screen returns to the current href afterwards.
  const goToPayments = () => {
    window.location.href =
      "/payments/subscriptions/show?returnUrl=" + encodeURIComponent(window.location.href);
  };

  const goToNitratePayments = () => {
    window.location.assign(goToNitrateBillingHref());
  };

  const goToNitrateAc = () => {
    window.location.assign(buildAdminConsoleHref());
  };

  const openSubscriptionModal = (
    dialogType: string,
    currentSubscription: Subscription | null,
  ) => {
    if (dialogType === "nitrate") {
      openNitrateDialog({ nitrateLicense });
      return;
    }
    modal.open(
      <SubscribeManagementDialog
        subscriptionType={dialogType}
        currentSubscription={currentSubscription}
        editors={editors}
        subscribeToTrial={!subscription?.type}
      />,
    );
  };

  const openContactSalesModal = (
    currentSubscription: string,
    dialogType: string,
    hasBillingAccess?: boolean,
  ) => {
    if (currentSubscription === "unlimited") {
      openNitrateDialog({ nitrateLicense, "show-contact-sales-option": true });
      return;
    }
    modal.open(
      <NitrateContactSalesDialog
        subscriptionType={dialogType}
        hasBillingAccess={hasBillingAccess}
      />,
    );
  };

  const openCancelContactSalesModal = () => {
    modal.open(<NitrateCancelContactSalesDialog email={subscriptionProfile?.email} />);
  };

  // Fetch the connectivity once a licence is active (with-effect [nitrate?]);
  // a failed fetch leaves it nil, like the handler-less CLJS subscription.
  useEffect(() => {
    if (!nitrate) return;
    void (async () => {
      try {
        setConnectivity(await nitrateConnectivity());
      } catch {
        // Ignored on purpose, see above.
      }
    })();
  }, [nitrate]);

  // The query-parameter handshake: the checkout toast, the inline start
  // error, the trial and success dialogs, each followed by a replace that
  // clears the params.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (showNitrateStartError) setNitrateStartError(true);
    if (nitrateToastMessage !== null) {
      notifications.show({
        level: paramsSubscription === nitrateCheckoutCancelledToken ? "info" : "error",
        content: nitrateToastMessage,
        timeout: 7000,
      });
      router.replace(routePaths["settings-subscription"]);
      return;
    }
    if (showNitrateStartError) {
      router.replace(routePaths["settings-subscription"]);
      return;
    }
    if (showTrialSubscriptionModal) {
      modal.open(
        <SubscribeManagementDialog
          subscriptionType={
            paramsSubscription === "subscription-to-penpot-unlimited" ? "unlimited" : "enterprise"
          }
          currentSubscription={subscription}
          editors={editors}
          subscribeToTrial={!subscription?.type}
        />,
      );
      router.replace(routePaths["settings-subscription"]);
      return;
    }
    if (showSubscriptionSuccessModal) {
      if (paramsSubscription === "subscribed-to-penpot-nitrate") {
        modal.open(<NitrateActivationSuccessModal />);
      } else {
        const successName =
          paramsSubscription === "subscribed-to-penpot-unlimited"
            ? successModalIsTrial === "true"
              ? tr("subscription.settings.unlimited-trial")
              : tr("subscription.settings.unlimited")
            : successModalIsTrial === "true"
              ? tr("subscription.settings.enterprise-trial")
              : tr("subscription.settings.enterprise");
        modal.open(<SubscriptionSuccessDialog subscriptionName={successName} />);
      }
      router.replace(routePaths["settings-subscription"]);
    }
    // The CLJS with-effect depends on the query values, not the helpers; the
    // dialogs and navigations are stable for a mounted page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status,
    nitrateToastMessage,
    showNitrateStartError,
    showTrialSubscriptionModal,
    showSubscriptionSuccessModal,
    successModalIsTrial,
    subscription,
    editors,
  ]);

  // The current-plan card: nitrate first, then the SaaS type branches.
  let currentPlan: ReactNode = null;
  if (nitrate) {
    currentPlan = (
      <PlanCard
        cardTitle={tr("subscription.settings.enterprise")}
        cancelAt={
          nitrateLicense?.["cancel-at"] != null
            ? tr(
                "nitrate.subscription.active-until",
                formatDayMonthYear(nitrateLicense["cancel-at"]),
              )
            : undefined
        }
        benefitsTitle={tr("subscription.settings.benefits.nitrate-unlimited-benefits")}
        benefits={nitrateBenefits()}
        ctaTextWithIcon={
          nitrateLicense?.manual !== true ? tr("subscription.settings.admin-console") : undefined
        }
        ctaLinkWithIcon={nitrateLicense?.manual !== true ? goToNitrateAc : undefined}
        ctaText={
          hasLicenseBilling
            ? tr("subscription.settings.manage-your-subscription")
            : tr("nitrate.subscription.settings.manual-cancel")
        }
        ctaLink={hasLicenseBilling ? goToNitratePayments : openCancelContactSalesModal}
        codeAction={nitrateLicense?.manual === true ? "renovate" : undefined}
        currentPlan
      />
    );
  } else if (subscriptionTypeValue === "professional") {
    currentPlan = (
      <PlanCard
        cardTitle={tr("subscription.settings.professional")}
        benefits={professionalBenefits()}
        currentPlan
      />
    );
  } else if (subscriptionTypeValue === "unlimited") {
    currentPlan = subscriptionIsTrial ? (
      <PlanCard
        cardTitle={tr("subscription.settings.unlimited-trial")}
        cardTitleIcon="character-u"
        benefitsTitle={tr("subscription.settings.benefits.all-professional-benefits")}
        benefits={unlimitedBenefits()}
        ctaText={tr("subscription.settings.manage-your-subscription")}
        ctaLink={goToPayments}
        ctaTextTrial={tr("subscription.settings.add-payment-to-continue")}
        ctaLinkTrial={goToPayments}
        editors={subscription?.quantity}
        currentPlan
      />
    ) : (
      <PlanCard
        cardTitle={tr("subscription.settings.unlimited")}
        cardTitleIcon="character-u"
        benefitsTitle={tr("subscription.settings.benefits.all-unlimited-benefits")}
        benefits={unlimitedBenefits()}
        ctaText={tr("subscription.settings.manage-your-subscription")}
        ctaLink={goToPayments}
        editors={subscription?.quantity}
        currentPlan
      />
    );
  } else if (subscriptionTypeValue === "enterprise") {
    currentPlan = subscriptionIsTrial ? (
      <PlanCard
        cardTitle={tr("subscription.settings.enterprise-trial")}
        cardTitleIcon="character-e"
        benefitsTitle={tr("subscription.settings.benefits.all-unlimited-benefits")}
        benefits={enterpriseBenefits()}
        ctaText={tr("subscription.settings.manage-your-subscription")}
        ctaLink={goToPayments}
        ctaTextTrial={tr("subscription.settings.add-payment-to-continue")}
        ctaLinkTrial={goToPayments}
        currentPlan
      />
    ) : (
      <PlanCard
        cardTitle={tr("subscription.settings.enterprise")}
        cardTitleIcon="character-e"
        benefitsTitle={tr("subscription.settings.benefits.all-unlimited-benefits")}
        benefits={enterpriseBenefits()}
        ctaText={tr("subscription.settings.manage-your-subscription")}
        ctaLink={goToPayments}
        currentPlan
      />
    );
  }

  return (
    <section className="pp-dashboard-settings" aria-labelledby="subscription-section-title">
      <div className="pp-subscription-content">
        <h2 id="subscription-section-title" className="pp-title-section">
          {tr("subscription.labels")}
        </h2>

        <div className="pp-your-subscription">
          <h3 className="pp-plan-section-title">{tr("subscription.settings.section-plan")}</h3>
          {currentPlan}
        </div>

        <div className="pp-membership-container">
          {nitrate || (subscribedSince !== null && subscriptionTypeValue !== "professional") ? (
            <div className="pp-membership">
              <MembershipIcon path={CROWN_PATH} className="pp-subscription-member" />
              <span className="pp-membership-date">
                {tr(
                  "subscription.settings.subscribed-since",
                  subscriptionNameText,
                  subscribedSince,
                )}
              </span>
            </div>
          ) : null}

          <div className="pp-membership">
            <MembershipIcon path={USER_PATH} className="pp-penpot-member" />
            <span className="pp-membership-date">
              {tr("subscription.settings.member-since", memberSince)}
            </span>
          </div>
        </div>

        <div className="pp-other-subscriptions">
          <h3 className="pp-plan-section-title">{tr("subscription.settings.other-plans")}</h3>

          {subscriptionTypeValue !== "professional" ? (
            <PlanCard
              cardTitle={tr("subscription.settings.professional")}
              priceValue="$0"
              pricePeriod={tr("subscription.settings.price-user-month")}
              benefits={professionalBenefits()}
              ctaText={tr("subscription.settings.subscribe")}
              ctaLink={
                hasFlag("admin-console") && nitrate
                  ? () =>
                      openContactSalesModal(subscriptionTypeValue, "Professional", hasLicenseBilling)
                  : goToPayments
              }
              ctaTextWithIcon={tr("subscription.settings.more-information")}
              ctaLinkWithIcon={goToPricingPage}
              currentPlan={false}
            />
          ) : null}

          {subscriptionTypeValue !== "unlimited" && config.isSaas ? (
            <PlanCard
              cardTitle={tr("subscription.settings.unlimited")}
              cardTitleIcon="character-u"
              priceValue="$7"
              pricePeriod={tr("subscription.settings.price-user-month")}
              benefitsTitle={tr("subscription.settings.benefits.all-professional-benefits")}
              benefits={unlimitedBenefits()}
              ctaText={
                subscription?.type
                  ? tr("subscription.settings.subscribe")
                  : tr("subscription.settings.try-it-free")
              }
              ctaLink={
                hasFlag("admin-console") && nitrate
                  ? () => openContactSalesModal(subscriptionTypeValue, "Unlimited")
                  : () => openSubscriptionModal("unlimited", subscription)
              }
              ctaTextWithIcon={tr("subscription.settings.more-information")}
              ctaLinkWithIcon={goToPricingPage}
              showButtonCta={subscriptionTypeValue === "professional"}
              currentPlan={false}
            />
          ) : null}

          {subscriptionTypeValue !== "enterprise" && config.isSaas && !hasFlag("admin-console") ? (
            <PlanCard
              cardTitle={tr("subscription.settings.enterprise")}
              cardTitleIcon="character-e"
              priceValue="$950"
              pricePeriod={tr("subscription.settings.price-organization-month")}
              benefitsTitle={tr("subscription.settings.benefits.all-unlimited-benefits")}
              benefits={enterpriseBenefits()}
              ctaText={
                subscription?.type
                  ? tr("subscription.settings.subscribe")
                  : tr("subscription.settings.try-it-free")
              }
              ctaLink={() => openSubscriptionModal("enterprise", subscription)}
              ctaTextWithIcon={tr("subscription.settings.more-information")}
              ctaLinkWithIcon={goToPricingPage}
              showButtonCta={subscriptionTypeValue === "professional"}
              currentPlan={false}
            />
          ) : null}

          {hasFlag("admin-console") && !nitrate ? (
            <PlanCard
              cardTitle={tr("subscription.settings.enterprise")}
              priceValue="$25"
              pricePeriod={tr("subscription.settings.organization-member-month")}
              benefitsTitle={tr("subscription.settings.benefits.nitrate-unlimited-benefits")}
              benefits={nitrateBenefits()}
              ctaText={
                nitrateLicense
                  ? tr("subscription.settings.subscribe")
                  : tr("nitrate.form.free-trial-button")
              }
              ctaLink={
                subscriptionTypeValue === "unlimited"
                  ? () =>
                      openContactSalesModal(
                        subscriptionTypeValue,
                        tr("subscription.current-plan.nitrate"),
                      )
                  : () => openSubscriptionModal("nitrate", subscription)
              }
              ctaTextWithIcon={tr("subscription.settings.more-information")}
              ctaLinkWithIcon={goToPricingPage}
              codeAction="activate"
              recommended={subscriptionTypeValue === "professional"}
              showButtonCta={!nitrateLicense}
              currentPlan={false}
              inlineError={
                nitrateStartError ? tr("subscription.error.nitrate.checkout-failed") : null
              }
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default function SettingsSubscriptionPage() {
  return <QueryParams>{(params) => <SubscriptionPageContent params={params} />}</QueryParams>;
}
