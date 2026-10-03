import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOW_PROGRESS_THRESHOLD,
  PROGRESS_BAR_WIDTH,
  clearProgress,
  initializeProgress,
  progressBarWidth,
  toggleProgressVisibility,
  updateProgress,
  type ProgressHints,
} from "@/lib/progress";

// The CLJS hint functions are thunks over tr; the counter records which one the
// machine picked.
interface HintSpy {
  hints: ProgressHints;
  calls: { normal: number; slow: number };
}

function hints(): HintSpy {
  const calls = { normal: 0, slow: 0 };
  return {
    calls,
    hints: {
      progress: () => {
        calls.normal += 1;
        return "restoring";
      },
      slow: () => {
        calls.slow += 1;
        return "slow";
      },
    },
  };
}

// A four-file restore, freshly initialized.
const base = () => initializeProgress({ total: 4, hints: hints().hints, now: 1000 });

describe("initializeProgress", () => {
  it("starts healthy, visible and at zero with the normal hint", () => {
    const { hints: hintFns, calls } = hints();
    const state = initializeProgress({ total: 3, hints: hintFns, now: 1000 });
    expect(state.threshold).toBe(DEFAULT_SLOW_PROGRESS_THRESHOLD);
    expect(state.lastUpdate).toBe(1000);
    expect(state.healthy).toBe(true);
    expect(state.visible).toBe(true);
    expect(state.progress).toBe(0);
    expect(state.total).toBe(3);
    expect(state.hint).toBe("restoring");
    expect(calls.normal).toBe(1);
  });

  it("takes the initial index and a custom threshold when given", () => {
    const state = initializeProgress({
      total: 5,
      index: 2,
      threshold: 250,
      hints: hints().hints,
      now: 0,
    });
    expect(state.progress).toBe(2);
    expect(state.threshold).toBe(250);
  });
});

describe("updateProgress", () => {
  it("stays healthy while events arrive inside the threshold", () => {
    const state = base();
    const next = updateProgress(state, { index: 1, total: 4, now: 1500 });
    expect(next?.healthy).toBe(true);
    expect(next?.hint).toBe("restoring");
    expect(next?.progress).toBe(1);
    expect(next?.lastUpdate).toBe(1500);
  });

  it("flips to the slow hint once an event takes longer than the threshold", () => {
    const { hints: hintFns, calls } = hints();
    const state = initializeProgress({ total: 4, hints: hintFns, now: 1000 });
    const next = updateProgress(state, {
      index: 1,
      total: 4,
      now: 1000 + DEFAULT_SLOW_PROGRESS_THRESHOLD,
    });
    // The CLJS comparison is strict: exactly the threshold is already slow.
    expect(next?.healthy).toBe(false);
    expect(next?.hint).toBe("slow");
    expect(calls.slow).toBe(1);
  });

  it("is a no-op before the flow was initialized", () => {
    expect(updateProgress(null, { index: 1, total: 4 })).toBeNull();
  });

  it("keeps the visibility the user chose", () => {
    const hidden = toggleProgressVisibility(base());
    const next = updateProgress(hidden, { index: 2, total: 4, now: 1100 });
    expect(next?.visible).toBe(false);
  });
});

describe("toggleProgressVisibility", () => {
  it("flips the flag and tolerates a cleared state", () => {
    const state = initializeProgress({ total: 2, hints: hints().hints, now: 0 });
    expect(toggleProgressVisibility(state)?.visible).toBe(false);
    expect(toggleProgressVisibility(toggleProgressVisibility(state))?.visible).toBe(true);
    expect(toggleProgressVisibility(null)).toBeNull();
  });
});

describe("clearProgress", () => {
  it("dissoc's the slice", () => {
    expect(clearProgress()).toBeNull();
  });
});

describe("progressBarWidth", () => {
  it("scales the 280px stroke by progress over total", () => {
    const state = base();
    expect(progressBarWidth(state)).toBe(0);
    expect(progressBarWidth(updateProgress(state, { index: 2, total: 4, now: 0 })!)).toBe(
      PROGRESS_BAR_WIDTH / 2,
    );
    expect(progressBarWidth(updateProgress(state, { index: 4, total: 4, now: 0 })!)).toBe(
      PROGRESS_BAR_WIDTH,
    );
  });

  it("fills the bar when the total is zero instead of dividing by it", () => {
    const state = initializeProgress({ total: 0, hints: hints().hints, now: 0 });
    expect(progressBarWidth(state)).toBe(PROGRESS_BAR_WIDTH);
  });
});
