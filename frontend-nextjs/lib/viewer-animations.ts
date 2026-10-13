// Viewer animations (F6.5): the WAAPI keyframe plans of the wasm viewer,
// the port of animate-go-to-frame / animate-open-overlay /
// animate-close-overlay in app.main.ui.viewer.interactions, of the two
// animation effects in app.main.ui.viewer and of the :viewer-animations
// map in app.main.data.viewer.
//
// The plan builders are pure: they answer the keyframes plus the timing for
// every target element (the current viewport container, the origin viewport
// container, the overlay container). The caller resolves the targets and
// runs the plans through animatePlans, which mirrors dom/animate!
// (app.util.dom). Kept free of JSX so it runs in vitest's node environment,
// like lib/viewer-interactions.ts; only animatePlans touches the DOM, and
// only when a component calls it.
//
// Deviations from the CLJS original, documented:
// - The sizes arrive from the renderers' bounds reports (the padded bounds
//   the blit viewports measure, times the zoom) instead of a synchronous
//   calculate-size over the decoded page; the wrapper reserves the max of
//   the two like calculate-wrapper.
// - The overlay size is measured on the rendered container (the reported
//   padded bounds, or the selrect stand-in), where the CLJS calculates it
//   from the decoded page before the overlay paints.
// - every opacity keyframe uses percentages ("0%" / "100%").
// - A slide without a direction, or an animation-type the viewport variants
//   of the CLJS would throw on (push overlays), answers no plans; missing
//   duration / easing (the schema marks both required) fall back to a 0 ms
//   animation with default easing.

import type { InteractionAnimation, Point } from "./viewer-interactions";

// The :viewer-animations map of data/viewer.cljs: one pending animation per
// frame id. go-to-frame holds the frame being left (orig-frame-id); the
// overlay kinds hold the overlay frame being shown or rewinded.
export type ViewerAnimationEntry =
  | { kind: "go-to-frame"; origFrameId: string; animation: InteractionAnimation }
  | { kind: "open-overlay"; overlayFrameId: string; animation: InteractionAnimation }
  | { kind: "close-overlay"; overlayFrameId: string; animation: InteractionAnimation };

export type ViewerAnimations = Record<string, ViewerAnimationEntry>;

// The overlay half of the map (the entries the overlay effect animates).
export type OverlayAnimationEntry = Extract<
  ViewerAnimationEntry,
  { kind: "open-overlay" | "close-overlay" }
>;

// (d/seek #(= (:kind %) :go-to-frame) (vals current-animations)).
export function findGoToFrame(
  animations: ViewerAnimations,
): Extract<ViewerAnimationEntry, { kind: "go-to-frame" }> | null {
  for (const entry of Object.values(animations)) {
    if (entry.kind === "go-to-frame") return entry;
  }
  return null;
}

// calculate-size shorn of the design-space origin: the on-screen (zoomed)
// width / height the keyframes move.
export interface AnimationSize {
  width: number;
  height: number;
}

// The element a plan animates: the current viewport container, the origin
// container below it, or the overlay container.
export type AnimationTarget = "current" | "orig" | "overlay";

export interface AnimationPlan {
  target: AnimationTarget;
  keyframes: Record<string, string>[];
  duration: number;
  delay?: number;
  easing?: string;
  // animate-go-to-frame :slide :out raises the origin above the current
  // viewport first (dom/set-css-property! orig-viewport "z-index" 10000).
  raiseOrig?: boolean;
  // Attach the completion callback: dv/complete-animation, and for a close
  // also the overlay drop (the rewind finishes before the list changes).
  finish: boolean;
}

type Direction = NonNullable<InteractionAnimation["direction"]>;

// The CSS property the current viewport slides along: entering from a side
// anchors the opposite edge (animate-go-to-frame :slide :in / :push).
function oppositeProp(direction: Direction): string {
  switch (direction) {
    case "right":
      return "left";
    case "left":
      return "right";
    case "up":
      return "bottom";
    case "down":
      return "top";
  }
}

function axisSize(direction: Direction, size: AnimationSize): number {
  return direction === "right" || direction === "left" ? size.width : size.height;
}

function timing(animation: InteractionAnimation): {
  duration: number;
  easing?: string;
} {
  const duration = animation.duration ?? 0;
  return animation.easing !== undefined && animation.easing !== ""
    ? { duration, easing: animation.easing }
    : { duration };
}

// animate-go-to-frame: the navigation between two frames. The dissolve
// waits until the incoming frame has painted before the outgoing one fades
// (the three keyframes of the CLJS); the slide and push move the two
// containers against each other, with the optional offset effect nudging
// the other side.
export function planGoToFrame(
  animation: InteractionAnimation,
  currentSize: AnimationSize,
  origSize: AnimationSize,
  wrapperSize: AnimationSize,
): AnimationPlan[] {
  const { duration, easing } = timing(animation);

  switch (animation["animation-type"]) {
    case "dissolve": {
      return [
        {
          target: "orig",
          keyframes: [{ opacity: "100%" }, { opacity: "0%" }, { opacity: "0%" }],
          duration: (duration * 2) / 3,
          delay: duration / 3,
          easing,
          finish: false,
        },
        {
          target: "current",
          keyframes: [{ opacity: "0%" }, { opacity: "100%" }, { opacity: "100%" }],
          duration,
          easing,
          finish: true,
        },
      ];
    }

    case "slide": {
      const direction = animation.direction;
      if (direction === undefined) return [];
      if (animation.way === "out") {
        const offset =
          axisSize(direction, origSize) +
          (axisSize(direction, wrapperSize) - axisSize(direction, origSize)) / 2;
        const prop = direction;
        const plans: AnimationPlan[] = [
          {
            target: "orig",
            keyframes: [{ [prop]: "0" }, { [prop]: "-" + offset + "px" }],
            duration,
            easing,
            raiseOrig: true,
            finish: true,
          },
        ];
        if (animation["offset-effect"] === true) {
          plans.push({
            target: "current",
            keyframes: [
              { [prop]: offset * 0.2 + "px", opacity: "0" },
              { [prop]: "0", opacity: "100%" },
            ],
            duration,
            easing,
            finish: false,
          });
        }
        return plans;
      }
      const offset =
        axisSize(direction, currentSize) +
        (axisSize(direction, wrapperSize) - axisSize(direction, currentSize)) / 2;
      const prop = oppositeProp(direction);
      const plans: AnimationPlan[] = [
        {
          target: "current",
          keyframes: [{ [prop]: "-" + offset + "px" }, { [prop]: "0" }],
          duration,
          easing,
          finish: true,
        },
      ];
      if (animation["offset-effect"] === true) {
        plans.push({
          target: "orig",
          keyframes: [
            { [prop]: "0", opacity: "100%" },
            { [prop]: offset * 0.2 + "px", opacity: "0" },
          ],
          duration,
          easing,
          finish: false,
        });
      }
      return plans;
    }

    case "push": {
      const direction = animation.direction;
      if (direction === undefined) return [];
      const offset = axisSize(direction, wrapperSize);
      const prop = oppositeProp(direction);
      return [
        {
          target: "current",
          keyframes: [{ [prop]: "-" + offset + "px" }, { [prop]: "0" }],
          duration,
          easing,
          finish: true,
        },
        {
          target: "orig",
          keyframes: [{ [prop]: "0" }, { [prop]: offset + "px" }],
          duration,
          easing,
          finish: false,
        },
      ];
    }

    default:
      return [];
  }
}

// animate-open-overlay: the overlay slides or fades in from the side its
// direction names (a :right overlay enters from the left edge). The way and
// the offset effect are ignored, like the CLJS.
export function planOpenOverlay(
  animation: InteractionAnimation,
  overlaySize: AnimationSize,
  overlayPosition: Point,
  wrapperSize: AnimationSize,
): AnimationPlan[] {
  const { duration, easing } = timing(animation);

  switch (animation["animation-type"]) {
    case "dissolve": {
      return [
        {
          target: "overlay",
          keyframes: [{ opacity: "0%" }, { opacity: "100%" }],
          duration,
          easing,
          finish: true,
        },
      ];
    }

    case "slide": {
      const direction = animation.direction;
      if (direction === undefined) return [];
      switch (direction) {
        case "right":
          return [openPlan("-" + overlaySize.width + "px", "left", overlayPosition.x, duration, easing)];
        case "left":
          return [openPlan(wrapperSize.width + "px", "left", overlayPosition.x, duration, easing)];
        case "up":
          return [openPlan(wrapperSize.height + "px", "top", overlayPosition.y, duration, easing)];
        case "down":
          return [openPlan("-" + overlaySize.height + "px", "top", overlayPosition.y, duration, easing)];
      }
    }

    default:
      return [];
  }
}

function openPlan(
  from: string,
  prop: string,
  to: number,
  duration: number,
  easing: string | undefined,
): AnimationPlan {
  return {
    target: "overlay",
    keyframes: [{ [prop]: from }, { [prop]: to + "px" }],
    duration,
    easing,
    finish: true,
  };
}

// animate-close-overlay: the rewind of the open, leaving by the same side it
// entered from; the finish also drops the overlay (dv/close-overlay).
export function planCloseOverlay(
  animation: InteractionAnimation,
  overlaySize: AnimationSize,
  overlayPosition: Point,
  wrapperSize: AnimationSize,
): AnimationPlan[] {
  const { duration, easing } = timing(animation);

  switch (animation["animation-type"]) {
    case "dissolve": {
      return [
        {
          target: "overlay",
          keyframes: [{ opacity: "100%" }, { opacity: "0%" }],
          duration,
          easing,
          finish: true,
        },
      ];
    }

    case "slide": {
      const direction = animation.direction;
      if (direction === undefined) return [];
      switch (direction) {
        case "right":
          return [closePlan(overlayPosition.x, "left", wrapperSize.width + "px", duration, easing)];
        case "left":
          return [closePlan(overlayPosition.x, "left", "-" + overlaySize.width + "px", duration, easing)];
        case "up":
          return [closePlan(overlayPosition.y, "top", "-" + overlaySize.height + "px", duration, easing)];
        case "down":
          return [closePlan(overlayPosition.y, "top", wrapperSize.height + "px", duration, easing)];
      }
    }

    default:
      return [];
  }
}

function closePlan(
  from: number,
  prop: string,
  to: string,
  duration: number,
  easing: string | undefined,
): AnimationPlan {
  return {
    target: "overlay",
    keyframes: [{ [prop]: from + "px" }, { [prop]: to }],
    duration,
    easing,
    finish: true,
  };
}

// The containers a run animates; a missing target skips its plans, like the
// (when (some? ...)) guards of the CLJS.
export interface AnimationTargets {
  current?: HTMLElement | null;
  orig?: HTMLElement | null;
  overlay?: HTMLElement | null;
}

// dom/animate! (app.util.dom): element.animate(keyframes, {duration, delay,
// easing}) with the onfinish wiring.
export function animatePlans(
  targets: AnimationTargets,
  plans: AnimationPlan[],
  onFinish?: () => void,
): void {
  for (const plan of plans) {
    const element = targets[plan.target];
    if (element === undefined || element === null) continue;
    if (plan.raiseOrig === true) element.style.setProperty("z-index", "10000");
    const options: KeyframeAnimationOptions = { duration: plan.duration };
    if (plan.delay !== undefined) options.delay = plan.delay;
    if (plan.easing !== undefined) options.easing = plan.easing;
    const running = element.animate(plan.keyframes, options);
    if (plan.finish && onFinish !== undefined) running.onfinish = () => onFinish();
  }
}
