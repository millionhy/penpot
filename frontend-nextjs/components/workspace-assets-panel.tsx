"use client";

// The workspace Assets tab (画面 21, D12): the read-only shell of the CLJS
// sidebar/assets toolbox. The parity file has zero components, colors, or
// typographies (probed via :9001 debug store: state.files[fid].data carries
// only pages/pagesIndex/id/options), so this slice reproduces only the
// **empty-state skeleton** — the top toolbar (add-library button, search
// input, filter and sort toggles), the "local library" collapsible, and the
// three asset sections (components, colors, typographies) with a zero count
// badge and a disabled add icon. Nothing here reads the file data or the
// remote libraries; the CLJS file-library.cljs and its per-section rows are
// intentionally deferred to a follow-up slice.
//
// Every interactive control here is disabled and never dispatches: this is a
// structural parity target, not a functional port. When a real library exists
// (the user shares a file or creates a component), the panel still renders
// zero rows for now — that follow-up belongs to the same D12 slice.
//
// Deviations from the CLJS original, documented (AD12):
// - The "Manage library" button is disabled: the CLJS version opens the
//   :libraries-dialog modal, which is not migrated.
// - The search bar, filter dropdown, and ordering toggle are visual only:
//   none of the three filter axes (term/section/ordering) has a real state
//   behind it, since the panel has no items to filter.
// - The three asset sections do not expand/collapse individually, and their
//   add (+) buttons do not fire: creating a color/typography/component is a
//   write path this slice deliberately does not touch.
// - Remote libraries (the CLJS assets-libraries* branch iterating
//   refs/libraries minus the current file) are not rendered; the parity file
//   has none. When a shared library appears, adding it here is the next step.

import { tr } from "@/lib/i18n";
import { ChevronIcon, PlusIcon, SearchIcon } from "@/components/workspace-icons";

// The three asset sections in the CLJS order (file_library.cljs renders
// them under a single "local library" title-bar): Components, Colors,
// Typographies. A follow-up slice folds in Media when the file carries it.
const ASSET_SECTIONS = [
  { id: "components", labelKey: "workspace.assets.components" },
  { id: "colors", labelKey: "workspace.assets.colors" },
  { id: "typographies", labelKey: "workspace.assets.typography" },
] as const;

export function WorkspaceAssetsPanel() {
  return (
    <article
      className="pp-workspace-assets"
      data-testid="workspace-assets-panel"
    >
      <header className="pp-workspace-assets-header">
        {/* assets.cljs renders add-library when the file has one library and
            no assets; the shell matches that entry state verbatim. */}
        <button
          type="button"
          className="pp-workspace-assets-library-button"
          data-testid="assets-add-library"
          disabled
          title={tr("workspace.assets.add-library")}
        >
          {tr("workspace.assets.add-library")}
        </button>
        <div className="pp-workspace-assets-search">
          <span className="pp-workspace-assets-search-icon" aria-hidden>
            <SearchIcon />
          </span>
          <input
            type="search"
            className="pp-workspace-assets-search-input"
            placeholder={tr("workspace.assets.search")}
            aria-label={tr("workspace.assets.search")}
            disabled
          />
          <button
            type="button"
            className="pp-workspace-assets-icon-button"
            data-testid="assets-filter"
            title={tr("workspace.assets.filter")}
            aria-label={tr("workspace.assets.filter")}
            disabled
          >
            {/* No filter icon in the current vocabulary; text label keeps
                the button discoverable without inventing a new glyph. */}
            <span aria-hidden>{"⌄"}</span>
          </button>
          <button
            type="button"
            className="pp-workspace-assets-icon-button"
            data-testid="assets-sort"
            title={tr("workspace.assets.sort")}
            aria-label={tr("workspace.assets.sort")}
            disabled
          >
            <span aria-hidden>{"↕"}</span>
          </button>
        </div>
      </header>

      {/* file_library.cljs owns one open section per local library, so the
          shell renders a single expanded title-bar with the three rows below. */}
      <section
        className="pp-workspace-assets-library"
        data-testid="assets-local-library"
      >
        <div
          className="pp-workspace-assets-library-title"
          role="button"
          aria-expanded="true"
          aria-disabled="true"
          tabIndex={-1}
        >
          <span className="pp-workspace-assets-library-chevron" aria-hidden>
            <ChevronIcon />
          </span>
          <span className="pp-workspace-assets-library-name">
            {tr("workspace.assets.local-library")}
          </span>
        </div>

        {ASSET_SECTIONS.map((section) => (
          <div
            key={section.id}
            className="pp-workspace-assets-section"
            data-testid={`assets-section-${section.id}`}
          >
            <span
              className="pp-workspace-assets-section-title"
              data-testid={`assets-title-${section.id}`}
            >
              {tr(section.labelKey)}
            </span>
            <span
              className="pp-workspace-assets-section-count"
              data-testid={`assets-count-${section.id}`}
            >
              {0}
            </span>
            <button
              type="button"
              className="pp-workspace-assets-icon-button"
              data-testid={`assets-add-${section.id}`}
              title={tr(section.labelKey)}
              aria-label={tr(section.labelKey)}
              disabled
            >
              <PlusIcon />
            </button>
          </div>
        ))}
      </section>
    </article>
  );
}
