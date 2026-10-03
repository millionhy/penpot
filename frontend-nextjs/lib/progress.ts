// Bulk-operation progress (F5.3). The pure half of the :progress store slice
// that dcm/initialize-progress, dcm/update-progress,
// dcm/toggle-progress-visibility and dcm/clear-progress maintain in
// frontend/src/app/main/data/common.cljs, plus the bar geometry of
// app.main.ui.components.progress/progress-notification-widget*.
//
// Kept free of JSX so vitest can run it in a node environment; the widget lives
// in components/progress-notification.tsx.
//
// Deviation from the CLJS original, documented: update-progress reads
// (:slow-progress-threshold state), a key initialize-progress never stores (it
// writes :threshold), so the comparison against nil always reports "slow"
// after the first event. This port uses the threshold that was stored, which is
// what the constant mconst/default-slow-progress-threshold is there for.

// mconst/default-slow-progress-threshold (app.main.constants).
export const DEFAULT_SLOW_PROGRESS_THRESHOLD = 1000;

// The bar is a 280px stroke whose dashoffset the widget animates.
export const PROGRESS_BAR_WIDTH = 280;

// The {:progress ...} / {:slow ...} hint functions of initialize-progress. The
// CLJS ones are thunks over tr; the shell passes the snapshot so a hint can
// interpolate the counters when a locale needs it.
export interface ProgressSnapshot {
  index: number;
  total: number;
}

export interface ProgressHints {
  progress: (snapshot: ProgressSnapshot) => string;
  slow: (snapshot: ProgressSnapshot) => string;
}

export interface ProgressState {
  threshold: number;
  // Epoch ms of the last event, the (ct/now) of initialize/update-progress.
  lastUpdate: number;
  healthy: boolean;
  visible: boolean;
  progress: number;
  total: number;
  hint: string;
  hints: ProgressHints;
}

export interface InitializeProgressParams {
  total: number;
  index?: number;
  threshold?: number;
  hints: ProgressHints;
  // Injectable so the machine stays testable.
  now?: number;
}

export function initializeProgress(params: InitializeProgressParams): ProgressState {
  const progress = params.index ?? 0;
  const snapshot = { index: progress, total: params.total };
  return {
    threshold: params.threshold ?? DEFAULT_SLOW_PROGRESS_THRESHOLD,
    lastUpdate: params.now ?? Date.now(),
    healthy: true,
    visible: true,
    progress,
    total: params.total,
    hint: params.hints.progress(snapshot),
    hints: params.hints,
  };
}

export interface UpdateProgressParams {
  index: number;
  total: number;
  now?: number;
}

// A stream event that arrives before initialize is a no-op, which is what
// (update nil ...) would produce in the store.
export function updateProgress(
  state: ProgressState | null,
  params: UpdateProgressParams,
): ProgressState | null {
  if (state === null) return null;
  const now = params.now ?? Date.now();
  const healthy = now - state.lastUpdate < state.threshold;
  const snapshot = { index: params.index, total: params.total };
  return {
    ...state,
    progress: params.index,
    total: params.total,
    lastUpdate: now,
    healthy,
    hint: healthy ? state.hints.progress(snapshot) : state.hints.slow(snapshot),
  };
}

// Closing the widget keeps the counters running, so reopening is not possible
// but the operation still finishes and clears itself.
export function toggleProgressVisibility(state: ProgressState | null): ProgressState | null {
  if (state === null) return null;
  return { ...state, visible: !state.visible };
}

export function clearProgress(): null {
  return null;
}

// pwidth in progress-notification-widget*: the filled length of the bar.
export function progressBarWidth(state: ProgressState): number {
  if (state.total <= 0) return PROGRESS_BAR_WIDTH;
  return (state.progress * PROGRESS_BAR_WIDTH) / state.total;
}
