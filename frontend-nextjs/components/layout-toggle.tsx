"use client";

// Layout toggle (F5.2). Port of app.main.ui.dashboard.layout-toggle: the
// persisted grid/list preference shared by the recent and the files views.
// The CLJS control is ds radio-buttons with view-as-list/view-as-icons icons;
// the shell renders two radio-role buttons with unicode glyphs until
// @penpot/ui is wired, same stand-in as the rest of the dashboard.

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  readDashboardLayout,
  writeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard";
import { tr } from "@/lib/i18n";

// use-persisted-state semantics: read once on mount (never during SSR, so the
// prerendered markup keeps the default layout), write through on every change.
export function useDashboardLayout(): [DashboardLayout, (layout: DashboardLayout) => void] {
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_DASHBOARD_LAYOUT);

  useEffect(() => {
    setLayout(readDashboardLayout());
  }, []);

  const onChange = useCallback((next: DashboardLayout) => {
    setLayout(next);
    writeDashboardLayout(next);
  }, []);

  return [layout, onChange];
}

export interface LayoutToggleProps {
  layout: DashboardLayout;
  onChange: (layout: DashboardLayout) => void;
}

export function LayoutToggle({ layout, onChange }: LayoutToggleProps) {
  return (
    <div className="pp-layout-toggle" role="radiogroup" aria-label={tr("dashboard.options")}>
      <button
        type="button"
        role="radio"
        id="dashboard-files-layout-list"
        className="pp-layout-toggle-btn"
        aria-checked={layout === "list"}
        aria-label={tr("dashboard.files-layout.list")}
        title={tr("dashboard.files-layout.list")}
        data-testid="layout-list"
        onClick={() => onChange("list")}
      >
        <span aria-hidden="true">☰</span>
      </button>
      <button
        type="button"
        role="radio"
        id="dashboard-files-layout-grid"
        className="pp-layout-toggle-btn"
        aria-checked={layout === "grid"}
        aria-label={tr("dashboard.files-layout.grid")}
        title={tr("dashboard.files-layout.grid")}
        data-testid="layout-grid"
        onClick={() => onChange("grid")}
      >
        <span aria-hidden="true">▦</span>
      </button>
    </div>
  );
}
