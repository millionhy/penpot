"use client";

// Layout toggle (F5.2). Port of app.main.ui.dashboard.layout-toggle: the
// persisted grid/list preference shared by the recent and the files views.
// The CLJS control is ds radio-buttons with view-as-list/view-as-icons icons:
// a wrapper of labels, each holding a button that carries aria-pressed and a
// display:none radio input. The shell keeps the same structure with unicode
// glyphs until @penpot/ui is wired, same stand-in as the rest of the dashboard.

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
    <div className="pp-layout-toggle">
      <label
        className="pp-layout-toggle-label"
        htmlFor="dashboard-files-layout-list"
        data-testid="layout-list"
      >
        <button
          type="button"
          className="pp-layout-toggle-btn"
          aria-pressed={layout === "list"}
          aria-label={tr("dashboard.files-layout.list")}
          title={tr("dashboard.files-layout.list")}
          onClick={() => onChange("list")}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <input
          id="dashboard-files-layout-list"
          className="pp-layout-toggle-input"
          type="radio"
          name="dashboard-files-layout"
          value="list"
          checked={layout === "list"}
          onChange={() => onChange("list")}
        />
      </label>
      <label
        className="pp-layout-toggle-label"
        htmlFor="dashboard-files-layout-grid"
        data-testid="layout-grid"
      >
        <button
          type="button"
          className="pp-layout-toggle-btn"
          aria-pressed={layout === "grid"}
          aria-label={tr("dashboard.files-layout.grid")}
          title={tr("dashboard.files-layout.grid")}
          onClick={() => onChange("grid")}
        >
          <span aria-hidden="true">▦</span>
        </button>
        <input
          id="dashboard-files-layout-grid"
          className="pp-layout-toggle-input"
          type="radio"
          name="dashboard-files-layout"
          value="grid"
          checked={layout === "grid"}
          onChange={() => onChange("grid")}
        />
      </label>
    </div>
  );
}
