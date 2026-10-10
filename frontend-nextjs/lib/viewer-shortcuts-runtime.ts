// Viewer shortcut runtime (F6.3): the registry -> matcher bindings
// construction, the keydown dispatch and the wheel-zoom decision. The
// matcher itself lives in lib/shortcuts.
//
// Port of the mounting point of hooks/use-shortcuts in viewer.cljs
// (`use-shortcuts ::viewer sc/shortcuts :viewer`) and of the wheel handler
// of app.main.ui.viewer.interactions/viewport*.
//
// Deviations from the CLJS original, documented:
// - The CLJS matcher binds once per group and its :fn closures emit events
//   into the store; the shell page rebuilds the matcher when its state
//   changes (the bindings in page.tsx), which keeps the handlers fresh the
//   same way. The mounting gate mirrors viewer-content*: active once the
//   bundle is loaded.
// - The wheel listener mounts only while the loaded viewer shows a frame,
//   where the CLJS viewport* mounts; with an empty page there is no
//   viewport to zoom. The mod probe resolves at mount (kbd/mod?: meta on
//   mac, ctrl elsewhere).

import {
  eventToMousetrapCommand,
  applyCustomOverrides,
  type CustomShortcuts,
  type ShortcutBinding,
  type ShortcutKeyEvent,
  type ShortcutMatcher,
  type ShortcutTarget,
} from "@/lib/shortcuts";
import {
  runViewerShortcut,
  unmigratedViewerShortcuts,
  viewerShortcuts,
  type ViewerShortcutActions,
  type ViewerShortcutKey,
} from "@/lib/viewer-shortcuts";

// The registry as matcher bindings, with the :viewer group overrides applied
// (the CLJS mounts the set under that group key). The unmigrated shortcuts
// are filtered out so their default commands keep their native browser
// behaviour. A command cleared to "" stays in the binding:
// canonicalCommands("") yields no combos, so the matcher never fires it.
export function buildViewerBindings(
  macos: boolean,
  customs: CustomShortcuts | null | undefined,
  actions: ViewerShortcutActions,
): ShortcutBinding[] {
  const definitions = applyCustomOverrides(viewerShortcuts(macos), customs, "viewer");
  return Object.entries(definitions)
    .filter(([key]) => !(unmigratedViewerShortcuts as readonly string[]).includes(key))
    .map(([key, definition]) => ({
      command: definition.command,
      run: () => runViewerShortcut(key as ViewerShortcutKey, actions),
    }));
}

// The event target in the shape the matcher's stop guard reads (mousetrap
// stopCallback), like the dashboard provider: html targets only, svg and
// text targets never stop.
export function viewerShortcutTarget(event: KeyboardEvent): ShortcutTarget | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return {
    tagName: target.tagName,
    className: target.className,
    contentEditable: target.contentEditable,
    dataset: target.dataset,
  };
}

// One keydown -> one mousetrap combo handed to the matcher. Returns whether
// an action ran; the caller preventDefaults on true, like wrap-cb does.
// Standalone modifier presses produce no combo and are ignored.
export function dispatchViewerKeydown(
  matcher: ShortcutMatcher,
  event: ShortcutKeyEvent,
  macos: boolean,
  target?: ShortcutTarget | null,
): boolean {
  const combo = eventToMousetrapCommand(event, macos);
  if (combo === null) return false;
  return matcher.handle(combo, target);
}

// kbd/mod?: meta on mac, ctrl everywhere else.
export function isWheelZoomMod(
  macos: boolean,
  event: { ctrlKey?: boolean; metaKey?: boolean },
): boolean {
  return macos ? event.metaKey === true : event.ctrlKey === true;
}

// viewport* on-mouse-wheel: the vertical and horizontal deltas add up;
// a positive delta zooms out, every other value (including zero) zooms in.
export function wheelZoomDirection(deltaY: number, deltaX: number): "increase" | "decrease" {
  return deltaY + deltaX > 0 ? "decrease" : "increase";
}
