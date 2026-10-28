"use client";

// The align bar of the workspace style panel (F9.14): the six align axes and
// the two distribute commands, ported from
// sidebar/options/menus/align.cljs.
//
// The bar is one row of eight buttons over two groups (horizontal, vertical)
// that sit side by side in the CSS grid. A button asks the canvas for the
// whole command; the permissions follow can-align? / can-distribute?: a
// single shape with no parent frame has nothing to align to, and fewer than
// three shapes cannot distribute. A selection that can do neither hides the
// bar, like the CLJS `when` around the row.
//
// The CLJS builds each caption as tr key (get-tooltip shortcut), so the
// catalog strings carry a (%s) for the shortcut. The rewrite has no align
// shortcut yet, so the caption drops the placeholder.

import type { ReactElement } from "react";

import {
  AlignBottomIcon,
  AlignHorizontalCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  DistributeHorizontallyIcon,
  DistributeVerticallyIcon,
} from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import { canAlign, canDistribute, type AlignAxis, type DistributeAxis } from "@/lib/workspace-align";
import type { WorkspaceObjects } from "@/lib/workspace";

export interface WorkspaceAlignOptionsProps {
  objects: WorkspaceObjects;
  ids: readonly string[];
  disabled: boolean;
  onAlign: (axis: AlignAxis) => void;
  onDistribute: (axis: DistributeAxis) => void;
}

// One entry per button: an align axis or a distribute command. The `labelKey`
// field keeps the key visible to scripts/extract-translations.mjs.
type Entry =
  | { kind: "align"; axis: AlignAxis; labelKey: string; icon: () => ReactElement }
  | { kind: "distribute"; axis: DistributeAxis; labelKey: string; icon: () => ReactElement };

const HORIZONTAL: readonly Entry[] = [
  { kind: "align", axis: "hleft", labelKey: "workspace.align.hleft", icon: AlignLeftIcon },
  { kind: "align", axis: "hcenter", labelKey: "workspace.align.hcenter", icon: AlignHorizontalCenterIcon },
  { kind: "align", axis: "hright", labelKey: "workspace.align.hright", icon: AlignRightIcon },
  {
    kind: "distribute",
    axis: "horizontal",
    labelKey: "workspace.align.hdistribute",
    icon: DistributeHorizontallyIcon,
  },
];

const VERTICAL: readonly Entry[] = [
  { kind: "align", axis: "vtop", labelKey: "workspace.align.vtop", icon: AlignTopIcon },
  { kind: "align", axis: "vcenter", labelKey: "workspace.align.vcenter", icon: AlignVerticalCenterIcon },
  { kind: "align", axis: "vbottom", labelKey: "workspace.align.vbottom", icon: AlignBottomIcon },
  {
    kind: "distribute",
    axis: "vertical",
    labelKey: "workspace.align.vdistribute",
    icon: DistributeVerticallyIcon,
  },
];

// The CLJS tooltip is tr(key, (sc/get-tooltip shortcut)), so the catalog
// strings carry a (%s) for the shortcut. The rewrite has no align shortcut
// yet, so drop the placeholder instead of showing a stray (%s).
function tooltip(key: string): string {
  return tr(key).replace(/\s*[（(]\s*%s\s*[）)]/g, "");
}

export function WorkspaceAlignOptions({
  objects,
  ids,
  disabled,
  onAlign,
  onDistribute,
}: WorkspaceAlignOptionsProps) {
  const alignable = canAlign(objects, ids);
  const distributable = canDistribute(ids);
  if (!alignable && !distributable) return null;

  return (
    <div className="pp-workspace-align" role="group">
      {[HORIZONTAL, VERTICAL].map((group, index) => (
        <div className="pp-workspace-align-group" key={index}>
          {group.map(({ kind, axis, labelKey, icon: Icon }) => {
            const distribute = kind === "distribute";
            return (
              <button
                key={axis}
                type="button"
                className="pp-workspace-align-button"
                title={tooltip(labelKey)}
                aria-label={tooltip(labelKey)}
                disabled={disabled || (distribute ? !distributable : !alignable)}
                onClick={() =>
                  distribute ? onDistribute(axis as DistributeAxis) : onAlign(axis as AlignAxis)
                }
              >
                <Icon />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
