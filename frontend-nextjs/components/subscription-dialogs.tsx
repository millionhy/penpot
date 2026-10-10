"use client";

// Subscription dialogs (F5.7b). Port of the five modals of
// app.main.ui.settings.subscription: the seats-management dialog
// (:management-dialog), the checkout success dialog (:subscription-success),
// the nitrate plan dialog (:nitrate-dialog, opened by show-nitrate-popup) and
// the two contact-sales dialogs.
//
// Deviations from the CLJS, documented:
// - The dialogs ride the shell's ModalShell frame (pp-modal-header with the
//   title and the close button), so the title sits in the frame header
//   instead of the in-body title of the CLJS layout (same note as
//   components/nitrate-modals.tsx).
// - The telemetry events (open/close-subscription-modal, subscription-success,
//   start-nitrate-checkout...) are not sent.
// - rt/nav-raw targets on the relative payments/... paths become absolute
//   window.location assignments (the hash-router quirk documented in
//   components/subscription.tsx).
// - go-to-buy-nitrate-license waits for ::ev/chunk-persisted (2s) before
//   navigating in the CLJS; the shell assigns window.location right away,
//   like lib/nitrate.ts.
// - The management form keeps only the fields the dialog reads: min-members
//   (number, bounded by the current editor count) and the step-2 payment
//   redirect, which the two submit buttons pass to the navigation handler
//   instead of going through a hidden form field. The submit-in-progress
//   guard is dropped: the handlers navigate synchronously.

import { useCallback, useState, type ReactNode } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { Tr } from "@/components/tr";
import { useForm } from "@/lib/forms";
import { tr } from "@/lib/i18n";
import {
  goToNitrateBillingHref,
  goToSubscriptionUrl,
  nitrateCheckoutHref,
  nitrateConnectivity,
  type NitrateConnectivity,
} from "@/lib/nitrate";
import { subscriptionName, type Subscription } from "@/lib/subscription";

// The arrow-up / arrow-down icons of ds/foundations/assets/icon (16px
// viewBox), the pair the editors toggle swaps.
const ARROW_UP_PATH = "m4 10 4-4 4 4";
const ARROW_DOWN_PATH = "m4 6 4 4 4-4";

// --- editors-section* (private to :management-dialog) ------------------------

interface EditorsSectionProps {
  editors: ReadonlyArray<{ id: string; name?: string }>;
}

// (tr "..." (c (count editors))): the plural entry picks the wording from
// the count.
function EditorsSection({ editors }: EditorsSectionProps) {
  const [showList, setShowList] = useState(false);
  return (
    <>
      <p className="pp-editors-text">
        {tr("subscription.settings.management.dialog.currently-editors-title", editors.length)}
      </p>
      <button
        type="button"
        className="pp-show-editors-button"
        onClick={() => setShowList((value) => !value)}
      >
        {tr("subscription.settings.management.dialog.editors")}
        <svg
          className="pp-icon-dropdown"
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
          <path d={showList ? ARROW_UP_PATH : ARROW_DOWN_PATH} />
        </svg>
      </button>
      {showList ? (
        <>
          <p className="pp-editors-text pp-editors-list-warning">
            {tr("subscription.settings.management.dialog.editors-explanation")}
          </p>
          <ul className="pp-editors-list">
            {editors.map((editor) => (
              <li key={editor.id} className="pp-editors-list-item">
                {"- "}
                {editor.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

// --- :management-dialog ------------------------------------------------------

export interface SubscribeManagementDialogProps {
  subscriptionType: string;
  currentSubscription: Subscription | null;
  editors?: ReadonlyArray<{ id: string; name?: string }> | null;
  subscribeToTrial: boolean;
}

export function SubscribeManagementDialog({
  subscriptionType,
  currentSubscription,
  editors,
  subscribeToTrial,
}: SubscribeManagementDialogProps) {
  const modal = useModal();
  const [step, setStep] = useState(1);
  const minEditors = editors != null && editors.length > 0 ? editors.length : 1;
  const form = useForm({
    specs: { "min-members": { type: "number", min: minEditors, max: 9999 } },
    initial: { "min-members": String(minEditors) },
  });

  const displayName = subscriptionName(subscriptionType, subscribeToTrial, tr);
  const status = currentSubscription?.status;
  const isUnpaidOrCanceled = status === "unpaid" || status === "canceled";

  // subscribe-to-unlimited: the seats land in the quantity query param and
  // the step-2 choice in `show`, padded, on the absolute payments path.
  const subscribeToUnlimited = (minMembers: number, addPaymentDetails: boolean) => {
    window.location.href =
      "/payments/subscriptions/create?type=unlimited&show=" +
      addPaymentDetails +
      "&quantity=" +
      minMembers +
      "&returnUrl=" +
      encodeURIComponent(window.location.href);
  };

  const subscribeToEnterprise = () => {
    window.location.href =
      "/payments/subscriptions/create?type=enterprise&returnUrl=" +
      encodeURIComponent(window.location.href);
  };

  const handleAccept = () => {
    window.location.href =
      "/payments/subscriptions/show?returnUrl=" + encodeURIComponent(window.location.href);
    modal.close();
  };

  const handleClose = () => {
    modal.close();
  };

  const onSubmit = (addPaymentDetails: boolean) => {
    form.touchAll();
    if (!form.valid) return;
    const minMembers = Number(form.values["min-members"]);
    if (isUnpaidOrCanceled || step === 2) {
      subscribeToUnlimited(minMembers, addPaymentDetails);
    } else {
      setStep(2);
    }
  };

  const seatsForm = subscriptionType === "unlimited" && (subscribeToTrial || isUnpaidOrCanceled);
  const showEditors = editors != null && editors.length > 0 && step !== 2;
  const showDowngrade =
    ((subscriptionType === "professional" &&
      (currentSubscription?.type === "unlimited" ||
        currentSubscription?.type === "enterprise")) ||
      (subscriptionType === "unlimited" && currentSubscription?.type === "enterprise")) &&
    !isUnpaidOrCanceled &&
    !subscribeToTrial;

  // The price of the entry reads the parsed seats like the CLJS clean-data:
  // an invalid entry falls back to $0.
  const cleanMinMembers = form.valid ? Number(form.values["min-members"]) : 0;
  const pricePerMonth = 7 * cleanMinMembers;
  const overCap = cleanMinMembers > 25;

  let footer: ReactNode;
  if (seatsForm && step === 1) {
    footer = (
      <div className="pp-modal-actions">
        <button type="button" className="pp-btn-secondary" onClick={handleClose}>
          {tr("ds.confirm-cancel")}
        </button>
        <button type="button" className="pp-btn-primary" onClick={() => onSubmit(false)}>
          {isUnpaidOrCanceled ? tr("subscription.settings.subscribe") : tr("labels.continue")}
        </button>
      </div>
    );
  } else if (seatsForm) {
    footer = (
      <div className="pp-modal-actions">
        <button type="button" className="pp-btn-secondary" onClick={() => onSubmit(false)}>
          {tr("subscription.settings.management-dialog.step-2-skip-button")}
        </button>
        <button type="button" className="pp-btn-primary" onClick={() => onSubmit(true)}>
          {tr("subscription.settings.management-dialog.step-2-add-payment-button")}
        </button>
      </div>
    );
  } else {
    footer = (
      <div className="pp-modal-actions">
        <button type="button" className="pp-btn-secondary" onClick={handleClose}>
          {tr("ds.confirm-cancel")}
        </button>
        <button
          type="button"
          className="pp-btn-primary"
          onClick={subscribeToTrial || isUnpaidOrCanceled ? subscribeToEnterprise : handleAccept}
        >
          {subscribeToTrial ? tr("subscription.settings.start-trial") : tr("labels.continue")}
        </button>
      </div>
    );
  }

  return (
    <ModalShell
      title={
        step === 2
          ? tr("subscription.settings.management-dialog.step-2-title")
          : tr("subscription.settings.management.dialog.title", displayName)
      }
      closeLabel={tr("labels.close")}
      footer={footer}
    >
      {showEditors ? <EditorsSection editors={editors} /> : null}
      {showDowngrade ? (
        <p className="pp-modal-message">
          {tr("subscription.settings.management.dialog.downgrade")}
        </p>
      ) : null}

      {seatsForm && step === 1 ? (
        <>
          <div className="pp-editors-wrapper">
            <input
              type="number"
              className="pp-field-input pp-seats-input"
              min={minEditors}
              max={9999}
              value={form.values["min-members"] as string}
              onChange={(event) => form.setValue("min-members", event.target.value)}
            />
            <div className="pp-editors-cost">
              <span className="pp-editors-cost-price">
                {overCap ? (
                  <Tr
                    k="subscription.settings.management.dialog.price-month"
                    args={["175"]}
                    className="pp-price-cap"
                  />
                ) : null}
                <Tr
                  k="subscription.settings.management.dialog.price-month"
                  args={[pricePerMonth]}
                  className={overCap ? "pp-price-strikethrough" : undefined}
                />
              </span>
              <span className="pp-editors-cost-note">
                {tr("subscription.settings.management.dialog.payment-explanation")}
              </span>
            </div>
          </div>

          {form.errors["min-members"] !== undefined ? (
            <div className="pp-field-error">
              {tr("subscription.settings.management.dialog.input-error")}
            </div>
          ) : null}

          <div className="pp-unlimited-capped-warning">
            {tr("subscription.settings.management.dialog.unlimited-capped-warning")}
          </div>
        </>
      ) : null}

      {seatsForm && step === 2 ? (
        <p className="pp-modal-message">
          {tr("subscription.settings.management-dialog.step-2-description")}
        </p>
      ) : null}
    </ModalShell>
  );
}

// --- :subscription-success ---------------------------------------------------

export interface SubscriptionSuccessDialogProps {
  subscriptionName: string;
}

export function SubscriptionSuccessDialog({ subscriptionName: name }: SubscriptionSuccessDialogProps) {
  const modal = useModal();
  // (when (not= subscription-name "professional")): the comparison runs
  // against the translated name, kept as is for parity.
  return (
    <ModalShell
      title={tr("subscription.settings.success.dialog.title", name)}
      closeLabel={tr("labels.close")}
    >
      <div className="pp-subscription-success">
        <div className="pp-subscription-success-logo">
          <img
            className="pp-subscription-logo-light"
            src="/images/logo-subscription-light.svg"
            alt=""
          />
          <img className="pp-subscription-logo-dark" src="/images/logo-subscription.svg" alt="" />
        </div>
        <div className="pp-subscription-success-body">
          {name !== "professional" ? (
            <p className="pp-subscription-success-text">
              {tr("subscription.settings.success.dialog.thanks", name)}
            </p>
          ) : null}
          <p className="pp-subscription-success-text">
            {tr("subscription.settings.success.dialog.description")}
          </p>
          <p className="pp-subscription-success-text">
            {tr("subscription.settings.success.dialog.footer")}
          </p>
          <div className="pp-subscription-success-actions">
            <button type="button" className="pp-btn-primary" onClick={modal.close}>
              {tr("labels.close")}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// --- :nitrate-dialog ---------------------------------------------------------

export interface SubscribeNitrateDialogProps {
  connectivity: NitrateConnectivity;
  // (:subscription profile): the licence object or nil; only its presence is
  // read.
  hasLicense: boolean;
}

export function SubscribeNitrateDialog({ connectivity, hasLicense }: SubscribeNitrateDialogProps) {
  const modal = useModal();
  const online = connectivity.licenses && connectivity["show-contact-sales-option"] !== true;

  // on-subscribe-click: go-to-buy-nitrate-license with the current href as the
  // success callback and the subscription screen as the error URL.
  const onSubscribe = () => {
    window.location.assign(
      nitrateCheckoutHref({
        subscription: "monthly",
        baseUrl: window.location.href,
        baseErrorUrl: goToSubscriptionUrl(),
      }),
    );
  };

  return (
    <ModalShell
      title={tr("nitrate.form.title")}
      closeLabel={tr("labels.close")}
      footer={
        online ? (
          <div className="pp-modal-actions">
            <button type="button" className="pp-btn-secondary" onClick={modal.close}>
              {tr("ds.confirm-cancel")}
            </button>
            <button type="button" className="pp-btn-primary" onClick={onSubscribe}>
              {hasLicense ? tr("subscription.settings.subscribe") : tr("nitrate.form.free-trial-button")}
            </button>
          </div>
        ) : undefined
      }
    >
      {online ? (
        <div className="pp-nitrate-subscribe">
          <p className="pp-modal-message">{tr("nitrate.form.enterprise-intro", ":")}</p>
          <div className="pp-nitrate-subscribe-price">
            <span className="pp-nitrate-subscribe-price-value">25$</span>
            {" / "}
            {tr("subscription.settings.organization-member-month")}
          </div>
          <p className="pp-modal-message">{tr("nitrate.form.enterprise-description")}</p>
        </div>
      ) : (
        <div className="pp-nitrate-subscribe pp-nitrate-subscribe-contact">
          <p className="pp-modal-message">
            {tr("nitrate.form.enterprise-intro", ".")}{" "}
            {hasLicense
              ? tr("nitrate.form.contact-us-upgrade")
              : tr("nitrate.form.contact-us-free-trial")}
          </p>
          <p className="pp-modal-message">
            <a className="pp-link" href="mailto:sales@penpot.app">
              sales@penpot.app
            </a>
          </p>
        </div>
      )}
    </ModalShell>
  );
}

// --- :nitrate-contact-sales-dialog -------------------------------------------

export interface NitrateContactSalesDialogProps {
  subscriptionType: string;
  hasBillingAccess?: boolean;
}

export function NitrateContactSalesDialog({
  subscriptionType,
  hasBillingAccess = false,
}: NitrateContactSalesDialogProps) {
  const modal = useModal();

  // handle-continue-click: leave the dialog, then go-to-nitrate-billing.
  const onContinue = () => {
    modal.close();
    window.location.assign(goToNitrateBillingHref());
  };

  // dom/open-new-window with the subject line built from the subscription
  // type.
  const onContactSales = () => {
    window.open(
      "mailto:sales@penpot.app?subject=Switch%20to%20the%20" + subscriptionType + "%20plan",
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <ModalShell
      title={tr("nitrate.contact-sales.title", subscriptionType)}
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={modal.close}>
            {tr("ds.confirm-cancel")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            onClick={hasBillingAccess ? onContinue : onContactSales}
          >
            {hasBillingAccess ? tr("labels.continue") : tr("nitrate.contact-sales.button")}
          </button>
        </div>
      }
    >
      <p className="pp-modal-message">{tr("nitrate.contact-sales.downgrade-title")}</p>
      <ul className="pp-downgrade-list">
        <li className="pp-downgrade-item">
          {tr("nitrate.contact-sales.downgrade-organization-deleted")}
        </li>
        <li className="pp-downgrade-item">
          {tr("nitrate.contact-sales.downgrade-teams-available")}
        </li>
        <li className="pp-downgrade-item">
          {tr("nitrate.contact-sales.downgrade-storage-limited")}
        </li>
      </ul>
      {hasBillingAccess ? null : (
        <div className="pp-downgrade-warning">
          {tr("nitrate.contact-sales.downgrade-contact-info")}
        </div>
      )}
    </ModalShell>
  );
}

// --- :nitrate-cancel-contact-sales-dialog ------------------------------------

export interface NitrateCancelContactSalesDialogProps {
  email?: string;
}

export function NitrateCancelContactSalesDialog({
  email,
}: NitrateCancelContactSalesDialogProps) {
  // The mailto-url of the CLJS dialog, byte for byte.
  const mailtoUrl =
    "mailto:sales@penpot.app" +
    "?subject=Request%20to%20Cancel%20Enterprise%20Subscription" +
    "&body=Hello%2C%0A%0A" +
    "I%20would%20like%20to%20cancel%20my%20Enterprise%20subscription.%0A" +
    "Account%20email%3A%20" +
    encodeURIComponent(email ?? "") +
    ".%0A%0AThank%20you.";

  const onContact = () => {
    window.open(mailtoUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <ModalShell
      title={tr("nitrate.subscription.settings.manual-cancel")}
      closeLabel={tr("labels.close")}
      footer={
        <button type="button" className="pp-btn-primary pp-btn-block" onClick={onContact}>
          {tr("labels.contact-us")}
        </button>
      }
    >
      <p className="pp-modal-message">
        {tr("nitrate.subscription.settings.manual-contact-us")}
      </p>
      <p className="pp-modal-message">
        <a className="pp-link" href="mailto:sales@penpot.app">
          sales@penpot.app
        </a>
      </p>
    </ModalShell>
  );
}

// --- show-nitrate-popup for the :nitrate-dialog type -------------------------

export interface NitrateDialogPopupOptions {
  // (:subscription profile).
  nitrateLicense?: unknown;
  "show-contact-sales-option"?: boolean;
}

// Fetch the connectivity (offline under the air-gapped-conf flag) and open
// the nitrate plan dialog, like useNitrateFormPopup: the extra options land
// on top of the connectivity, as the CLJS merge does.
export function useNitrateDialogPopup() {
  const modal = useModal();
  const notifications = useNotifications();
  return useCallback(
    (options: NitrateDialogPopupOptions = {}) => {
      void (async () => {
        try {
          const connectivity = await nitrateConnectivity();
          const merged: NitrateConnectivity = { ...connectivity };
          if (options["show-contact-sales-option"] !== undefined) {
            merged["show-contact-sales-option"] = options["show-contact-sales-option"];
          }
          modal.open(
            <SubscribeNitrateDialog
              connectivity={merged}
              hasLicense={options.nitrateLicense != null}
            />,
          );
        } catch {
          notifications.error(tr("errors.generic"));
        }
      })();
    },
    [modal, notifications],
  );
}
