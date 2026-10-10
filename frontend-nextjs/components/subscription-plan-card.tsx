"use client";

// The subscription plan card (F5.7b). Port of plan-card* in
// app.main.ui.settings.subscription: the header (title icon, title, the
// recommended badge, the editors count, the price and the cancel date), the
// benefits list and the CTA variants (primary button, trial link,
// more-information link, plain link, and the two activation-code actions).
//
// Deviations from the CLJS, documented:
// - The ds button and icon components are inlined (pp-btn-primary and the
//   pp-plan-* classes, inline SVG paths), like components/subscription.tsx.
// - The badge-notification renders as a plain <aside> (pp-plan-badge): the
//   card only uses the small/focus variant.
// - The :activate / :renovate code actions open the shell's
//   NitrateCodeActivationModal instead of the store-driven modal slot.

import { useModal } from "@/components/modal";
import { NitrateCodeActivationModal } from "@/components/nitrate-modals";
import { tr } from "@/lib/i18n";

// ds/foundations/assets/icon paths (16px viewBox; the "s" size renders the
// 12px graphic centered in a 16px box, which is what these paths carry).
const CHARACTER_U_PATH =
  "M4 3V8.665C4 11.2414 5.68123 13.33 8 13.33C10.3188 13.33 12 11.2414 12 8.665V3";
const CHARACTER_E_PATH =
  "M5 8.00134L9.50061 7.99869M5 8.00134V13H10.5721M5 8.00134L5.00037 3.00265L10.5721 3";
const OPEN_LINK_PATH = "M4 12l8-8zm8-8H4zm0 0v8z";

export interface PlanBenefit {
  label: string;
  description: string;
}

export interface PlanCardProps {
  cardTitle: string;
  cardTitleIcon?: "character-u" | "character-e";
  priceValue?: string;
  pricePeriod?: string;
  cancelAt?: string | null;
  benefitsTitle?: string;
  benefits: ReadonlyArray<string | PlanBenefit>;
  ctaText?: string;
  ctaLink?: () => void;
  ctaTextTrial?: string;
  ctaLinkTrial?: () => void;
  ctaTextWithIcon?: string;
  ctaLinkWithIcon?: () => void;
  codeAction?: "activate" | "renovate";
  // props.subscription.quantity of the profile.
  editors?: number | null;
  recommended?: boolean;
  currentPlan?: boolean;
  showButtonCta?: boolean;
  inlineError?: string | null;
}

export function PlanCard({
  cardTitle,
  cardTitleIcon,
  priceValue,
  pricePeriod,
  cancelAt,
  benefitsTitle,
  benefits,
  ctaText,
  ctaLink,
  ctaTextTrial,
  ctaLinkTrial,
  ctaTextWithIcon,
  ctaLinkWithIcon,
  codeAction,
  editors,
  recommended,
  currentPlan,
  showButtonCta,
  inlineError,
}: PlanCardProps) {
  const modal = useModal();

  const hasTrial = ctaTextTrial != null && ctaLinkTrial != null;
  const hasCtaWithIcon = ctaTextWithIcon != null && ctaLinkWithIcon != null;
  const hasCtaButton = ctaText != null && ctaLink != null && showButtonCta === true;
  const hasCtaLink = ctaText != null && ctaLink != null && showButtonCta !== true;

  const openActivation = () => {
    modal.open(<NitrateCodeActivationModal />);
  };

  const openRenew = () => {
    modal.open(<NitrateCodeActivationModal renew />);
  };

  let cardClass = "pp-plan-card";
  if (recommended === true) cardClass += " pp-plan-card-highlight";
  if (currentPlan === true) cardClass += " pp-plan-card-current";

  return (
    <div className={cardClass}>
      <div className="pp-plan-card-header">
        <div className="pp-plan-card-title-container">
          {cardTitleIcon !== undefined ? (
            <span className="pp-plan-title-icon">
              <svg
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
                <path d={cardTitleIcon === "character-u" ? CHARACTER_U_PATH : CHARACTER_E_PATH} />
              </svg>
            </span>
          ) : null}
          <h4 className="pp-plan-card-title">{cardTitle}</h4>
          {recommended === true ? (
            <aside className="pp-plan-badge">{tr("subscription.settings.recommended")}</aside>
          ) : null}
          {editors != null ? (
            <span className="pp-plan-editors">{tr("subscription.settings.editors", editors)}</span>
          ) : null}
        </div>
        {priceValue != null && pricePeriod != null ? (
          <div className="pp-plan-price">
            <span className="pp-plan-price-value">{priceValue}</span>
            <span className="pp-plan-price-period">{" / "}{pricePeriod}</span>
          </div>
        ) : null}
        {cancelAt != null ? (
          <div className="pp-plan-cancel">
            <span className="pp-plan-cancel-date">{cancelAt}</span>
          </div>
        ) : null}
      </div>

      {benefitsTitle !== undefined ? (
        <h5 className="pp-plan-benefits-title">{benefitsTitle}</h5>
      ) : null}
      <ul className="pp-plan-benefits-list">
        {benefits.map((benefit, index) => (
          <li key={index} className="pp-plan-benefit">
            {typeof benefit === "string" ? (
              benefit
            ) : (
              <>
                <span className="pp-plan-benefit-label">{benefit.label}</span> {benefit.description}
              </>
            )}
          </li>
        ))}
      </ul>

      {hasCtaButton ? (
        <button
          type="button"
          className={
            hasTrial ? "pp-btn-primary" : "pp-btn-primary pp-plan-card-bottom-button"
          }
          onClick={ctaLink}
        >
          {ctaText}
        </button>
      ) : null}

      {hasTrial ? (
        <button
          type="button"
          className="pp-cta-button pp-plan-card-bottom-link"
          onClick={ctaLinkTrial}
        >
          {ctaTextTrial}
        </button>
      ) : null}

      {hasCtaWithIcon ? (
        <button
          type="button"
          className="pp-cta-button pp-plan-card-more-info"
          onClick={ctaLinkWithIcon}
        >
          {ctaTextWithIcon}
          <svg
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
            <path d={OPEN_LINK_PATH} />
          </svg>
        </button>
      ) : null}

      {hasCtaLink ? (
        <button
          type="button"
          className={
            hasTrial || codeAction !== undefined
              ? "pp-cta-button"
              : "pp-cta-button pp-plan-card-bottom-link"
          }
          onClick={ctaLink}
        >
          {ctaText}
        </button>
      ) : null}

      {codeAction === "activate" ? (
        <button
          type="button"
          className="pp-cta-button pp-plan-card-activate"
          onClick={openActivation}
        >
          {tr("subscription.settings.activate-by-code")}
        </button>
      ) : null}
      {codeAction === "renovate" ? (
        <button
          type="button"
          className="pp-btn-primary pp-plan-card-renew pp-plan-card-bottom-link"
          onClick={openRenew}
        >
          {tr("nitrate.subscription.settings.renew-with-code")}
        </button>
      ) : null}

      {inlineError != null ? <p className="pp-plan-inline-error">{inlineError}</p> : null}
    </div>
  );
}
