// The ruler band of app.render-wasm.api (G4.2). The rulers draw inside the
// canvas surface, so every setter is a plain FFI call behind the `live?`
// guard plus, at the caller, a render request. Booleans travel as 1/0 and a
// null selection travels as the disabled block, exactly like the compiled
// bodies.
//
// sync-rulers-to-wasm! is the store-driven entry point: it pushes the theme
// colors once (unless told not to), then the visibility, the tick offset and
// the selection band. The offset and the band are only pushed while the
// rulers are shown, matching the compiled conditional.

import { call } from "./call";
import { hexToArgbU32 } from "./colors";
import { live, type RenderWasmModule } from "./module";

export interface RulerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RulerTheme {
  bg: string;
  border: string;
  label: string;
  accent: string;
}

export interface RulerState {
  showRulers: boolean;
  frameVisible: boolean;
  offsetX: number | null;
  offsetY: number | null;
  selection: RulerRect | null;
  // false skips the theme push (the compiled default is true).
  pushColors?: boolean;
}

export function setRulersVisible(module: RenderWasmModule, visible: boolean): boolean {
  if (!live()) return false;
  call(module, "_set_rulers_visible", visible ? 1 : 0);
  return true;
}

export function setRulersFrameVisible(
  module: RenderWasmModule,
  visible: boolean,
): boolean {
  if (!live()) return false;
  call(module, "_set_rulers_frame_visible", visible ? 1 : 0);
  return true;
}

export function setRulersOffsets(
  module: RenderWasmModule,
  offsetX: number | null | undefined,
  offsetY: number | null | undefined,
): boolean {
  if (!live()) return false;
  call(module, "_set_rulers_offsets", offsetX ?? 0, offsetY ?? 0);
  return true;
}

// The compiled body has two arities: an enabled block with the rect, or a
// disabled block of five zeros.
export function setRulersSelection(
  module: RenderWasmModule,
  rect: RulerRect | null,
): boolean {
  if (!live()) return false;
  if (rect === null) {
    call(module, "_set_rulers_selection", 0, 0, 0, 0, 0);
  } else {
    call(
      module,
      "_set_rulers_selection",
      1,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );
  }
  return true;
}

// set-rulers-colors!: hex strings to the ARGB words the renderer stores. The
// compiled effect calls this once on theme change, not per frame.
export function setRulersColors(module: RenderWasmModule, theme: RulerTheme): boolean {
  if (!live()) return false;
  call(
    module,
    "_set_rulers_colors",
    hexToArgbU32(theme.bg, 1),
    hexToArgbU32(theme.border, 1),
    hexToArgbU32(theme.label, 1),
    hexToArgbU32(theme.accent, 1),
  );
  return true;
}

// sync-rulers-to-wasm!. `theme` is required only when the colors are pushed;
// the caller resolves it from the CSS custom properties (the compiled code
// logs and skips the push when the palette is missing).
export function syncRulers(
  module: RenderWasmModule,
  state: RulerState,
  theme?: RulerTheme,
): void {
  if (state.pushColors !== false && theme !== undefined) {
    setRulersColors(module, theme);
  }
  setRulersFrameVisible(module, state.frameVisible);
  setRulersVisible(module, state.showRulers);
  if (state.showRulers) {
    setRulersOffsets(module, state.offsetX, state.offsetY);
    setRulersSelection(module, state.selection);
  }
}