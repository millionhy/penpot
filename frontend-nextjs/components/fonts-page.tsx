"use client";

// Custom fonts section (F5.4). Port of app.main.ui.dashboard.fonts:
// fonts-page* (the upload queue plus the installed-fonts table) and
// font-providers-page*, on top of the headless layer in lib/fonts.ts.
//
// Deviations from the CLJS original, documented:
// - Three defects in the upload error paths are repaired: a failed single
//   upload keeps the row retryable instead of locking its button on
//   "uploading" forever (the CLJS error branch never clears :uploading), a
//   failed upload-all keeps the row instead of dropping it (the [id nil]
//   branch of the CLJS chain dissocs it), and disable-upload-all? checks the
//   queue values ((some bad-font-family-tmp? fonts) walks the map entries,
//   where contains? never matches, so the CLJS button is never disabled).
// - The bad-font toast fires once the whole batch resolved, with the same
//   errors.bad-font / errors.bad-font-plural split; the CLJS error collector
//   raises it from a second subscription while later files are still being
//   read (see the deviation note on lib/fonts.ts).
// - update-font / delete-font / delete-font-variant refetch after the call
//   instead of the CLJS optimistic store update, and a successful upload
//   refetches too (add-font in CLJS only patches the store, without
//   re-registering the custom-font registry the @font-face CSS needs).
// - The file picker is a hidden <input type="file"> (file-uploader* in CLJS)
//   and the search box is controlled; the CLJS one stores the lower-cased
//   term, which is behaviourally the same case-insensitive match.

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { ConfirmDialog, useModal } from "@/components/modal";
import { useNotifications } from "@/components/notifications";
import { Tr } from "@/components/tr";
import { config } from "@/lib/config";
import { projectsTitleName } from "@/lib/dashboard";
import { useDashboard } from "@/lib/dashboard-context";
import { triggerDownload, useDocumentTitle } from "@/lib/dom";
import {
  deleteFont,
  deleteFontVariant,
  downloadFont,
  downloadFontFamily,
  fontDisplayVariant,
  mergeAndGroupFonts,
  processUpload,
  renameAndRegroup,
  updateFont,
  uploadFontVariant,
  validFontFamily,
  type FontUploadItem,
  type FontVariantRow,
} from "@/lib/fonts";
import { tr } from "@/lib/i18n";

// (str/join "," cm/font-types) plus the Chrome input-selector workaround.
const ACCEPT_FONT_TYPES =
  "font/ttf,font/woff,font/woff2,font/otf,.ttf,application/font-woff,.woff,.woff2,.otf";

// handle-font-upload: the rx/delay-at-least 2000 of the CLJS chain. A font
// that uploads quickly would only flicker through the button; holding the
// uploading state for at least two seconds makes the transition visible.
const MINIMUM_UPLOAD_MS = 2000;

function uploadWithMinimumDelay(item: FontUploadItem): Promise<FontVariantRow> {
  return Promise.all([
    uploadFontVariant(item),
    new Promise<void>((resolve) => setTimeout(resolve, MINIMUM_UPLOAD_MS)),
  ]).then(([font]) => font);
}

// bad-font-family-tmp?: the row is mid-edit and its temporary name is blank.
function badFontFamilyTmp(item: FontUploadItem): boolean {
  return item["font-family-tmp"] !== undefined && item["font-family-tmp"].trim() === "";
}

// (first (:names item)): a queue item merges every file of one family, so any
// of its names identifies it in the toast.
function firstOf(names: Set<string>): string {
  for (const name of names) return name;
  return "";
}

// variant-sort-fn: by weight, then normal before italic.
function compareVariants(a: FontVariantRow, b: FontVariantRow): number {
  if (a["font-weight"] !== b["font-weight"]) return a["font-weight"] - b["font-weight"];
  return (a["font-style"] === "normal" ? 1 : 2) - (b["font-style"] === "normal" ? 1 : 2);
}

// The dashboard variant of context-notification* (app.main.ui.notifications):
// an <aside> banner whose level class styles the message. The banner in
// components/context-notification.tsx carries the auth-page styles, so the
// section keeps its own small frame.
function FontsNotification({
  level,
  children,
}: {
  level: "default" | "warning";
  children: ReactNode;
}) {
  return (
    <aside className={"pp-fonts-notification pp-fonts-notification-" + level}>
      <span className="pp-fonts-notification-icon" aria-hidden="true">
        !
      </span>
      <div className="pp-fonts-notification-text">{children}</div>
    </aside>
  );
}

// --- Uploaded fonts queue ----------------------------------------------------

// uploaded-fonts*: the local queue between picking the files and every one of
// them being uploaded. `installedFonts` feeds merge-and-group-fonts and
// rename-and-regroup, which reuse the font-id of an already installed family.
function UploadedFonts({
  teamId,
  installedFonts,
  refreshFonts,
}: {
  teamId: string;
  installedFonts: FontVariantRow[];
  refreshFonts: () => Promise<void>;
}) {
  const notifications = useNotifications();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [fonts, setFonts] = useState<Map<string, FontUploadItem>>(() => new Map());
  const [uploading, setUploading] = useState<Set<string>>(() => new Set());

  const fontVals = useMemo(() => [...fonts.values()], [fonts]);

  // The CLJS guard is (some bad-font-family-tmp? fonts), which walks the map
  // entries — see the deviation note on top; the shell checks the values.
  const disableUploadAll = fontVals.some(badFontFamilyTmp);
  const problematic = fontVals.some((item) => item["height-warning"] === true);

  // (sort-by :font-family font-vals): code-unit order, like CLJS compare.
  const sortedQueue = useMemo(
    () =>
      [...fontVals].sort((a, b) =>
        a["font-family"] < b["font-family"] ? -1 : a["font-family"] > b["font-family"] ? 1 : 0,
      ),
    [fontVals],
  );

  const removeRow = useCallback((id: string) => {
    setFonts((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const stopUploading = useCallback((id: string) => {
    setUploading((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  // on-selected: process-upload then merge-and-group-fonts. The read errors
  // arrive as a batch and become the same bad-font / bad-font-plural toast the
  // CLJS error collector raises.
  const onSelected = useCallback(
    async (files: File[]) => {
      try {
        const { fonts: incoming, errors } = await processUpload(files, teamId);
        if (errors.length === 1) {
          notifications.error(tr("errors.bad-font", errors[0]));
        } else if (errors.length > 1) {
          notifications.error(tr("errors.bad-font-plural", errors.join(", ")));
        }
        setFonts((current) => mergeAndGroupFonts(current, installedFonts, incoming));
      } catch (error) {
        console.error("error", error);
      }
    },
    [teamId, installedFonts, notifications],
  );

  // One row: upload, drop it from the queue, refetch. The row survives a
  // failure with its uploading flag cleared so it can be retried.
  const uploadRow = useCallback(
    async (item: FontUploadItem) => {
      setUploading((current) => new Set(current).add(item.id));
      try {
        await uploadWithMinimumDelay(item);
        removeRow(item.id);
        stopUploading(item.id);
        await refreshFonts();
      } catch (cause) {
        stopUploading(item.id);
        notifications.error(tr("errors.bad-font", firstOf(item.names)));
        console.error("Unexpected error on uploading font", cause);
      }
    },
    [notifications, refreshFonts, removeRow, stopUploading],
  );

  const onUpload = useCallback(
    (item: FontUploadItem) => {
      void uploadRow(item);
    },
    [uploadRow],
  );

  // on-upload-all: the rx/mapcat serializes the uploads; a failed row is
  // reported and the loop moves on.
  const onUploadAll = useCallback(async () => {
    for (const item of fontVals) {
      await uploadRow(item);
    }
  }, [fontVals, uploadRow]);

  const onDismissAll = useCallback(() => {
    setFonts(new Map());
  }, []);

  // on-blur-name: a valid, non-blank name regroups the row under the font-id
  // of that family; an invalid one is left for the user to fix.
  const onNameBlur = useCallback(
    (item: FontUploadItem, value: string) => {
      if (value.trim() !== "" && validFontFamily(value)) {
        setFonts((current) => renameAndRegroup(current, item.id, value, installedFonts));
      }
    },
    [installedFonts],
  );

  const onNameChange = useCallback((item: FontUploadItem, value: string) => {
    setFonts((current) => {
      const row = current.get(item.id);
      if (row === undefined) return current;
      const next = new Map(current);
      next.set(item.id, { ...row, "font-family-tmp": value });
      return next;
    });
  }, []);

  return (
    <div className="pp-fonts-upload">
      <div className="pp-fonts-hero">
        <div className="pp-fonts-hero-desc">
          <h2>{tr("labels.upload-custom-fonts")}</h2>
          <Tr k="dashboard.fonts.hero-text1" tagName="p" />

          <div className="pp-fonts-picker">
            <button
              type="button"
              className="pp-btn-primary"
              onClick={() => inputRef.current?.click()}
            >
              {tr("labels.add-custom-font")}
            </button>
            <input
              ref={inputRef}
              id="font-upload"
              className="pp-fonts-file-input"
              type="file"
              accept={ACCEPT_FONT_TYPES}
              multiple
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                // Let the same file be picked again after a failed upload.
                event.target.value = "";
                if (files.length > 0) void onSelected(files);
              }}
            />
          </div>

          {config.termsOfServiceUri !== null ? (
            <FontsNotification level="default">
              <Tr k="dashboard.fonts.hero-text2" args={[config.termsOfServiceUri]} tagName="p" />
            </FontsNotification>
          ) : null}

          {problematic ? (
            <FontsNotification level="warning">
              <Tr k="dashboard.fonts.warning-text" tagName="p" />
            </FontsNotification>
          ) : null}
        </div>
      </div>

      {fontVals.length > 0 ? (
        <div className="pp-fonts-item pp-fonts-table-row pp-fonts-queue-header">
          <span className="pp-fonts-added-count">
            {tr("dashboard.fonts.fonts-added", fontVals.length)}
          </span>
          <div className="pp-fonts-table-field pp-fonts-field-options">
            <button
              type="button"
              className="pp-btn-primary"
              data-testid="upload-all"
              disabled={disableUploadAll}
              onClick={() => void onUploadAll()}
            >
              {tr("dashboard.fonts.upload-all")}
            </button>
            <button
              type="button"
              className="pp-btn-secondary"
              data-testid="dismiss-all"
              onClick={onDismissAll}
            >
              {tr("dashboard.fonts.dismiss-all")}
            </button>
          </div>
        </div>
      ) : null}

      {sortedQueue.map((item) => {
        const isUploading = uploading.has(item.id);
        const disabled = isUploading || badFontFamilyTmp(item);
        return (
          <div
            className="pp-fonts-item pp-fonts-table-row"
            key={item.id}
            data-testid={"font-row-" + item.id}
          >
            <div className="pp-fonts-table-field pp-fonts-field-family">
              <input
                type="text"
                className="pp-fonts-family-input"
                data-testid={"font-name-" + item.id}
                value={item["font-family-tmp"] ?? item["font-family"]}
                onBlur={(event) => onNameBlur(item, event.target.value)}
                onChange={(event) => onNameChange(item, event.target.value)}
              />
            </div>

            <div className="pp-fonts-table-field pp-fonts-field-variants">
              <span className="pp-fonts-variant-label">
                {fontDisplayVariant(item["variant-name"], item["font-weight"], item["font-style"])}
              </span>
            </div>

            <div className="pp-fonts-table-field pp-fonts-field-filenames">
              {[...item.names].map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>

            <div className="pp-fonts-table-field pp-fonts-field-options">
              {item["height-warning"] === true ? (
                <span className="pp-fonts-icon pp-fonts-warning-icon" aria-hidden="true">
                  !
                </span>
              ) : null}
              <button
                type="button"
                className="pp-btn-primary"
                data-testid={"upload-" + item.id}
                disabled={disabled}
                onClick={() => onUpload(item)}
              >
                {isUploading ? tr("labels.uploading") : tr("labels.upload")}
              </button>
              <button
                type="button"
                className="pp-fonts-icon pp-fonts-close"
                aria-label={tr("labels.delete")}
                onClick={() => removeRow(item.id)}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Installed fonts ---------------------------------------------------------

// installed-fonts*: the search box and the per-family rows, over the
// get-font-variants rows of the dashboard context (nil = still loading).
function InstalledFonts({
  fonts,
  canEdit,
}: {
  fonts: FontVariantRow[] | null;
  canEdit: boolean;
}) {
  const [search, setSearch] = useState("");

  // (->> fonts (filter matches?) (group-by :font-id)): first-appearance order,
  // case-insensitive substring match on the family.
  const groups = useMemo(() => {
    if (fonts === null) return [];
    const needle = search.toLowerCase();
    const byFontId = new Map<string, FontVariantRow[]>();
    for (const row of fonts) {
      if (!row["font-family"].toLowerCase().includes(needle)) continue;
      const list = byFontId.get(row["font-id"]);
      if (list === undefined) byFontId.set(row["font-id"], [row]);
      else list.push(row);
    }
    return [...byFontId.entries()];
  }, [fonts, search]);

  if (fonts === null) {
    return (
      <div className="pp-fonts-installed">
        <div className="pp-fonts-placeholder">
          <div className="pp-fonts-placeholder-icon" aria-hidden="true">
            {"\u2026"}
          </div>
          <div className="pp-fonts-placeholder-label">{tr("dashboard.loading-fonts")}</div>
        </div>
      </div>
    );
  }

  if (fonts.length === 0) {
    return (
      <div className="pp-fonts-installed">
        {canEdit ? (
          <div className="pp-fonts-placeholder" data-testid="fonts-empty-placeholder">
            <div className="pp-fonts-placeholder-icon" aria-hidden="true">
              T
            </div>
            <div className="pp-fonts-placeholder-label">
              {tr("dashboard.fonts.empty-placeholder")}
            </div>
          </div>
        ) : (
          <div
            className="pp-grid-empty-placeholder pp-fonts-empty-viewer"
            data-testid="fonts-empty-viewer"
          >
            <div className="pp-fonts-empty-title">
              {tr("dashboard.fonts.empty-placeholder-viewer")}
            </div>
            <div className="pp-fonts-empty-subtitle">
              {tr("dashboard.fonts.empty-placeholder-viewer-sub")}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pp-fonts-installed">
      <h3>{tr("labels.installed-fonts")}</h3>
      <div className="pp-fonts-installed-header">
        <div className="pp-fonts-table-field pp-fonts-field-family">
          {tr("labels.font-family")}
        </div>
        <div className="pp-fonts-table-field pp-fonts-field-variants">
          {tr("labels.font-variants")}
        </div>
        <div className="pp-fonts-table-field pp-fonts-field-search">
          <input
            type="text"
            className="pp-fonts-search-input"
            placeholder={tr("labels.search-font")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {groups.map(([fontId, variants]) => (
        <InstalledFont
          key={fontId + "-installed"}
          fontId={fontId}
          variants={variants}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

// installed-font*: one family row — inline rename, the variant chips and the
// context menu (edit / download / delete).
function InstalledFont({
  fontId,
  variants,
  canEdit,
}: {
  fontId: string;
  variants: FontVariantRow[];
  canEdit: boolean;
}) {
  const notifications = useNotifications();
  const modal = useModal();
  const { teamId, refreshFonts } = useDashboard();

  const font = variants[0];
  const [edition, setEdition] = useState(false);
  const [name, setName] = useState(font["font-family"]);
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null);

  const sortedVariants = useMemo(() => [...variants].sort(compareVariants), [variants]);

  const doDeleteFont = useCallback(async () => {
    if (teamId === null) return;
    try {
      await deleteFont(teamId, fontId);
      await refreshFonts();
    } catch (error) {
      console.error("error deleting font", error);
      notifications.error(tr("errors.generic"));
    }
  }, [teamId, fontId, notifications, refreshFonts]);

  const doDeleteVariant = useCallback(
    async (id: string) => {
      if (teamId === null) return;
      try {
        await deleteFontVariant(teamId, id);
        await refreshFonts();
      } catch (error) {
        console.error("error deleting font variant", error);
        notifications.error(tr("errors.generic"));
      }
    },
    [teamId, notifications, refreshFonts],
  );

  // on-save: closing the editor comes first, then a blank name is a no-op, an
  // invalid one raises errors.font-family-invalid-chars and a valid one calls
  // update-font for every variant of the family.
  const onSave = useCallback(() => {
    setEdition(false);
    if (name.trim() === "") return;
    if (!validFontFamily(name)) {
      notifications.error(tr("errors.font-family-invalid-chars"));
      return;
    }
    void (async () => {
      if (teamId === null) return;
      try {
        await updateFont({ "team-id": teamId, id: fontId, name });
        await refreshFonts();
      } catch (error) {
        console.error("error updating font", error);
        notifications.error(tr("errors.generic"));
      }
    })();
  }, [name, teamId, fontId, notifications, refreshFonts]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onSave();
  };

  const onCancel = useCallback(() => {
    setEdition(false);
    setName(font["font-family"]);
  }, [font]);

  // on-download: a single variant downloads through download-font, a family
  // with several through download-font-family; either answer is {name uri},
  // and the uri is fetched into a blob for trigger-download.
  const onDownload = useCallback(async () => {
    try {
      const info =
        sortedVariants.length > 1
          ? await downloadFontFamily(fontId)
          : await downloadFont(sortedVariants[0].id);
      const response = await fetch(info.uri);
      if (!response.ok) throw new Error("download failed: " + response.status);
      const blob = await response.blob();
      triggerDownload(info.name, blob);
    } catch (error) {
      console.error("error downloading font", error);
      notifications.error(tr("errors.generic"));
    }
  }, [sortedVariants, fontId, notifications]);

  const requestDeleteFont = useCallback(() => {
    modal.open(
      <ConfirmDialog
        title={tr("modals.delete-font.title")}
        message={tr("modals.delete-font.message")}
        acceptLabel={tr("labels.delete")}
        cancelLabel={tr("labels.cancel")}
        destructive
        acceptTestId="delete-font-accept"
        onAccept={() => void doDeleteFont()}
      />,
    );
  }, [modal, doDeleteFont]);

  const requestDeleteVariant = useCallback(
    (id: string) => {
      modal.open(
        <ConfirmDialog
          title={tr("modals.delete-font-variant.title")}
          message={tr("modals.delete-font-variant.message")}
          acceptLabel={tr("labels.delete")}
          cancelLabel={tr("labels.cancel")}
          destructive
          acceptTestId="delete-font-variant-accept"
          onAccept={() => void doDeleteVariant(id)}
        />,
      );
    },
    [modal, doDeleteVariant],
  );

  const menuEntries = useMemo<MenuEntry[]>(
    () => [
      {
        type: "item",
        id: "font-edit",
        label: tr("labels.edit"),
        onSelect: () => setEdition(true),
      },
      {
        type: "item",
        id: "font-download",
        label: tr("labels.download-simple"),
        onSelect: () => void onDownload(),
      },
      {
        type: "item",
        id: "font-delete",
        label: tr("labels.delete"),
        danger: true,
        onSelect: requestDeleteFont,
      },
    ],
    [onDownload, requestDeleteFont],
  );

  return (
    <div className="pp-fonts-item pp-fonts-table-row" data-testid={"font-family-" + fontId}>
      {edition ? (
        <div className="pp-fonts-table-field pp-fonts-field-family is-edition">
          <input
            type="text"
            className="pp-fonts-family-input"
            data-testid={"font-edit-input-" + fontId}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      ) : (
        <div className="pp-fonts-table-field pp-fonts-field-family">
          <span>{font["font-family"]}</span>
        </div>
      )}

      <div className="pp-fonts-table-field pp-fonts-field-variants">
        {sortedVariants.map((variant) => (
          <div
            className={canEdit ? "pp-fonts-variant" : "pp-fonts-variant is-inherit"}
            key={variant.id}
          >
            <span className="pp-fonts-variant-label">
              {fontDisplayVariant(
                variant["variant-name"],
                variant["font-weight"],
                variant["font-style"],
              )}
            </span>
            {canEdit ? (
              <button
                type="button"
                className="pp-fonts-variant-close"
                data-testid={"delete-variant-" + variant.id}
                aria-label={tr("labels.delete")}
                onClick={() => requestDeleteVariant(variant.id)}
              >
                +
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {edition ? (
        <div className="pp-fonts-table-field pp-fonts-field-options">
          <button
            type="button"
            className="pp-btn-primary"
            data-testid="font-save"
            disabled={name.trim() === ""}
            onClick={onSave}
          >
            {tr("labels.save")}
          </button>
          <button
            type="button"
            className="pp-fonts-icon pp-fonts-close"
            aria-label={tr("labels.cancel")}
            onClick={onCancel}
          >
            ×
          </button>
        </div>
      ) : canEdit ? (
        <div className="pp-fonts-table-field pp-fonts-field-options">
          <button
            type="button"
            className="pp-fonts-menu-button"
            data-testid={"font-menu-" + fontId}
            aria-label={tr("dashboard.options")}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={(event) => {
              const element = event.currentTarget;
              setMenuAnchor((current) =>
                current === null ? menuAnchorFromElement(element, "bottom-end") : null,
              );
            }}
          >
            <span aria-hidden="true">…</span>
          </button>
          {menuAnchor !== null ? (
            <DashboardMenu
              anchor={menuAnchor}
              entries={menuEntries}
              onClose={() => setMenuAnchor(null)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// --- Pages -------------------------------------------------------------------

// fonts-page*: the upload section only exists for editing teams.
export function FontsPage() {
  const { team, teamId, canEdit, fonts, refreshFonts } = useDashboard();

  useDocumentTitle(
    team === null
      ? ""
      : tr("title.dashboard.fonts", projectsTitleName(team, tr("dashboard.personal-projects"))),
  );

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-fonts-title">
          <h1>{tr("labels.fonts")}</h1>
        </div>
      </header>
      <section className="pp-dashboard-container pp-dashboard-fonts" data-testid="fonts-section">
        {canEdit && teamId !== null ? (
          <UploadedFonts teamId={teamId} installedFonts={fonts ?? []} refreshFonts={refreshFonts} />
        ) : null}
        <InstalledFonts fonts={fonts} canEdit={canEdit} />
      </section>
    </>
  );
}

// font-providers-page*: still a placeholder body, like the CLJS one.
export function FontProvidersPage() {
  const { team } = useDashboard();

  useDocumentTitle(
    team === null
      ? ""
      : tr(
          "title.dashboard.font-providers",
          projectsTitleName(team, tr("dashboard.personal-projects")),
        ),
  );

  return (
    <>
      <header className="pp-dashboard-header" data-testid="dashboard-header">
        <div className="pp-dashboard-title" id="dashboard-fonts-title">
          <h1>{tr("labels.fonts")}</h1>
        </div>
      </header>
      <section className="pp-dashboard-container pp-dashboard-fonts">
        <span>font providers</span>
      </section>
    </>
  );
}
