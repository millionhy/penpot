"use client";

// Webhooks section (F5.5). Port of webhooks-page*, webhooks-hero*,
// webhooks-list*, webhook-item* and webhook-actions* of
// app.main.ui.dashboard.team, with the create/edit modal host.
//
// Deviations from the CLJS original, documented:
// - fetch-webhooks runs in the [] effect of the CLJS page; the shell depends
//   on teamId because App Router keeps a mounted page across search-param
//   navigation.
// - The row menu uses DashboardMenu instead of the CLJS ds dropdown; its
//   entries close on select.
// - The disabled actions placeholder keeps the title tooltip and the menu
//   glyph of the CLJS span.

import { useCallback, useEffect, useState } from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { TeamHeader } from "@/components/team-header";
import { useInviteMembers } from "@/components/team-invite";
import { Tr } from "@/components/tr";
import { WebhookModal } from "@/components/webhook-modal";
import { useDashboard } from "@/lib/dashboard-context";
import { useDocumentTitle } from "@/lib/dom";
import { tr } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import {
  canEditWebhook,
  deleteWebhook,
  webhookLastDeliveryText,
  type Webhook,
} from "@/lib/team";

interface WebhookMenu {
  webhookId: string;
  anchor: MenuAnchor;
}

export default function DashboardWebhooksPage() {
  const { team, teamId, invitations, webhooks, refreshWebhooks } = useDashboard();
  const { profile } = useSession();
  const modal = useModal();
  const notifications = useNotifications();
  const { openInvite } = useInviteMembers(team, profile?.id);
  const [menu, setMenu] = useState<WebhookMenu | null>(null);

  const viewerId = profile?.id ?? null;
  const rows = webhooks ?? [];

  // webhooks-page*: fetch-webhooks per team.
  useEffect(() => {
    void refreshWebhooks();
  }, [teamId, refreshWebhooks]);

  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.team-webhooks",
          team["is-default"] === true ? tr("dashboard.personal-projects") : team.name,
        ),
  );

  // on-success of the webhook modal: the toast plus the fetch-webhooks that
  // create-webhook and update-webhook concat after their own on-success.
  const onSaved = useCallback(() => {
    notifications.success(tr("dashboard.webhooks.create.success"));
    void refreshWebhooks();
  }, [notifications, refreshWebhooks]);

  const openCreate = useCallback(() => {
    if (teamId === null) return;
    modal.open(
      <WebhookModal
        teamId={teamId}
        onSaved={onSaved}
        onErrorToast={(message) => notifications.error(message)}
      />,
    );
  }, [teamId, modal, onSaved, notifications]);

  const openEdit = useCallback(
    (webhook: Webhook) => {
      if (teamId === null) return;
      modal.open(
        <WebhookModal
          teamId={teamId}
          webhook={webhook}
          onSaved={onSaved}
          onErrorToast={(message) => notifications.error(message)}
        />,
      );
    },
    [teamId, modal, onSaved, notifications],
  );

  // on-delete of webhook-item*: confirm, then delete-webhook + fetch-webhooks.
  const onDelete = useCallback(
    (webhook: Webhook) => {
      modal.open(
        <ConfirmDialog
          title={tr("modals.delete-webhook.title")}
          message={tr("modals.delete-webhook.message")}
          acceptLabel={tr("modals.delete-webhook.accept")}
          cancelLabel={tr("labels.cancel")}
          onAccept={() => {
            void (async () => {
              try {
                await deleteWebhook(webhook.id);
                await refreshWebhooks();
              } catch {
                notifications.error(tr("errors.generic"));
              }
            })();
          }}
        />,
      );
    },
    [modal, refreshWebhooks, notifications],
  );

  if (team === null || teamId === null) return null;

  const menuWebhook =
    menu === null ? null : rows.find((row) => row.id === menu.webhookId) ?? null;

  // The actions dropdown of webhook-actions*: edit and delete.
  const entriesFor = (webhook: Webhook): MenuEntry[] => [
    {
      type: "item",
      id: "webhook-edit",
      label: tr("labels.edit"),
      onSelect: () => {
        setMenu(null);
        openEdit(webhook);
      },
    },
    {
      type: "item",
      id: "webhook-delete",
      label: tr("labels.delete"),
      onSelect: () => {
        setMenu(null);
        onDelete(webhook);
      },
    },
  ];

  return (
    <>
      <TeamHeader
        section="webhooks"
        team={team}
        profileId={viewerId}
        invitations={invitations}
        onInvite={(inviteEmail) => {
          void openInvite(inviteEmail);
        }}
      />

      <section
        className="pp-dashboard-container pp-dashboard-team-webhooks"
        data-testid="team-webhooks-section"
      >
        <div className="pp-webhooks-hero">
          <h2 className="pp-webhooks-hero-title">{tr("labels.webhooks")}</h2>
          <div className="pp-webhooks-hero-desc">
            <Tr k="dashboard.webhooks.description" />
          </div>
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="create-webhook"
            onClick={openCreate}
          >
            {tr("dashboard.webhooks.create")}
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="pp-webhooks-empty">
            <div>{tr("dashboard.webhooks.empty.no-webhooks")}</div>
            <div>{tr("dashboard.webhooks.empty.add-one")}</div>
          </div>
        ) : (
          <div className="pp-team-table pp-webhook-table">
            <div className="pp-team-table-rows">
              {rows.map((webhook) => {
                const canEdit = canEditWebhook(webhook, team, viewerId);
                const menuOpen = menu !== null && menu.webhookId === webhook.id;
                const errorCode = webhook["error-code"];
                return (
                  <div className="pp-team-table-row pp-webhook-row" key={webhook.id}>
                    <div
                      className="pp-team-field pp-webhook-status"
                      title={webhookLastDeliveryText(webhook)}
                    >
                      {errorCode === null || errorCode === undefined ? (
                        <span
                          className="pp-webhook-status-icon pp-webhook-status-success"
                          aria-hidden="true"
                        >
                          {"\u2713"}
                        </span>
                      ) : (
                        <span
                          className="pp-webhook-status-icon pp-webhook-status-error"
                          aria-hidden="true"
                        >
                          !
                        </span>
                      )}
                    </div>

                    <div className="pp-team-field pp-field-uri">{webhook.uri}</div>

                    <div className="pp-team-field pp-field-active">
                      {webhook["is-active"] === true
                        ? tr("labels.active")
                        : tr("labels.inactive")}
                    </div>

                    <div className="pp-team-field pp-field-actions">
                      {canEdit ? (
                        <button
                          type="button"
                          className="pp-icon-btn"
                          aria-label={tr("dashboard.options")}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          data-testid={"webhook-options-" + webhook.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            const element = event.currentTarget;
                            setMenu((current) =>
                              current !== null && current.webhookId === webhook.id
                                ? null
                                : {
                                    webhookId: webhook.id,
                                    anchor: menuAnchorFromElement(element, "bottom-end"),
                                  },
                            );
                          }}
                        >
                          <span aria-hidden="true">…</span>
                        </button>
                      ) : (
                        <span
                          className="pp-menu-disabled"
                          title={tr("dashboard.webhooks.cant-edit")}
                        >
                          <span aria-hidden="true">…</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {menu !== null && menuWebhook !== null ? (
        <DashboardMenu
          anchor={menu.anchor}
          entries={entriesFor(menuWebhook)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}
