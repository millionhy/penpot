"use client";

// Settings / integrations (G1). Port of app.main.ui.settings.integrations:
// the flag-gated MCP server section (status toggle, key list, server URL)
// and the personal access token section. Headless logic lives in
// lib/integrations.ts; the dialogs in components/integrations-dialogs.tsx.
//
// Deviations from the CLJS, documented:
// - The telemetry events (ev/event) and the broadcast channel calls
//   (mbc/event) are not sent, like the other migrated slices; the profile
//   prop and the command calls are kept.
// - fetch-access-tokens has no error branch in app.main.data.profile (the
//   global handler reports it); the page shows the generic toast instead
//   of leaving the list loading forever.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CopyField,
  TokenFlow,
  Toggle,
} from "@/components/integrations-dialogs";
import { TokenItem } from "@/components/integrations-token-item";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { OpenLinkIcon, InfoIcon } from "@/components/settings-icons";
import { config, hasFlag } from "@/lib/config";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import {
  deleteAccessToken,
  fetchAccessTokens,
  findMcpToken,
  isMcpToken,
  mcpEnabled,
  mcpHelpCenterUri,
  mcpServerUrl,
  tokenValid,
  userTokens,
  type AccessToken,
} from "@/lib/integrations";
import { useSession } from "@/lib/session";
import { updateProfileProps, type RuntimeProfile } from "@/lib/settings";

type TokenFlowKind = "access-token" | "generate-mcp" | "regenerate-mcp";

export default function SettingsIntegrationsPage() {
  const { profile, refresh } = useSession();
  const runtime = profile as RuntimeProfile | null;
  const notifications = useNotifications();
  const modal = useModal();
  useDocumentTitle(tr("title.settings.integrations"));

  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      setTokens(await fetchAccessTokens());
    } catch {
      notifications.error(tr("errors.generic"));
    }
  }, [notifications]);

  // fetch-access-tokens runs once on mount, like the with-effect of
  // integrations-page*. The guard keeps the toast-triggered re-renders of
  // the notifications context from refetching.
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  const mcpOn = hasFlag("mcp");
  const tokensOn = hasFlag("access-tokens");

  const mcpToken = findMcpToken(tokens);
  const validMcp = tokenValid(mcpToken);
  // show-enabled? = (and enabled? token-valid?): the toggle only reads as
  // enabled when the profile flag and a live key agree.
  const showEnabled = mcpEnabled(runtime) && validMcp;
  const serverUrl =
    mcpToken?.token !== undefined ? mcpServerUrl(config.publicUri, mcpToken.token) : null;

  const setMcpSwitch = async (value: boolean) => {
    try {
      await updateProfileProps({ "mcp-enabled": value });
      await refresh();
      notifications.success(
        value
          ? tr("integrations.notification.success.mcp-server-enabled")
          : tr("integrations.notification.success.mcp-server-disabled"),
      );
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  // The MCP flows enable the server when the key is created, without the
  // extra "enabled" toast the manual toggle shows (the created toast covers
  // it, like the CLJS on-created handlers).
  const enableMcp = async () => {
    try {
      await updateProfileProps({ "mcp-enabled": true });
      await refresh();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  // The keys stay in static call sites so the translation extractor can see
  // them; a key kept in a data table would never reach the generated
  // catalogs.
  const openTokenFlow = (kind: TokenFlowKind) => {
    const isMcp = kind !== "access-token";
    let title: string;
    let createdTitle: string;
    let info: string | undefined;
    if (kind === "access-token") {
      title = tr("integrations.create-access-token.title");
      createdTitle = tr("integrations.create-access-token.title.created");
    } else if (kind === "generate-mcp") {
      title = tr("integrations.generate-mcp-key.title");
      createdTitle = tr("integrations.generate-mcp-key.title.created");
    } else {
      title = tr("integrations.regenerate-mcp-key.title");
      createdTitle = tr("integrations.regenerate-mcp-key.title.created");
      info = tr("integrations.regenerate-mcp-key.info");
    }
    modal.open(
      <TokenFlow
        title={title}
        createdTitle={createdTitle}
        info={info}
        isMcp={isMcp}
        onCreated={() => {
          if (isMcp) void enableMcp();
          void load();
        }}
      />,
    );
  };

  const deleteToken = async (token: AccessToken) => {
    try {
      await deleteAccessToken(token.id);
      // The MCP delete handler also disables the server, since the key the
      // client configuration points at is gone.
      if (isMcpToken(token)) {
        await updateProfileProps({ "mcp-enabled": false });
        await refresh();
      }
      await load();
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const confirmDelete = (token: AccessToken) => {
    modal.open(
      <ConfirmDialog
        title={tr("integrations.delete-token.title")}
        message={tr("integrations.delete-token.message")}
        acceptLabel={tr("integrations.delete-token.accept")}
        cancelLabel={tr("labels.cancel")}
        destructive
        onAccept={() => {
          void deleteToken(token);
        }}
      />,
    );
  };

  const personalTokens = userTokens(tokens);

  return (
    <section
      className="pp-integrations"
      aria-labelledby="integrations-section-title"
      data-testid="Settings-integrations"
    >
      <h2 id="integrations-section-title" className="pp-integrations-title">
        {tr("integrations.title")}
      </h2>

      {mcpOn ? (
        <section className="pp-mcp-server-section" aria-labelledby="mcp-server-title">
          <div className="pp-mcp-server-heading">
            <h2 id="mcp-server-title">{tr("integrations.mcp-server.title")}</h2>
            <span className="pp-badge">{tr("integrations.mcp-server.title.beta")}</span>
          </div>

          <p className="pp-integration-secondary">{tr("integrations.mcp-server.description")}</p>

          <div className="pp-mcp-server-status">
            <h3>{tr("integrations.mcp-server.status")}</h3>

            <div className="pp-mcp-server-block">
              {mcpToken !== null && !validMcp ? (
                <div className="pp-integration-pill pp-integration-pill-error" role="status">
                  <p>{tr("integrations.mcp-server.status.expired.0")}</p>
                  <p>{tr("integrations.mcp-server.status.expired.1")}</p>
                </div>
              ) : null}

              <div className="pp-mcp-server-switch">
                <Toggle
                  checked={showEnabled}
                  label={
                    showEnabled
                      ? tr("integrations.mcp-server.status.enabled")
                      : tr("integrations.mcp-server.status.disabled")
                  }
                  testId="mcp-server-switch"
                  onChange={(value) => {
                    void setMcpSwitch(value);
                  }}
                />
                {mcpToken === null ? (
                  <button
                    type="button"
                    className="pp-mcp-server-switch-cover"
                    aria-label={tr("integrations.generate-mcp-key.title")}
                    data-testid="mcp-server-generate-cover"
                    onClick={() => openTokenFlow("generate-mcp")}
                  />
                ) : null}
                {mcpToken !== null && !validMcp ? (
                  <button
                    type="button"
                    className="pp-mcp-server-switch-cover"
                    aria-label={tr("integrations.regenerate-mcp-key.title")}
                    data-testid="mcp-server-regenerate-cover"
                    onClick={() => openTokenFlow("regenerate-mcp")}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {mcpToken !== null ? (
            <div className="pp-mcp-server-key">
              <h3>{tr("integrations.mcp-server.mcp-keys.title")}</h3>

              <div className="pp-mcp-server-block">
                <div className="pp-mcp-server-regenerate">
                  <button
                    type="button"
                    className="pp-btn-primary"
                    data-testid="mcp-server-regenerate"
                    onClick={() => openTokenFlow("regenerate-mcp")}
                  >
                    {tr("integrations.mcp-server.mcp-keys.regenerate")}
                  </button>
                  <span
                    className="pp-integration-info"
                    title={tr("integrations.mcp-server.mcp-keys.tootip")}
                  >
                    <InfoIcon />
                  </span>
                </div>

                <div className="pp-token-list">
                  <TokenItem token={mcpToken} onDelete={confirmDelete} />
                </div>
              </div>
            </div>
          ) : null}

          <div className="pp-integration-pill pp-integration-pill-default">
            {serverUrl !== null ? (
              <>
                <p className="pp-integration-secondary">
                  {tr("integrations.mcp-server.mcp-keys.info")}
                </p>
                <CopyField
                  value={serverUrl}
                  successMessage={tr("integrations.notification.success.copied-link")}
                  inputTestId="mcp-server-url"
                />
              </>
            ) : null}

            <p className="pp-integration-secondary">
              <a
                className="pp-mcp-server-help-link"
                href={mcpHelpCenterUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tr("integrations.mcp-server.mcp-keys.help")}
                <OpenLinkIcon />
              </a>
            </p>
          </div>
        </section>
      ) : null}

      {mcpOn && tokensOn ? <hr className="pp-integrations-separator" /> : null}

      {tokensOn ? (
        <section className="pp-access-tokens-section" aria-labelledby="access-tokens-title">
          <h2 id="access-tokens-title">{tr("integrations.access-tokens.personal")}</h2>

          <p className="pp-integration-secondary">
            {tr("integrations.access-tokens.personal.description")}
          </p>

          <button
            type="button"
            className="pp-btn-primary pp-fit-content"
            data-testid="access-token-create"
            onClick={() => openTokenFlow("access-token")}
          >
            {tr("integrations.access-tokens.create")}
          </button>

          {personalTokens.length > 0 ? (
            <div className="pp-token-list">
              {personalTokens.map((token) => (
                <TokenItem key={token.id} token={token} onDelete={confirmDelete} />
              ))}
            </div>
          ) : (
            <div className="pp-integration-frame">
              <p className="pp-integration-secondary pp-text-center">
                <span>{tr("integrations.access-tokens.empty.no-access-tokens")}</span>
                <span>{tr("integrations.access-tokens.empty.add-one")}</span>
              </p>
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
