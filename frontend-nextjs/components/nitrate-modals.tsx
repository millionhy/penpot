"use client";

// Nitrate dialogs (F5.7b). Port of the three app.main.ui.nitrate modals behind
// show-nitrate-popup: the enterprise plan form (nitrate-form), the
// activation-code dialog (nitrate-code-activation) and the activation success
// dialog (nitrate-activation-success).
//
// Deviations from the CLJS, documented:
// - The dialogs ride the shell's ModalShell frame (pp-modal-header with the
//   title and the close button), so the title sits in the frame header instead
//   of the in-body title of the CLJS layout.
// - The telemetry events the CLJS modals emit (open-subscription-modal,
//   close-subscription-modal, open-current-subscription) are not sent.
// - go-to-buy-nitrate-license waits for ::ev/chunk-persisted (2s) before
//   navigating the CLJS; the shell assigns window.location right away, like
//   the rest of lib/nitrate.ts.
// - The dialog keeps a busy flag so a second submit cannot race the first.

import { useCallback, useState } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { triggerDownload } from "@/lib/dom";
import { RpcError } from "@/lib/errors";
import { tr } from "@/lib/i18n";
import {
  adminConsoleCreateOrganizationHref,
  buildAdminConsoleUrl,
  getNitrateActivationCodeRequest,
  goToSubscriptionUrl,
  nitrateCheckoutHref,
  nitrateConnectivity,
  redeemNitrateActivationCode,
  type NitrateConnectivity,
} from "@/lib/nitrate";
import { useSession } from "@/lib/session";
import { formatDayMonthYear, type SubscriptionProfile } from "@/lib/subscription";

// go-to-buy-nitrate-license with the arguments nitrate-form passes: monthly
// billing, the admin console as base URL, the subscription screen as the
// error URL. The event-origin and subscription-mode arguments only fed CLJS
// telemetry.
function goToCheckout(): void {
  window.location.assign(
    nitrateCheckoutHref({
      subscription: "monthly",
      baseUrl: buildAdminConsoleUrl(""),
      baseErrorUrl: goToSubscriptionUrl(),
    }),
  );
}

// The :nitrate-code-activation modal, renew? variant included: the sidebar
// renew button opens it with renew true.
export interface NitrateCodeActivationModalProps {
  renew?: boolean;
}

export function NitrateCodeActivationModal({ renew }: NitrateCodeActivationModalProps) {
  const modal = useModal();
  const notifications = useNotifications();
  const { refresh } = useSession();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = value.trim();

  const onAccept = async () => {
    if (trimmed === "" || busy) return;
    setBusy(true);
    try {
      await redeemNitrateActivationCode(trimmed);
      if (renew === true) {
        modal.close();
        void refresh();
        notifications.success(tr("nitrate.subscription.renew-success"));
      } else {
        // The refreshed profile carries the fresh licence (cancel-at, manual)
        // the success dialog reads; the CLJS shows it and refreshes in
        // parallel.
        void refresh();
        modal.open(<NitrateActivationSuccessModal />);
      }
    } catch (err) {
      const data = err instanceof RpcError ? err.data : null;
      switch (data?.code) {
        case "expired-activation-code":
          setError(tr("nitrate.activation-code.expired-error"));
          break;
        case "used-activation-code":
          setError(tr("nitrate.activation-code.used-error"));
          break;
        default:
          setError(tr("nitrate.activation-code.invalid-error"));
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  const onDownloadRequest = async () => {
    try {
      const body = await getNitrateActivationCodeRequest();
      triggerDownload(
        "penpot-activation-code-request.txt",
        new Blob([body], { type: "text/plain" }),
      );
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  return (
    <ModalShell
      title={
        renew === true
          ? tr("nitrate.code-activation.renew-title")
          : tr("nitrate.code-activation.title")
      }
      closeLabel={tr("labels.close")}
    >
      <div className="pp-nitrate-code-activation">
        <div className="pp-nitrate-code-field">
          <label className="pp-nitrate-code-label" htmlFor="nitrate-activation-code">
            {tr("nitrate.code-activation.input-label")}
          </label>
          <textarea
            id="nitrate-activation-code"
            className={
              error === null ? "pp-nitrate-code-textarea" : "pp-nitrate-code-textarea invalid"
            }
            autoFocus
            value={value}
            placeholder={tr("nitrate.code-activation.placeholder")}
            onChange={(event) => {
              setError(null);
              setValue(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey) {
                event.preventDefault();
                void onAccept();
              }
            }}
          />
          {error !== null ? <span className="pp-nitrate-error-msg">{error}</span> : null}
        </div>

        <button
          type="button"
          className="pp-btn-primary pp-nitrate-accept"
          disabled={trimmed === "" || busy}
          onClick={() => {
            void onAccept();
          }}
        >
          {tr("nitrate.code-activation.submit")}
        </button>

        <div className="pp-nitrate-footer-text">
          <div className="pp-nitrate-code-label">{tr("nitrate.code-activation.footer-title")}</div>
          <div>
            <button
              type="button"
              className="pp-link"
              onClick={() => {
                void onDownloadRequest();
              }}
            >
              {tr("nitrate.code-activation.footer-download")}
            </button>
          </div>
          <div>
            {tr("nitrate.code-activation.footer-after")}{" "}
            <a className="pp-link" href="mailto:sales@penpot.app">
              sales@penpot.app
            </a>{" "}
            {tr("nitrate.code-activation.footer-before")}
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

// The :nitrate-activation-success modal: the Enterprise welcome after a code
// rides in. The check on the licence decides the active-until line (manual
// licences carry the cancel-at date).
export function NitrateActivationSuccessModal() {
  const { profile } = useSession();
  const { close } = useModal();
  const runtime = (profile ?? null) as SubscriptionProfile | null;
  const license = runtime?.subscription ?? null;
  const manual = license?.manual === true;
  const dateStr = formatDayMonthYear(license?.["cancel-at"]);

  const onCreateOrganization = () => {
    close();
    window.location.assign(
      adminConsoleCreateOrganizationHref("admin-console:after-payment-organization-naming-form"),
    );
  };

  return (
    <ModalShell title={tr("nitrate.modal-success.title")} closeLabel={tr("labels.close")}>
      <div className="pp-nitrate-success-content">
        <div className="pp-nitrate-success-illustration">
          <img className="pp-nitrate-logo-light" src="/images/logo-subscription-light.svg" alt="" />
          <img className="pp-nitrate-logo-dark" src="/images/logo-subscription.svg" alt="" />
        </div>
        <div className="pp-nitrate-success-body">
          {manual && dateStr !== null ? (
            <p className="pp-typ-body-large pp-nitrate-text-primary">
              {tr("nitrate.activation-success.active-until", dateStr)}
            </p>
          ) : null}
          <p className="pp-typ-body-large">{tr("nitrate.activation-success.manage-info")}</p>
          <p className="pp-typ-body-large">{tr("nitrate.activation-success.enjoy")}</p>
          <button
            type="button"
            className="pp-btn-primary pp-nitrate-success-button"
            onClick={onCreateOrganization}
          >
            {tr("nitrate.activation-success.create-organization")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// The :nitrate-form modal: the Enterprise pitch with the checkout buttons
// (online) or the contact-sales text (offline / contact-sales mode).
export interface NitrateFormModalProps {
  connectivity: NitrateConnectivity;
}

export function NitrateFormModal({ connectivity }: NitrateFormModalProps) {
  const { profile } = useSession();
  const modal = useModal();
  const runtime = (profile ?? null) as SubscriptionProfile | null;
  // (if (:subscription profile) ...): the nitrate licence on the profile
  // switches the copy from the trial wording to the upgrade wording.
  const licensed = runtime?.subscription != null;
  const online =
    connectivity.licenses && connectivity["show-contact-sales-option"] !== true;

  const openActivation = () => {
    modal.open(<NitrateCodeActivationModal />);
  };

  return (
    <ModalShell title={tr("nitrate.form.title")} closeLabel={tr("labels.close")}>
      <div className="pp-nitrate-form-content">
        <div className="pp-nitrate-form-illustration">
          <img
            className="pp-nitrate-welcome-light"
            src="/images/nitrate-welcome-light.svg"
            alt=""
          />
          <img className="pp-nitrate-welcome-dark" src="/images/nitrate-welcome.svg" alt="" />
        </div>

        <div className="pp-nitrate-form-body">
          <p className="pp-typ-body-large">{tr("nitrate.form.enterprise-intro", ":")}</p>
          <ul className="pp-nitrate-form-features">
            <li className="pp-typ-body-large">
              {"- "}
              {tr("nitrate.form.enterprise-feature-1")}
            </li>
            <li className="pp-typ-body-large">
              {"- "}
              {tr("nitrate.form.enterprise-feature-2")}
            </li>
            <li className="pp-typ-body-large">
              {"- "}
              {tr("nitrate.form.enterprise-feature-3")}
            </li>
          </ul>

          {online ? (
            <>
              <div className="pp-nitrate-form-price pp-typ-body-large">
                <span className="pp-nitrate-form-price-value">25$</span>
                {tr("nitrate.form.enterprise.price")}
              </div>

              <div className="pp-nitrate-form-buttons-section">
                <button
                  type="button"
                  className="pp-btn-primary pp-nitrate-form-button"
                  onClick={goToCheckout}
                >
                  {licensed ? tr("nitrate.form.start-enterprise") : tr("nitrate.form.try-free")}
                </button>
                <div className="pp-nitrate-form-info pp-typ-body-small">
                  {tr("nitrate.form.cancel-anytime")}
                </div>
              </div>

              <p className="pp-typ-body-medium">
                <button type="button" className="pp-link" onClick={openActivation}>
                  {tr("nitrate.form.subscribe-with-code")}
                </button>
              </p>

              <p className="pp-typ-body-medium">
                <a className="pp-link" href={goToSubscriptionUrl()} onClick={modal.close}>
                  {tr("nitrate.form.see-plan")}
                </a>
              </p>
            </>
          ) : (
            <div className="pp-nitrate-form-contact">
              <p className="pp-typ-body-large">
                {licensed ? tr("nitrate.form.contact-upgrade") : tr("nitrate.form.contact-trial")}
              </p>
              <p className="pp-typ-body-large">
                <a className="pp-link" href="mailto:sales@penpot.app">
                  sales@penpot.app
                </a>
              </p>
              <div className="pp-nitrate-form-activation-code">
                <p className="pp-typ-body-large">
                  <button type="button" className="pp-link" onClick={openActivation}>
                    {tr("nitrate.form.subscribe-with-code")}
                  </button>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// show-nitrate-popup for the :nitrate-form type: fetch the connectivity (the
// offline default under the air-gapped-conf flag) and open the form. The
// extra props land on top of the connectivity, like the CLJS merge: the
// sidebar forces the contact-sales branch for the unlimited subscription
// type.
export interface NitrateFormPopupOptions {
  "show-contact-sales-option"?: boolean;
}

export function useNitrateFormPopup() {
  const modal = useModal();
  const notifications = useNotifications();
  return useCallback(
    (options: NitrateFormPopupOptions = {}) => {
      void (async () => {
        try {
          const connectivity = await nitrateConnectivity();
          const merged: NitrateConnectivity = { ...connectivity };
          if (options["show-contact-sales-option"] !== undefined) {
            merged["show-contact-sales-option"] = options["show-contact-sales-option"];
          }
          modal.open(<NitrateFormModal connectivity={merged} />);
        } catch {
          notifications.error(tr("errors.generic"));
        }
      })();
    },
    [modal, notifications],
  );
}
