"use client";

// The workspace Tokens tab (画面 21, D12): the read-only shell of the CLJS
// sidebar/tokens toolbox. The parity file has zero themes, zero sets, and
// zero tokens (probed via :9001 debug store: state.workspaceTokens only
// carries the UI unfold state, no data), so this slice reproduces the
// **empty-state skeleton** — the themes block, the sets block, the "TOKENS -"
// section header with the seventeen token type rows collapsed to a count
// badge of zero each, and the tools footer. Nothing here reads :tokens-lib
// or :tokens from the file data; the CLJS management.cljs and its per-type
// editors are deferred to a follow-up slice.
//
// The seventeen type labels stay in English (matching the CLJS source: only
// Color and Stroke Width have translation keys; the rest render hardcoded,
// so both ends agree on the labels).
//
// Every interactive control here is disabled and never dispatches: this is a
// structural parity target, not a functional port.
//
// Deviations from the CLJS original, documented (AD12):
// - Themes / Sets "Create one." buttons are disabled: they open a modal
//   (create_modal.cljs) that is not migrated.
// - Each token-type row's "+" is disabled: adding a token is a write path.
// - Rows do not expand individually; there are no tokens to reveal.
// - The "Tools" menu (import/export) is a disabled button.

import { tr } from "@/lib/i18n";
import { ChevronIcon, PlusIcon } from "@/components/workspace-icons";

// The seventeen Penpot token types in CLJS sidebar/management.cljs order.
// The set is stable across releases (mirrors a subset of the DTCG draft plus
// Penpot-specific extensions like Border Radius, Sizing, Spacing, Opacity,
// Rotation, Text Case, Text Decoration). Keeping the labels as literal
// strings here matches the CLJS source, which renders most of them
// untranslated.
const TOKEN_TYPES = [
  "Border Radius",
  "Color",
  "Dimensions",
  "Font Family",
  "Font Size",
  "Font Weight",
  "Letter Spacing",
  "Number",
  "Opacity",
  "Rotation",
  "Shadow",
  "Sizing",
  "Spacing",
  "Stroke Width",
  "Text Case",
  "Text Decoration",
  "Typography",
] as const;

export function WorkspaceTokensPanel() {
  return (
    <article
      className="pp-workspace-tokens"
      data-testid="workspace-tokens-panel"
    >
      <section
        className="pp-workspace-tokens-block"
        data-testid="tokens-themes-block"
      >
        <h3 className="pp-workspace-tokens-block-title">
          {tr("labels.themes")}
        </h3>
        <p className="pp-workspace-tokens-empty">
          {tr("workspace.tokens.no-themes")}{" "}
          <button
            type="button"
            className="pp-workspace-tokens-link-button"
            data-testid="tokens-create-theme"
            disabled
          >
            {tr("workspace.tokens.create-one")}
          </button>
        </p>
      </section>

      <section
        className="pp-workspace-tokens-block"
        data-testid="tokens-sets-block"
      >
        <div className="pp-workspace-tokens-block-head">
          <h3 className="pp-workspace-tokens-block-title">
            {tr("labels.sets")}
          </h3>
          <button
            type="button"
            className="pp-workspace-tokens-icon-button"
            data-testid="tokens-add-set"
            title={tr("labels.sets")}
            aria-label={tr("labels.sets")}
            disabled
          >
            <PlusIcon />
          </button>
        </div>
        <p className="pp-workspace-tokens-empty">
          {tr("workspace.tokens.no-sets-yet")}{" "}
          <button
            type="button"
            className="pp-workspace-tokens-link-button"
            data-testid="tokens-create-set"
            disabled
          >
            {tr("workspace.tokens.create-one")}
          </button>
        </p>
      </section>

      {/* management.cljs renders the "TOKENS - <set>" header; with no set
          selected the %s slot collapses to an empty string, matching the
          "令牌 -" label the probe read on the CLJS side. */}
      <h3
        className="pp-workspace-tokens-section-title"
        data-testid="tokens-section-title"
      >
        {tr("workspace.tokens.tokens-section-title", "")}
      </h3>

      <ul
        className="pp-workspace-tokens-types"
        data-testid="tokens-types-list"
        role="list"
      >
        {TOKEN_TYPES.map((type) => (
          <li
            key={type}
            className="pp-workspace-tokens-type"
            data-testid={`tokens-type-${type.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <button
              type="button"
              className="pp-workspace-tokens-type-toggle"
              aria-expanded="false"
              aria-disabled="true"
              disabled
            >
              <span className="pp-workspace-tokens-type-chevron" aria-hidden>
                <ChevronIcon />
              </span>
              <span className="pp-workspace-tokens-type-name">{type}</span>
              <span className="pp-workspace-tokens-type-quantity" />
            </button>
            <button
              type="button"
              className="pp-workspace-tokens-icon-button"
              data-testid={`tokens-add-${type.toLowerCase().replace(/\s+/g, "-")}`}
              title={type}
              aria-label={type}
              disabled
            >
              <PlusIcon />
            </button>
          </li>
        ))}
      </ul>

      <footer className="pp-workspace-tokens-footer">
        <button
          type="button"
          className="pp-workspace-tokens-tools-button"
          data-testid="tokens-tools"
          disabled
        >
          {tr("workspace.tokens.tools")}
        </button>
      </footer>
    </article>
  );
}
