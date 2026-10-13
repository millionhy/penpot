import { describe, expect, it } from "vitest";

import {
  animatePlans,
  findGoToFrame,
  planCloseOverlay,
  planGoToFrame,
  planOpenOverlay,
  type AnimationPlan,
  type AnimationTargets,
  type ViewerAnimations,
} from "@/lib/viewer-animations";
import type { InteractionAnimation } from "@/lib/viewer-interactions";

// The pure keyframe plans of the wasm viewer animations (the port of
// animate-go-to-frame / animate-open-overlay / animate-close-overlay). The
// wrapper is the max of the two viewport sizes, calculated by the caller.

const currentSize = { width: 100, height: 200 };
const origSize = { width: 300, height: 400 };
const wrapperSize = { width: 300, height: 400 };
const position = { x: 40, y: 60 };

function animation(
  value: Partial<InteractionAnimation> & Pick<InteractionAnimation, "animation-type">,
): InteractionAnimation {
  return { duration: 300, easing: "ease-in-out", ...value };
}

describe("findGoToFrame", () => {
  it("finds the navigation entry among overlay entries", () => {
    const entry = { kind: "go-to-frame" as const, origFrameId: "old", animation: animation({ "animation-type": "dissolve" }) };
    const animations: ViewerAnimations = {
      old: entry,
      overlay: { kind: "open-overlay", overlayFrameId: "overlay", animation: animation({ "animation-type": "dissolve" }) },
    };
    expect(findGoToFrame(animations)).toBe(entry);
  });

  it("answers null without one", () => {
    expect(findGoToFrame({})).toBeNull();
    expect(
      findGoToFrame({
        o: { kind: "close-overlay", overlayFrameId: "o", animation: animation({ "animation-type": "dissolve" }) },
      }),
    ).toBeNull();
  });
});

describe("planGoToFrame", () => {
  it("dissolves with the delayed three-keyframe fade of the origin", () => {
    const plans = planGoToFrame(
      animation({ "animation-type": "dissolve" }),
      currentSize,
      origSize,
      wrapperSize,
    );
    expect(plans).toEqual([
      {
        target: "orig",
        keyframes: [{ opacity: "100%" }, { opacity: "0%" }, { opacity: "0%" }],
        duration: 200,
        delay: 100,
        easing: "ease-in-out",
        finish: false,
      },
      {
        target: "current",
        keyframes: [{ opacity: "0%" }, { opacity: "100%" }, { opacity: "100%" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });

  it("slides in from the entry side with the current-size offset", () => {
    // offset = 100 + (300 - 100) / 2 = 200
    const plans = planGoToFrame(
      animation({ "animation-type": "slide", way: "in", direction: "right" }),
      currentSize,
      origSize,
      wrapperSize,
    );
    expect(plans).toEqual([
      {
        target: "current",
        keyframes: [{ left: "-200px" }, { left: "0" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });

  it("nudges the origin out with the offset effect", () => {
    const plans = planGoToFrame(
      animation({ "animation-type": "slide", way: "in", direction: "up", "offset-effect": true }),
      currentSize,
      origSize,
      wrapperSize,
    );
    // offset = 200 + (400 - 200) / 2 = 300
    expect(plans).toEqual([
      {
        target: "current",
        keyframes: [{ bottom: "-300px" }, { bottom: "0" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
      {
        target: "orig",
        keyframes: [
          { bottom: "0", opacity: "100%" },
          { bottom: "60px", opacity: "0" },
        ],
        duration: 300,
        easing: "ease-in-out",
        finish: false,
      },
    ]);
  });

  it("slides out over the current viewport with the origin-size offset", () => {
    // offset = 300 + (300 - 300) / 2 = 300
    const plans = planGoToFrame(
      animation({ "animation-type": "slide", way: "out", direction: "left" }),
      currentSize,
      origSize,
      wrapperSize,
    );
    expect(plans).toEqual([
      {
        target: "orig",
        keyframes: [{ left: "0" }, { left: "-300px" }],
        duration: 300,
        easing: "ease-in-out",
        raiseOrig: true,
        finish: true,
      },
    ]);
  });

  it("pushes both viewports by the wrapper size", () => {
    const plans = planGoToFrame(
      animation({ "animation-type": "push", direction: "down" }),
      currentSize,
      origSize,
      wrapperSize,
    );
    expect(plans).toEqual([
      {
        target: "current",
        keyframes: [{ top: "-400px" }, { top: "0" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
      {
        target: "orig",
        keyframes: [{ top: "0" }, { top: "400px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: false,
      },
    ]);
  });

  it("answers no plans for a slide without a direction", () => {
    expect(
      planGoToFrame(animation({ "animation-type": "slide", way: "in" }), currentSize, origSize, wrapperSize),
    ).toEqual([]);
  });
});

describe("planOpenOverlay", () => {
  it("fades the overlay in", () => {
    expect(planOpenOverlay(animation({ "animation-type": "dissolve" }), currentSize, position, wrapperSize)).toEqual([
      {
        target: "overlay",
        keyframes: [{ opacity: "0%" }, { opacity: "100%" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });

  it("slides the overlay in from the named side", () => {
    expect(
      planOpenOverlay(animation({ "animation-type": "slide", direction: "right" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ left: "-100px" }, { left: "40px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
    expect(
      planOpenOverlay(animation({ "animation-type": "slide", direction: "left" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ left: "300px" }, { left: "40px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
    expect(
      planOpenOverlay(animation({ "animation-type": "slide", direction: "up" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ top: "400px" }, { top: "60px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
    expect(
      planOpenOverlay(animation({ "animation-type": "slide", direction: "down" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ top: "-200px" }, { top: "60px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });

  it("ignores a push (the CLJS overlay variants would throw)", () => {
    expect(
      planOpenOverlay(animation({ "animation-type": "push", direction: "right" }), currentSize, position, wrapperSize),
    ).toEqual([]);
  });
});

describe("planCloseOverlay", () => {
  it("fades the overlay out and finishes the close", () => {
    expect(planCloseOverlay(animation({ "animation-type": "dissolve" }), currentSize, position, wrapperSize)).toEqual([
      {
        target: "overlay",
        keyframes: [{ opacity: "100%" }, { opacity: "0%" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });

  it("rewinds a slide to the side the overlay entered from", () => {
    expect(
      planCloseOverlay(animation({ "animation-type": "slide", direction: "right" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ left: "40px" }, { left: "300px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
    expect(
      planCloseOverlay(animation({ "animation-type": "slide", direction: "up" }), currentSize, position, wrapperSize),
    ).toEqual([
      {
        target: "overlay",
        keyframes: [{ top: "60px" }, { top: "-200px" }],
        duration: 300,
        easing: "ease-in-out",
        finish: true,
      },
    ]);
  });
});

describe("animatePlans", () => {
  interface FakeAnimation {
    options: KeyframeAnimationOptions;
    keyframes: Record<string, string>[];
    onfinish: (() => void) | null;
  }

  function fakeElement(calls: FakeAnimation[], zIndex: string[]): HTMLElement {
    return {
      style: {
        setProperty: (name: string, value: string) => {
          if (name === "z-index") zIndex.push(value);
        },
      },
      animate: (keyframes: Record<string, string>[], options: KeyframeAnimationOptions) => {
        const call: FakeAnimation = { keyframes, options, onfinish: null };
        calls.push(call);
        return {
          set onfinish(fn: (() => void) | null) {
            call.onfinish = fn;
          },
        };
      },
    } as unknown as HTMLElement;
  }

  it("reroutes the plans to their targets and only finishes once", () => {
    const current: FakeAnimation[] = [];
    const orig: FakeAnimation[] = [];
    const zIndex: string[] = [];
    let finished = 0;
    const plans = planGoToFrame(
      animation({ "animation-type": "slide", way: "out", direction: "right" }),
      currentSize,
      origSize,
      wrapperSize,
    );
    const targets: AnimationTargets = {
      current: fakeElement(current, zIndex),
      orig: fakeElement(orig, zIndex),
      overlay: null,
    };
    animatePlans(targets, plans, () => {
      finished += 1;
    });
    expect(current).toHaveLength(0);
    expect(orig).toHaveLength(1);
    expect(zIndex).toEqual(["10000"]);
    expect(orig[0].options).toEqual({ duration: 300, easing: "ease-in-out" });
    orig[0].onfinish?.();
    expect(finished).toBe(1);
  });

  it("skips the plans of a missing target", () => {
    const calls: FakeAnimation[] = [];
    const plans: AnimationPlan[] = [
      { target: "overlay", keyframes: [{ opacity: "0%" }], duration: 100, finish: true },
    ];
    animatePlans({ overlay: undefined }, plans, () => {
      throw new Error("unexpected finish");
    });
    expect(calls).toHaveLength(0);
  });
});
