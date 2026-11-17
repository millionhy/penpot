"use client";

// The inspect section of the viewer (D23). Port of
// app.main.ui.viewer.inspect with the data side of
// app.main.ui.inspect.{left-sidebar, selection-feedback, right-sidebar,
// attributes}: the layer tree, the frame canvas with its selection overlay
// and the computed panel of the right sidebar.
//
// The frame paints through ViewerWasmViewport (F6.4), the canvas of the
// interactions section. The shell has no shape renderer, so the overlay
// draws invisible hit rectangles over the selection box and the size label;
// the layer tree, the right sidebar and the copy buttons drive the rest.
//
// The selection overlay works in world units: the SVG viewBox is the padded
// frame box the canvas reports (the comments layer pattern, see
// viewer-comments-layer.tsx), and a group translates the shapes by the box
// origin. Stroke widths and type sizes divide by the zoom so they keep one
// screen pixel.
//
// Deviations from the CLJS original, documented:
// - The Styles and Code tabs are D24. The sidebar opens on Computed, not on
//   Styles (the CLJS default with the :inspect-styles flag), keeps the tab
//   control with the two pending entries disabled, and never resizes.
// - The annotations and the exports block of the attributes panel are not
//   ported: the shell bundle carries no component annotations and the export
//   pipeline is a workspace feature (D24).
// - The measurement guides of selection-feedback (the dashed guides and the
//   distance pills between the hovered and the selected shape) are D24. The
//   selection box, the hover box and the size label are present.
// - Hit testing uses the shape selrect as the pointer target, so a rotated
//   shape answers over its bounding box, and the topmost shape of the paint
//   order wins. Groups and the root frame take no pointer events, like the
//   CLJS handlers.
// - The layer rows start their indentation at depth 0, the CLJS passes -2
//   into layer-item (the frame row lands at -1) and clamps the alignment in
//   CSS.
// - The viewer pagination paints inside the centre pane, not at the outer
//   edges of the left and right bars (ViewerPagination has no left-bar /
//   right-bar variants in the shell).
// - The empty state drops the two icons (the shell has no help icon) and
//   keeps the texts and the help link.
// - Clicking the canvas toggles data-force-visible for parity with
//   handle-select-frame; the shell header never hides, so no rule reads it
//   (F6.3 keeps .pp-force-visible unused).

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

import {
  BoardIcon,
  ChevronIcon,
  CurveIcon,
  EllipseIcon,
  GroupIcon,
  ImageIcon,
  LineIcon,
  PathIcon,
  RectangleIcon,
  TextIcon,
} from "@/components/workspace-icons";
import {
  ClipboardIcon,
  ComponentCopyIcon,
  ComponentIcon,
  LayersIcon,
  MaskedIcon,
  TickIcon,
  VariantIcon,
} from "@/components/viewer-icons";
import { ViewerPagination } from "@/components/viewer-pagination";
import { ViewerWasmViewport, type ViewerWasmBounds } from "@/components/viewer-wasm-viewport";
import { lookupCustomFont } from "@/lib/fonts";
import { tr } from "@/lib/i18n";
import {
  allShapeIds,
  buildInspectSections,
  expandRegionSelection,
  inspectShapeIcon,
  inspectSubtitle,
  inspectTreeIds,
  inspectTreeRows,
  isRootFrame,
  resolveShapes,
  shapeName,
  unionSelrect,
  type InspectRow,
  type InspectSection,
  type InspectShapeIcon,
  type InspectTreeRow,
} from "@/lib/inspect";
import { formatNumber, type InspectColorFormat } from "@/lib/inspect-css";
import type { ViewerObjects, ViewerShape } from "@/lib/viewer";

// The hit list of the canvas, in paint order: every shape under the frame
// except the groups and the root frame, which take no pointer events in the
// CLJS renderer either.
function collectHitShapes(frame: ViewerShape, objects: ViewerObjects): ViewerShape[] {
  const shapes: ViewerShape[] = [];

  const visit = (shape: ViewerShape): void => {
    for (const childId of shape.shapes ?? []) {
      const child = objects[childId];
      if (child !== undefined && child !== null) visit(child);
    }
    if (shape.id === frame.id || isRootFrame(shape)) return;
    if (shape.type === "group" || shape.type === "bool") return;
    if (shape["hidden"] === true) return;
    if (shape.selrect === undefined) return;
    shapes.push(shape);
  };

  visit(frame);
  return shapes;
}

// The glyph of a tree row and of the shape info, from the icon set of the
// shell (inspectShapeIcon maps the CLJS icon ids onto these names).
function InspectShapeGlyph({ icon }: { icon: InspectShapeIcon }) {
  switch (icon) {
    case "board":
      return <BoardIcon />;
    case "group":
      return <GroupIcon />;
    case "mask":
      return <MaskedIcon />;
    case "rect":
      return <RectangleIcon />;
    case "ellipse":
      return <EllipseIcon />;
    case "line":
      return <LineIcon />;
    case "text":
      return <TextIcon />;
    case "image":
      return <ImageIcon />;
    case "curve":
      return <CurveIcon />;
    case "component":
      return <ComponentIcon />;
    case "component-copy":
      return <ComponentCopyIcon />;
    case "variant":
      return <VariantIcon />;
    case "path":
    default:
      return <PathIcon />;
  }
}

// copy-button*: the value doubles as the button, the icon appears on hover
// and turns into a tick for a second after the copy.
function InspectCopyButton({
  data,
  label,
  className,
  children,
}: {
  data: string | null | undefined;
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    const text = typeof data === "string" ? data : "";
    if (text === "") return;
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const title = label ?? tr("labels.copy");

  return (
    <button
      type="button"
      className={className === undefined ? "pp-inspect-copy" : "pp-inspect-copy " + className}
      title={title}
      aria-label={title}
      disabled={typeof data !== "string" || data === ""}
      onClick={(event) => {
        event.stopPropagation();
        copy();
      }}
    >
      <span className="pp-inspect-copy-content">{children}</span>
      <span className="pp-inspect-copy-icon" aria-hidden="true">
        {copied ? <TickIcon /> : <ClipboardIcon />}
      </span>
    </button>
  );
}

// One row of a computed panel. The colour rows lead with the swatch, the
// text row prints the run and the subtitle row prints the nested key.
function InspectRowView({ row }: { row: InspectRow }) {
  if (row.kind === "subtitle") {
    return (
      <div className="pp-inspect-row pp-inspect-row--subtitle">
        <div className="pp-inspect-row-value">
          <InspectCopyButton data={row.copy}>{row.label}</InspectCopyButton>
        </div>
      </div>
    );
  }

  if (row.kind === "text") {
    return (
      <div className="pp-inspect-row pp-inspect-row--text">
        <div className="pp-inspect-row-value">
          <InspectCopyButton data={row.copy}>
            <span
              className="pp-inspect-text"
              style={{
                fontFamily: row.textStyle?.fontFamily,
                fontStyle: row.textStyle?.fontStyle,
                fontWeight: row.textStyle?.fontWeight,
              }}
            >
              {row.value}
            </span>
          </InspectCopyButton>
        </div>
      </div>
    );
  }

  return (
    <div className="pp-inspect-row" title={row.label === "" ? undefined : row.label}>
      <div className="pp-inspect-row-label">{row.label}</div>
      <div className="pp-inspect-row-value">
        {row.kind === "color" ? (
          <span
            className="pp-inspect-swatch"
            style={{ background: row.swatch ?? "transparent" }}
            aria-hidden="true"
          />
        ) : null}
        <InspectCopyButton data={row.copy}>
          <span className="pp-inspect-value">
            <span className="pp-inspect-value-text">{row.value}</span>
            {row.hint === null || row.hint === undefined ? null : (
              <span className="pp-inspect-value-hint">{row.hint}</span>
            )}
          </span>
        </InspectCopyButton>
      </div>
    </div>
  );
}

function InspectSectionView({ section }: { section: InspectSection }) {
  return (
    <section className="pp-inspect-block" data-testid={"inspect-" + section.id}>
      <div className="pp-inspect-title">
        <span className="pp-inspect-title-text">{section.title}</span>
        {section.copy === null || section.copy === undefined || section.copy === "" ? null : (
          <InspectCopyButton data={section.copy} className="pp-inspect-title-copy" />
        )}
      </div>
      <div className="pp-inspect-rows">
        {section.rows.map((row) => (
          <InspectRowView key={row.key} row={row} />
        ))}
      </div>
    </section>
  );
}

// The selection overlay. The invisible hit rectangles carry the pointer
// events; the drawn groups stay pointer-transparent.
function InspectOverlay({
  bounds,
  hitShapes,
  hover,
  objects,
  onHover,
  onSelect,
  onToggle,
  selected,
  zoom,
}: {
  bounds: ViewerWasmBounds;
  hitShapes: readonly ViewerShape[];
  hover: string | null;
  objects: ViewerObjects;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  selected: ReadonlySet<string>;
  zoom: number;
}) {
  const selectedShapes = useMemo(() => resolveShapes(objects, selected), [objects, selected]);
  const selection = unionSelrect(selectedShapes);
  const hoverShape = hover === null ? undefined : objects[hover];
  const hoverSelected = hover !== null && selected.has(hover);

  const sizeDisplay = (rect: { x: number; y: number; width: number; height: number }) => {
    const rectHeight = 16 / zoom;
    const label = formatNumber(rect.width) + " x " + formatNumber(rect.height);
    const rectWidth = (label.length <= 9 ? 50 : 75) / zoom;
    const textPadding = 4 / zoom;
    const left = rect.x + rect.width / 2 - rectWidth / 2;
    return (
      <g pointerEvents="none">
        <rect
          x={left}
          y={rect.y + rect.height - rectHeight}
          width={rectWidth}
          height={rectHeight}
          fill="var(--color-static-white)"
          fillOpacity={0.7}
        />
        <text
          x={left + rectWidth / 2}
          y={rect.y + rect.height + textPadding - rectHeight / 2}
          textAnchor="middle"
          fill="var(--color-static-black)"
          fontSize={11 / zoom}
        >
          {label}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="pp-inspect-overlay"
      viewBox={"0 0 " + bounds.baseWidth + " " + bounds.baseHeight}
      width="100%"
      height="100%"
      fill="none"
      style={{ position: "absolute", inset: 0 }}
    >
      <g transform={"translate(" + -bounds.x + " " + -bounds.y + ")"}>
        <g pointerEvents="none">
          {selection === null ? null : (
            <rect
              x={selection.x}
              y={selection.y}
              width={selection.width}
              height={selection.height}
              stroke="var(--color-accent-tertiary)"
              strokeWidth={1 / zoom}
            />
          )}
        </g>
        {hoverShape !== undefined && !hoverSelected && hoverShape.selrect !== undefined ? (
          <g pointerEvents="none">
            <rect
              x={hoverShape.selrect.x}
              y={hoverShape.selrect.y}
              width={hoverShape.selrect.width}
              height={hoverShape.selrect.height}
              stroke="var(--color-accent-quaternary)"
              strokeWidth={1 / zoom}
            />
            {sizeDisplay(hoverShape.selrect)}
          </g>
        ) : null}
        {selection === null ? null : (
          <g pointerEvents="none">{sizeDisplay(selection)}</g>
        )}
        {hitShapes.map((shape) => {
          const rect = shape.selrect;
          if (rect === undefined) return null;
          return (
            <rect
              key={shape.id}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              fill="transparent"
              pointerEvents="all"
              onPointerEnter={() => onHover(shape.id)}
              onPointerLeave={() => onHover(null)}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.shiftKey) onToggle(shape.id);
                else onSelect(shape.id);
              }}
            />
          );
        })}
      </g>
    </svg>
  );
}

// The left sidebar: the frame and its subtree, topmost first, with the
// expand toggles and the modifier selection of the CLJS layer list.
function InspectLayers({
  frame,
  onSelect,
  onToggle,
  onToggleCollapse,
  rows,
  selected,
}: {
  frame: ViewerShape;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  rows: readonly InspectTreeRow[];
  selected: ReadonlySet<string>;
}) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (selected.size !== 1) return;
    const [id] = selected;
    const node = rowRefs.current.get(id);
    if (node !== undefined) node.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  return (
    <aside className="pp-inspect-layers" aria-label={tr("workspace.sidebar.layers")}>
      <div className="pp-inspect-layers-inside">
        <div
          className="pp-inspect-element-list"
          role="tree"
          aria-label={tr("workspace.sidebar.layers")}
        >
          {rows.map((row) => {
            const { shape, depth, hasChildren, expanded } = row;
            const isSelected = selected.has(shape.id);
            const hideToggle = shape.id === frame.id;
            const style = { "--pp-inspect-depth": depth } as CSSProperties;
            return (
              <div
                key={shape.id}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={isSelected}
                aria-expanded={hasChildren ? expanded : undefined}
                tabIndex={0}
                className={
                  isSelected
                    ? "pp-inspect-layer-row pp-inspect-layer-row--selected"
                    : "pp-inspect-layer-row"
                }
                style={style}
                ref={(node) => {
                  if (node === null) rowRefs.current.delete(shape.id);
                  else rowRefs.current.set(shape.id, node);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) onToggle(shape.id);
                  else onSelect(shape.id);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(shape.id);
                  }
                }}
              >
                <div className="pp-inspect-layer-indent" />
                <div className="pp-inspect-layer-body">
                  <div className="pp-inspect-layer-content">
                    {hasChildren && !hideToggle ? (
                      <button
                        type="button"
                        className={
                          expanded
                            ? "pp-inspect-layer-toggle pp-inspect-layer-toggle--expanded"
                            : "pp-inspect-layer-toggle"
                        }
                        aria-label={shapeName(shape)}
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleCollapse(shape.id);
                        }}
                      >
                        <ChevronIcon />
                      </button>
                    ) : (
                      <span
                        className="pp-inspect-layer-toggle pp-inspect-layer-toggle--leaf"
                        aria-hidden="true"
                      />
                    )}
                    <span className="pp-inspect-layer-icon">
                      <InspectShapeGlyph icon={inspectShapeIcon(shape)} />
                    </span>
                  </div>
                  <span className="pp-inspect-layer-name" title={shapeName(shape)}>
                    {shapeName(shape)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// The right sidebar: the shape info, the layer-info bar with the two
// selectors and the computed panel.
function InspectSidebar({
  colorFormat,
  components,
  onColorFormat,
  selectedShapes,
  sections,
}: {
  colorFormat: InspectColorFormat;
  components: Record<string, unknown>;
  onColorFormat: (format: InspectColorFormat) => void;
  selectedShapes: readonly ViewerShape[];
  sections: readonly InspectSection[];
}) {
  const first = selectedShapes[0];
  const multiple = selectedShapes.length > 1;
  const subtitle = multiple ? null : inspectSubtitle(first);
  const component =
    first !== undefined && typeof first["component-id"] === "string"
      ? components[first["component-id"]]
      : undefined;

  return (
    <aside className="pp-inspect-sidebar">
      {selectedShapes.length === 0 ? (
        <div className="pp-inspect-empty">
          <div className="pp-inspect-empty-row">{tr("inspect.empty.select")}</div>
          <div className="pp-inspect-empty-row">{tr("inspect.empty.help")}</div>
          <a
            className="pp-inspect-empty-button"
            href="https://help.penpot.app/user-guide/inspect/"
            target="_blank"
            rel="noreferrer"
          >
            {tr("inspect.empty.more")}
          </a>
        </div>
      ) : (
        <div className="pp-inspect-tool-windows">
          <div
            className={
              subtitle === null
                ? "pp-inspect-shape-info"
                : "pp-inspect-shape-info pp-inspect-shape-info--subtitle"
            }
          >
            <div className="pp-inspect-shape-icon">
              {multiple ? (
                <LayersIcon />
              ) : first === undefined ? null : (
                <InspectShapeGlyph icon={inspectShapeIcon(first, component)} />
              )}
            </div>
            {multiple ? (
              <span className="pp-inspect-layer-title">
                {tr("inspect.multiple-selected", selectedShapes.length)}
              </span>
            ) : first === undefined ? null : (
              <div>
                <div
                  className={
                    subtitle === null
                      ? "pp-inspect-layer-title"
                      : "pp-inspect-layer-title pp-inspect-layer-title--subtitle"
                  }
                  title={shapeName(first)}
                >
                  {shapeName(first)}
                </div>
                {subtitle === null ? null : (
                  <div className="pp-inspect-layer-subtitle">{subtitle}</div>
                )}
              </div>
            )}
          </div>

          <div className="pp-inspect-content">
            <div className="pp-inspect-tab-switcher">
              <span className="pp-inspect-tab-switcher-label">{tr("inspect.layer-info")}</span>
              <div className="pp-inspect-tab-switcher-controls">
                <select
                  className="pp-inspect-select pp-inspect-select--color"
                  aria-label={tr("inspect.color-space-label")}
                  value={colorFormat}
                  onChange={(event) => onColorFormat(event.target.value as InspectColorFormat)}
                >
                  <option value="hex">{tr("inspect.attributes.color.hex")}</option>
                  <option value="rgba">{tr("inspect.attributes.color.rgba")}</option>
                  <option value="hsla">{tr("inspect.attributes.color.hsla")}</option>
                </select>
                {/* The Styles and Code tabs are D24: the control stays, the
                    two pending entries are disabled. */}
                <select
                  className="pp-inspect-select"
                  aria-label={tr("inspect.tabs-switcher-label")}
                  value="computed"
                  title={tr("labels.computed")}
                  disabled
                >
                  <option value="styles" disabled>
                    {tr("labels.styles")}
                  </option>
                  <option value="computed">{tr("labels.computed")}</option>
                  <option value="code" disabled>
                    {tr("labels.code")}
                  </option>
                </select>
              </div>
            </div>

            <div className="pp-inspect-tab">
              <div className="pp-inspect-attributes">
                {sections.map((section) => (
                  <InspectSectionView key={section.id} section={section} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export interface ViewerInspectProps {
  components: Record<string, unknown>;
  fileId: string;
  frame: ViewerShape;
  index: number;
  numFrames: number;
  objects: ViewerObjects;
  onFirst: () => void;
  onNext: () => void;
  onPrev: () => void;
  pageId: string;
  publicUri: string;
  // React 19 passes ref as a plain prop; the page runs select-all through it.
  ref?: Ref<ViewerInspectHandle>;
  shareId: string | null;
  zoom: number;
}

export interface ViewerInspectHandle {
  selectAll: () => void;
}

export function ViewerInspect({
  components,
  fileId,
  frame,
  index,
  numFrames,
  objects,
  onFirst,
  onNext,
  onPrev,
  pageId,
  publicUri,
  ref,
  shareId,
  zoom,
}: ViewerInspectProps) {
  const [bounds, setBounds] = useState<ViewerWasmBounds | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [colorFormat, setColorFormat] = useState<InspectColorFormat>("hex");
  const [forceVisible, setForceVisible] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set([frame.id]),
  );

  // inspect.cljs selects the frame on mount and on every frame change.
  useEffect(() => {
    setSelected(new Set([frame.id]));
    setHover(null);
  }, [frame.id]);

  // The reported bounds describe the previous frame while the next one
  // decodes, so they drop on navigation like the page does for the wrapper.
  useEffect(() => {
    setBounds(null);
  }, [frame.id]);

  const hitShapes = useMemo(() => collectHitShapes(frame, objects), [frame, objects]);
  const rows = useMemo(
    () => inspectTreeRows(frame, objects, collapsed),
    [frame, objects, collapsed],
  );
  const selectedShapes = useMemo(() => resolveShapes(objects, selected), [objects, selected]);

  const fontName = useMemo(
    () => (fontId: string): string | undefined => lookupCustomFont(fontId)?.family,
    [],
  );
  const sections = useMemo(
    () =>
      buildInspectSections(selectedShapes, {
        objects,
        components,
        colorFormat,
        publicUri,
        shareId,
        fontName,
      }),
    [selectedShapes, objects, components, colorFormat, publicUri, shareId, fontName],
  );

  const select = (id: string): void => setSelected(new Set([id]));
  // dv/select-all: every shape whose frame-id is this frame, plus the frame
  // itself (inspectSelectAll, see the export below).
  useImperativeHandle(
    ref,
    () => ({ selectAll: () => setSelected(inspectSelectAll(frame, objects)) }),
    [frame, objects],
  );
  const toggle = (id: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const shiftSelect = (id: string): void =>
    setSelected((current) => {
      // The index order of the CLJS shift selection walks the whole page;
      // only one frame answers the pointer in the viewer, so its subtree is
      // the same list and the collapsed rows stay part of the range.
      const order = inspectTreeIds(frame, objects, new Set<string>());
      return new Set(expandRegionSelection(order, current, id));
    });
  const toggleCollapse = (id: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const frameWidth = (bounds?.baseWidth ?? frame.selrect?.width ?? 0) * zoom;
  const frameHeight = (bounds?.baseHeight ?? frame.selrect?.height ?? 0) * zoom;

  return (
    <div className="pp-inspect" data-force-visible={forceVisible}>
      <InspectLayers
        frame={frame}
        onSelect={(id) => (selected.size === 1 && selected.has(id) ? undefined : select(id))}
        onToggle={toggle}
        onToggleCollapse={toggleCollapse}
        rows={rows}
        selected={selected}
      />
      <div className="pp-inspect-svg-wrapper">
        <ViewerPagination
          index={index}
          numFrames={numFrames}
          onPrev={onPrev}
          onNext={onNext}
          onFirst={onFirst}
        />
        <div
          className="pp-inspect-svg-container"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            select(frame.id);
            setForceVisible((current) => !current);
          }}
        >
          <div
            className="pp-viewer-wrapper"
            style={{ width: frameWidth, height: frameHeight }}
          >
            <ViewerWasmViewport
              fileId={fileId}
              shareId={shareId}
              pageId={pageId}
              frameId={frame.id}
              frameName={shapeName(frame)}
              zoom={zoom}
              onBounds={setBounds}
            />
            {bounds === null ? null : (
              <InspectOverlay
                bounds={bounds}
                hitShapes={hitShapes}
                hover={hover}
                objects={objects}
                onHover={setHover}
                onSelect={select}
                onToggle={shiftSelect}
                selected={selected}
                zoom={zoom}
              />
            )}
          </div>
        </div>
      </div>
      <InspectSidebar
        colorFormat={colorFormat}
        components={components}
        onColorFormat={setColorFormat}
        selectedShapes={selectedShapes}
        sections={sections}
      />
    </div>
  );
}

// The select-all shortcut of the viewer (dv/select-all) reads the frame
// subtree; kept here so the page wires the shortcut without importing the
// data helpers of the panel.
export function inspectSelectAll(frame: ViewerShape, objects: ViewerObjects): Set<string> {
  return new Set(allShapeIds(frame, objects));
}
