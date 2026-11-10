"use client";

// The typography section of the workspace style panel (D4): the options a
// text shape edits across every paragraph and text node, rendered for the
// single-shape section when the selection is a text.
//
// Port of the core slice of the CLJS Text/Typo menus
// (sidebar/options/menus/text.cljs + typography.cljs), narrowed to the eight
// controls the D4 plan fixes: font family, size, variant, line height, letter
// spacing, text transform, align and the text fill color. The row order
// follows the CLJS: family, then size/variant, the two spacing fields, the
// transform, the align and the color.
//
// A controlled view over the content tree, like the rest of the panel: the
// caller reads getTextAttrs(shape.content) and passes the shared value (with
// TEXT_MIXED where the spans disagree) plus the shared font catalog; every
// edit hands back a partial TextAttrs and the caller folds it over the tree
// with setTextAttrs and commits one mod-obj. The component owns no RPC and no
// content walk.
//
// Deviations from the CLJS original, documented:
// - The font picker is a plain searchable <select> over the shared catalog
//   (lib/workspace-fonts-catalog), not the virtualized sprite/preview list of
//   typography.cljs; there is no "recent fonts" row and no font search box.
// - Only the solid fill color of the first text fill is edited; gradients and
//   multi-fill stacks are left untouched (the row rewrites fills to one solid
//   stop, preserving the stored opacity).
// - The deferred controls of the D4 plan are absent on purpose: text
//   decoration, writing direction, vertical align and grow-type.
// - line-height and letter-spacing share the CLJS spacing bounds (text.cljc
//   valid-line-height? / valid-letter-spacing? both use spacing-min/max);
//   font-size uses font-size-min/max. A typed value is clamped before it
//   reaches the store, matching valid-numeric-text-in-range?.

import {
  DraftField,
  SelectField,
  colorOf,
  parseNumber,
  useDraftFields,
} from "@/components/workspace-style-field";
import { tr } from "@/lib/i18n";
import {
  findCatalogFont,
  findCatalogVariant,
  type CatalogFont,
} from "@/lib/workspace-fonts-catalog";
import {
  TEXT_FONT_SIZE_MAX,
  TEXT_FONT_SIZE_MIN,
  TEXT_MIXED,
  TEXT_SPACING_MAX,
  TEXT_SPACING_MIN,
  type TextAttrKey,
  type TextAttrs,
} from "@/lib/workspace-text";

export interface WorkspaceTextOptionsProps {
  // getTextAttrs(content): the shared value per key, TEXT_MIXED on disagree.
  attrs: TextAttrs;
  // The one catalog the picker and the D11 pipeline share.
  catalog: readonly CatalogFont[];
  disabled: boolean;
  // Fold a partial edit over the content tree and commit it (the panel owns
  // setTextAttrs + the mod-obj send).
  onApply: (attrs: TextAttrs) => Promise<boolean>;
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// The stored scalar as the field's text; an absent or mixed value renders
// empty so the placeholder shows (the CLJS "--" / :multiple state).
function scalarValue(attrs: TextAttrs, key: TextAttrKey): string {
  const value = attrs[key];
  if (value === TEXT_MIXED) return "";
  return typeof value === "string" ? value : "";
}

const TRANSFORMS = ["none", "uppercase", "capitalize", "lowercase"] as const;
const ALIGNS = ["left", "center", "right", "justify"] as const;

// An enum value that is not in the picker's set (a stale or the CLJS "unset"
// transform) reads as the mixed placeholder rather than a phantom option.
function enumValue(attrs: TextAttrs, key: TextAttrKey, allowed: readonly string[]): string {
  const value = scalarValue(attrs, key);
  return allowed.includes(value) ? value : "";
}

// One text fill: the color of the first solid stop drives the swatch; the
// opacity is kept so a color edit does not reset the fill's transparency.
interface TextFillView {
  color: string;
  opacity: number;
}

function fillView(fills: TextAttrs["fills"]): TextFillView {
  const first = Array.isArray(fills) ? fills[0] : undefined;
  const color = first !== undefined && typeof first["fill-color"] === "string" ? first["fill-color"] : "";
  const rawOpacity = first !== undefined ? first["fill-opacity"] : undefined;
  const opacity = typeof rawOpacity === "number" ? rawOpacity : 1;
  return { color, opacity };
}

export function WorkspaceTextOptions({
  attrs,
  catalog,
  disabled,
  onApply,
}: WorkspaceTextOptionsProps) {
  const { drafts, setDraft, dropDraft, commitDraft, commitAction } = useDraftFields((sent) =>
    onApply(sent as TextAttrs),
  );

  // A numeric field clamps into the CLJS bounds before it is committed, so a
  // typed 0 font size lands at 3 rather than an out-of-range value.
  const commitNumber = (
    fieldId: string,
    raw: string | undefined,
    key: TextAttrKey,
    min: number,
    max: number,
  ): void => {
    if (raw === undefined) return;
    const parsed = parseNumber(raw);
    if (parsed === null) {
      dropDraft(fieldId);
      return;
    }
    const value = String(clampRange(parsed, min, max));
    commitDraft(fieldId, raw, { [key]: value } as TextAttrs);
  };

  // The family drives the variant list: a pick resets the variant, weight and
  // style to the family's first face so the content stays self-consistent.
  const currentFont = findCatalogFont(catalog, attrs["font-id"]);
  const familyValue = currentFont !== undefined ? currentFont.id : "";
  const variantOptions =
    currentFont === undefined
      ? []
      : currentFont.variants.map((variant) => ({ value: variant.id, label: variant.name }));
  const storedVariant = scalarValue(attrs, "font-variant-id");
  const variantValue = variantOptions.some((option) => option.value === storedVariant)
    ? storedVariant
    : (variantOptions[0]?.value ?? "");

  const fill = fillView(attrs["fills"]);
  const mixedFill = attrs["fills"] === TEXT_MIXED;

  return (
    <section className="pp-workspace-style-section" aria-label={tr("inspect.attributes.typography")}>
      <header className="pp-workspace-style-header">
        <h3 className="pp-workspace-style-title">{tr("inspect.attributes.typography")}</h3>
      </header>

      <div className="pp-workspace-style-grid">
        <SelectField
          label={tr("inspect.attributes.typography.font-family")}
          value={familyValue}
          options={catalog.map((font) => ({ value: font.id, label: font.name }))}
          disabled={disabled}
          mixedLabel={tr("inspect.attributes.typography.mixed-font-family")}
          onChange={(next) => {
            const font = findCatalogFont(catalog, next);
            if (font === undefined) return;
            const variant = font.variants[0];
            void onApply({
              "font-id": font.id,
              "font-family": font.family,
              "font-variant-id": variant.id,
              "font-weight": variant.weight,
              "font-style": variant.style,
            });
          }}
        />
        <SelectField
          label={tr("inspect.attributes.typography.font-style")}
          value={variantValue}
          options={variantOptions}
          disabled={disabled || currentFont === undefined}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => {
            if (currentFont === undefined) return;
            const variant = findCatalogVariant(currentFont, next);
            if (variant === undefined) return;
            void onApply({
              "font-variant-id": variant.id,
              "font-weight": variant.weight,
              "font-style": variant.style,
            });
          }}
        />
      </div>

      <div className="pp-workspace-style-grid">
        <DraftField
          fieldId="text-font-size"
          type="number"
          label={tr("inspect.attributes.typography.font-size")}
          value={scalarValue(attrs, "font-size")}
          draft={drafts["text-font-size"]}
          disabled={disabled}
          min={TEXT_FONT_SIZE_MIN}
          max={TEXT_FONT_SIZE_MAX}
          step={1}
          placeholder={tr("settings.multiple")}
          onDraft={setDraft}
          onCommit={(fieldId, raw) =>
            commitNumber(fieldId, raw, "font-size", TEXT_FONT_SIZE_MIN, TEXT_FONT_SIZE_MAX)
          }
          onCancel={dropDraft}
        />
        <DraftField
          fieldId="text-line-height"
          type="number"
          label={tr("inspect.attributes.typography.line-height")}
          value={scalarValue(attrs, "line-height")}
          draft={drafts["text-line-height"]}
          disabled={disabled}
          min={TEXT_SPACING_MIN}
          max={TEXT_SPACING_MAX}
          step={0.1}
          placeholder={tr("settings.multiple")}
          onDraft={setDraft}
          onCommit={(fieldId, raw) =>
            commitNumber(fieldId, raw, "line-height", TEXT_SPACING_MIN, TEXT_SPACING_MAX)
          }
          onCancel={dropDraft}
        />
        <DraftField
          fieldId="text-letter-spacing"
          type="number"
          label={tr("inspect.attributes.typography.letter-spacing")}
          value={scalarValue(attrs, "letter-spacing")}
          draft={drafts["text-letter-spacing"]}
          disabled={disabled}
          min={TEXT_SPACING_MIN}
          max={TEXT_SPACING_MAX}
          step={0.1}
          unit="%"
          placeholder={tr("settings.multiple")}
          onDraft={setDraft}
          onCommit={(fieldId, raw) =>
            commitNumber(fieldId, raw, "letter-spacing", TEXT_SPACING_MIN, TEXT_SPACING_MAX)
          }
          onCancel={dropDraft}
        />
      </div>

      <div className="pp-workspace-style-grid">
        {/* The transform and align groups have no single caption msgid (the
            CLJS renders them as icon rows), so the caption keeps an English
            fallback per the D9 rule; the option labels are real catalog keys. */}
        <SelectField
          label="Transform"
          value={enumValue(attrs, "text-transform", TRANSFORMS)}
          options={[
            { value: "none", label: tr("inspect.attributes.typography.text-transform.none") },
            {
              value: "uppercase",
              label: tr("inspect.attributes.typography.text-transform.uppercase"),
            },
            {
              value: "capitalize",
              label: tr("inspect.attributes.typography.text-transform.capitalize"),
            },
            {
              value: "lowercase",
              label: tr("inspect.attributes.typography.text-transform.lowercase"),
            },
          ]}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void onApply({ "text-transform": next })}
        />
        <SelectField
          label="Alignment"
          value={enumValue(attrs, "text-align", ALIGNS)}
          options={[
            {
              value: "left",
              label: tr("workspace.options.text-options.text-align-left"),
            },
            {
              value: "center",
              label: tr("workspace.options.text-options.text-align-center"),
            },
            {
              value: "right",
              label: tr("workspace.options.text-options.text-align-right"),
            },
            {
              value: "justify",
              label: tr("workspace.options.text-options.text-align-justify"),
            },
          ]}
          disabled={disabled}
          mixedLabel={tr("settings.multiple")}
          onChange={(next) => void onApply({ "text-align": next })}
        />
      </div>

      <div className="pp-workspace-style-grid">
        <DraftField
          fieldId="text-fill-color"
          type="color"
          label={tr("labels.color")}
          // A mixed fill shows the swatch of black; committing a pick replaces
          // the whole fill list with that one solid color (the CLJS does the
          // same when a gradient is overwritten from the color input).
          value={mixedFill ? colorOf(undefined) : colorOf(fill.color)}
          draft={drafts["text-fill-color"]}
          disabled={disabled}
          onDraft={setDraft}
          onCommit={(fieldId, raw) => {
            if (raw === undefined) return;
            commitAction(fieldId, raw, () =>
              onApply({ fills: [{ "fill-color": raw, "fill-opacity": fill.opacity }] }),
            );
          }}
          onCancel={dropDraft}
        />
      </div>
    </section>
  );
}
