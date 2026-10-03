"use client";

// Check-updates modals (F5.2). View half of app.main.ui.dashboard.check-updates:
// the three dialogs the sidebar's "check for updates" entry can open
// (up-to-date, update available with the parsed CHANGES.md highlights, and
// unable-to-check with a retry). The fetch and parsing live in
// lib/check-updates.ts; telemetry events are dropped like everywhere else in
// the shell.

import {
  CHANGELOG_URL,
  RELEASE_NOTES_URL,
  checkForUpdates,
  parseHighlightItem,
  type HighlightsSection,
  type UpdateCheckResult,
} from "@/lib/check-updates";
import { tr } from "@/lib/i18n";
import { ModalShell, useModal, type ModalApi } from "@/components/modal";

export function CheckUpdatesUptodateModal({ version }: { version: string }) {
  const { close } = useModal();
  return (
    <ModalShell
      title={tr("dashboard.check-updates.uptodate-title")}
      titleTestId="check-updates-uptodate"
      closeLabel={tr("labels.close")}
      footer={
        <button
          type="button"
          className="pp-btn-secondary"
          data-testid="check-updates-close"
          onClick={close}
        >
          {tr("labels.close")}
        </button>
      }
    >
      <p className="pp-modal-message">
        {tr("dashboard.check-updates.uptodate-message")} <span className="pp-version">{version}</span>
      </p>
    </ModalShell>
  );
}

function HighlightFragments({ item }: { item: string }) {
  return (
    <>
      {parseHighlightItem(item).map((fragment, index) => {
        if (fragment.type === "link") {
          return (
            <a key={index} href={fragment.href} target="_blank" rel="noopener noreferrer">
              {fragment.text}
            </a>
          );
        }
        if (fragment.type === "bold") return <strong key={index}>{fragment.text}</strong>;
        return <span key={index}>{fragment.text}</span>;
      })}
    </>
  );
}

export function CheckUpdatesAvailableModal({
  installed,
  latest,
  highlights,
}: {
  installed: string;
  latest: string;
  highlights: HighlightsSection[];
}) {
  return (
    <ModalShell
      title={tr("dashboard.check-updates.available-title")}
      titleTestId="check-updates-available"
      closeLabel={tr("labels.close")}
      footer={
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-btn-secondary"
            onClick={() => window.open(CHANGELOG_URL, "_blank", "noopener,noreferrer")}
          >
            {tr("dashboard.check-updates.view-changelog")}
          </button>
          <button
            type="button"
            className="pp-btn-primary"
            onClick={() => window.open(RELEASE_NOTES_URL, "_blank", "noopener,noreferrer")}
          >
            {tr("dashboard.check-updates.view-release-notes")}
          </button>
        </div>
      }
    >
      <div className="pp-version-bar" data-testid="check-updates-versions">
        <span>
          {tr("dashboard.check-updates.installed-version")} <span className="pp-version">{installed}</span>
        </span>
        <span aria-hidden="true">→</span>
        <span>
          {tr("dashboard.check-updates.latest-version")}{" "}
          <span className="pp-version pp-version-accent">{latest}</span>
        </span>
      </div>
      <p className="pp-modal-message">{tr("dashboard.check-updates.available-message")}</p>
      {highlights.length > 0 ? (
        <>
          <h3 className="pp-highlights-title">{tr("dashboard.check-updates.highlights-title")}</h3>
          <div className="pp-highlights-scroll">
            {highlights.map((section) => (
              <div key={section.version} className="pp-highlights-section">
                <div className="pp-highlights-version">{section.version}</div>
                <ul className="pp-highlights-list">
                  {section.items.map((item) => (
                    <li key={item} className="pp-highlights-item">
                      <HighlightFragments item={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </ModalShell>
  );
}

export function CheckUpdatesUnableModal({ onRetry }: { onRetry: () => void }) {
  return (
    <ModalShell
      title={tr("dashboard.check-updates.unable-title")}
      titleTestId="check-updates-unable"
      closeLabel={tr("labels.close")}
      footer={
        <button
          type="button"
          className="pp-btn-primary"
          data-testid="check-updates-retry"
          onClick={onRetry}
        >
          {tr("dashboard.check-updates.try-again")}
        </button>
      }
    >
      <p className="pp-modal-message">{tr("dashboard.check-updates.unable-message")}</p>
      <p className="pp-modal-message">{tr("dashboard.check-updates.unable-hint")}</p>
    </ModalShell>
  );
}

function openResult(modal: ModalApi, installed: string, result: UpdateCheckResult): void {
  if (result.kind === "uptodate") {
    modal.open(<CheckUpdatesUptodateModal version={result.version} />);
    return;
  }
  if (result.kind === "available") {
    modal.open(
      <CheckUpdatesAvailableModal
        installed={result.installed}
        latest={result.latest}
        highlights={result.highlights}
      />,
    );
    return;
  }
  modal.open(
    <CheckUpdatesUnableModal
      onRetry={() => {
        modal.close();
        void runCheckForUpdates(modal, installed);
      }}
    />,
  );
}

// check-for-updates!: fetch + classify + open the matching dialog.
export async function runCheckForUpdates(modal: ModalApi, installed: string): Promise<void> {
  const result = await checkForUpdates(installed);
  openResult(modal, installed, result);
}
