"use client";

// Bulk-operation progress widget (F5.3). Port of
// app.main.ui.components.progress/progress-notification-widget* together with
// the :progress store slice the CLJS app keeps globally (dcm/initialize-progress
// and friends): the shell has no Potok store, so the machine in lib/progress.ts
// lives on a context and the widget renders from it.
//
// app.main.ui.cljs mounts the widget as the first child of dashboard-content*,
// which is what app/dashboard/layout.tsx does with ProgressProvider, so the
// absolute positioning resolves against the dashboard content box.
//
// Deviations from the CLJS original, documented:
// - The :error branch of the widget (the has-error styling plus the retry
//   button) belongs to the asset-export flows, which arrive with F5.6; the bulk
//   trash operations clear the progress and raise a toast instead.
// - The stroke colours come from the shell tokens (--color-accent-*) rather
//   than from clr/new-primary & co., so the light and the dark theme both work
//   without reading the profile theme.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PROGRESS_BAR_WIDTH,
  clearProgress,
  initializeProgress,
  progressBarWidth,
  toggleProgressVisibility,
  updateProgress,
  type ProgressHints,
  type ProgressState,
} from "@/lib/progress";
import { tr } from "@/lib/i18n";

export interface ProgressApi {
  state: ProgressState | null;
  start: (params: { total: number; hints: ProgressHints }) => void;
  update: (index: number, total: number) => void;
  clear: () => void;
  toggleVisible: () => void;
}

const defaultValue: ProgressApi = {
  state: null,
  start: () => undefined,
  update: () => undefined,
  clear: () => undefined,
  toggleVisible: () => undefined,
};

const ProgressContext = createContext<ProgressApi>(defaultValue);

export function useProgress(): ProgressApi {
  return useContext(ProgressContext);
}

const BAR_PATH = "M0 0 L" + String(PROGRESS_BAR_WIDTH) + " 0";

function ProgressWidget({ state, onClose }: { state: ProgressState; onClose: () => void }) {
  const width = progressBarWidth(state);
  // The healthy flag picks the fill colour: primary while the events keep
  // arriving inside the threshold, warning once they slow down.
  const fillClass = state.healthy ? "pp-progress-fill is-healthy" : "pp-progress-fill is-slow";
  return (
    <div className="pp-progress-modal" role="status" aria-live="polite" data-testid="progress-modal">
      <span className="pp-progress-icon" aria-hidden="true">
        {"\u24d8"}
      </span>
      <div className="pp-progress-title">
        <div className="pp-progress-title-text">{state.hint}</div>
        <span className="pp-progress-count" data-testid="progress-count">
          {state.progress + " / " + state.total}
        </span>
      </div>
      <button
        type="button"
        className="pp-progress-close-button"
        aria-label={tr("labels.close")}
        data-testid="progress-close"
        onClick={onClose}
      >
        <span aria-hidden="true">{"\u00d7"}</span>
      </button>
      <svg
        className="pp-progress-bar"
        height={4}
        width={PROGRESS_BAR_WIDTH}
        aria-hidden="true"
        focusable="false"
      >
        <g>
          <path d={BAR_PATH} className="pp-progress-track" strokeWidth={30} />
          <path
            d={BAR_PATH}
            className={fillClass}
            strokeWidth={30}
            fill="transparent"
            strokeDasharray={PROGRESS_BAR_WIDTH}
            strokeDashoffset={PROGRESS_BAR_WIDTH - width}
            style={{ transition: "stroke-dashoffset 1s ease-in-out" }}
          />
        </g>
      </svg>
    </div>
  );
}

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProgressState | null>(null);

  const start = useCallback((params: { total: number; hints: ProgressHints }) => {
    setState(initializeProgress({ total: params.total, hints: params.hints }));
  }, []);

  const update = useCallback((index: number, total: number) => {
    setState((current) => updateProgress(current, { index, total }));
  }, []);

  const clear = useCallback(() => {
    setState(clearProgress());
  }, []);

  const toggleVisible = useCallback(() => {
    setState((current) => toggleProgressVisibility(current));
  }, []);

  const value = useMemo<ProgressApi>(
    () => ({ state, start, update, clear, toggleVisible }),
    [state, start, update, clear, toggleVisible],
  );

  return (
    <ProgressContext.Provider value={value}>
      {state !== null && state.visible ? (
        <ProgressWidget state={state} onClose={toggleVisible} />
      ) : null}
      {children}
    </ProgressContext.Provider>
  );
}
