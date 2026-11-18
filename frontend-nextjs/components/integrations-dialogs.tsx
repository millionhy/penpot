"use client";

// The integrations dialogs (G1): create-access-token, generate-mcp-token
// and regenerate-mcp-token. All three share the same form and then swap the
// modal content to the "token created" view, like the three modals of
// app.main.ui.settings.integrations.

import { useId, useState } from "react";
import { ModalShell, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { ClipboardIcon } from "@/components/viewer-icons";
import { tr } from "@/lib/i18n";
import {
  createAccessToken,
  createTokenParams,
  expirationOptions,
  formatTokenDate,
  type AccessToken,
} from "@/lib/integrations";

export interface CopyFieldProps {
  value: string;
  successMessage: string;
  inputTestId?: string;
}

// input-copy* in the CLJS: a read-only field with the copy button pinned to
// its end.
export function CopyField({ value, successMessage, inputTestId }: CopyFieldProps) {
  const notifications = useNotifications();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(successMessage);
    } catch {
      notifications.error(tr("errors.clipboard-api-unavailable"));
    }
  };

  return (
    <div className="pp-input-copy">
      <input type="text" value={value} readOnly data-testid={inputTestId} />
      <button
        type="button"
        className="pp-input-copy-button"
        aria-label={tr("integrations.copy-to-clipboard")}
        onClick={() => {
          void copy();
        }}
      >
        <ClipboardIcon />
      </button>
    </div>
  );
}

// switch* of the ds: the CLJS control is a toggle, not a checkbox.
export interface ToggleProps {
  checked: boolean;
  label: string;
  testId?: string;
  onChange: (checked: boolean) => void;
}

export function Toggle({ checked, label, testId, onChange }: ToggleProps) {
  return (
    <div className="pp-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="pp-toggle-control"
        data-testid={testId}
        onClick={() => onChange(!checked)}
      >
        <span className="pp-toggle-thumb" aria-hidden="true" />
      </button>
      <span className="pp-toggle-label">{label}</span>
    </div>
  );
}

export interface TokenCreatedDialogProps {
  title: string;
  token: AccessToken;
  isMcp: boolean;
}

// token-created*: the key is shown once, with the copy button and the
// expiration note.
export function TokenCreatedDialog({ title, token, isMcp }: TokenCreatedDialogProps) {
  const { close } = useModal();
  const expiresAt = formatTokenDate(token["expires-at"]);

  let expiration: string;
  if (expiresAt !== null) {
    expiration = isMcp
      ? tr("integrations.mcp-key.will-expire", expiresAt)
      : tr("integrations.token.will-expire", expiresAt);
  } else {
    expiration = isMcp
      ? tr("integrations.mcp-key.will-not-expire")
      : tr("integrations.token.will-not-expire");
  }

  return (
    <ModalShell
      title={title}
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.close")}
          </button>
        </div>
      }
    >
      {isMcp ? null : (
        <div className="pp-integration-pill pp-integration-pill-info">
          {tr("integrations.token.info.non-recuperable")}
        </div>
      )}
      <CopyField
        value={token.token ?? ""}
        successMessage={
          isMcp
            ? tr("integrations.notification.success.mcp-key-copied")
            : tr("integrations.notification.success.token-copied")
        }
        inputTestId="integration-created-token"
      />
      <p className="pp-integration-secondary">{expiration}</p>
    </ModalShell>
  );
}

export interface CreateTokenDialogProps {
  title: string;
  info?: string;
  isMcp: boolean;
  onCreated: (token: AccessToken) => void;
}

// create-token*: the MCP variants skip the name field and keep only the
// expiration select; the title doubles as the submit label.
export function CreateTokenDialog({ title, info, isMcp, onCreated }: CreateTokenDialogProps) {
  const notifications = useNotifications();
  const { close } = useModal();
  const formId = useId();
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("never");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await createAccessToken(createTokenParams({ name, expiration, isMcp }));
      notifications.success(tr("integrations.notification.success.created"));
      onCreated(created);
    } catch {
      notifications.error(tr("errors.generic"));
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title={title}
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button type="button" className="pp-btn-secondary" onClick={close}>
            {tr("labels.cancel")}
          </button>
          <button type="submit" form={formId} className="pp-btn-primary" disabled={busy}>
            {title}
          </button>
        </div>
      }
    >
      <form
        id={formId}
        className="pp-integration-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {info !== undefined ? (
          <div className="pp-integration-pill pp-integration-pill-info">{info}</div>
        ) : null}

        {isMcp ? (
          <p className="pp-integration-secondary">{tr("integrations.info.mcp-server")}</p>
        ) : (
          <label className="pp-integration-field">
            <span>{tr("integrations.name.label")}</span>
            <input
              type="text"
              value={name}
              maxLength={250}
              autoFocus
              placeholder={tr("integrations.name.placeholder")}
              data-testid="integration-token-name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}

        <label className="pp-integration-field">
          <span>{tr("integrations.expiration-date.label")}</span>
          <select
            value={expiration}
            data-testid="integration-token-expiration"
            onChange={(event) => setExpiration(event.target.value)}
          >
            {expirationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {tr(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </form>
    </ModalShell>
  );
}

export interface TokenFlowProps {
  title: string;
  createdTitle: string;
  info?: string;
  isMcp: boolean;
  // Runs once the key was created, still inside the flow: the page enables
  // the MCP server for the mcp variants and refetches the token list in
  // every case (create-access-token also triggers fetch-access-tokens in
  // app.main.data.profile).
  onCreated?: (token: AccessToken) => void;
}

// The created -> form handoff the three CLJS modals implement with a local
// `created?` state.
export function TokenFlow({ title, createdTitle, info, isMcp, onCreated }: TokenFlowProps) {
  const [created, setCreated] = useState<AccessToken | null>(null);

  if (created !== null) {
    return <TokenCreatedDialog title={createdTitle} token={created} isMcp={isMcp} />;
  }

  return (
    <CreateTokenDialog
      title={title}
      info={info}
      isMcp={isMcp}
      onCreated={(token) => {
        setCreated(token);
        onCreated?.(token);
      }}
    />
  );
}
