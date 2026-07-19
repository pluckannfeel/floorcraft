import type Konva from 'konva'
import { Group, Image as KonvaImage, Line, Path, Rect, Text } from 'react-konva'
import { NO_GUIDES, snapDragPosition } from './AlignmentGuides'
import type { GuideLines } from './AlignmentGuides'
import { clampToBounds } from './coordinates'
import { useRegistryImage } from './imageRegistry'
import { flattenPoints, getEffectiveTension, isLineTool, parseLinePoints } from './LineTool'
import { outlineStrokeRect, SYMBOLS, symbolScale } from './symbols'
import { fontStyleFor, isTextType, parseTextProperties } from './TextTool'
import type { CanvasObject, CatalogType, ObjectType, Point } from './types'
import { BACKING_RECT_FILL, resolveBoxVisual, symbolLabelText } from './visuals'

/**
 * Color palette for all 14 Object types. Originally (canvas-tools) the
 * color WAS the whole visual; since U4 (object-visuals) the 7 catalog
 * types render top-down symbols and the palette survives as their TINT
 * (R3 — the `fill` on every symbol Path and Sidebar thumbnail), while
 * Shapes/Lines still use it as their direct fill/stroke.
 *
 * Shape/Line types render as a plain colored rect/line — type-specific
 * rendering for them stays out of object-visuals scope.
 *
 * `text` (canvas-tools U7) never actually FILLS with this color — a text
 * object's fill comes from its own `properties.color` — but the Record is
 * deliberately exhaustive over `ObjectType` so adding an enum value without
 * deciding its color is a compile error.
 */
const TYPE_COLORS: Record<ObjectType, string> = {
  outlines: '#6b7280',
  tables: '#b45309',
  doors: '#0891b2',
  chairs: '#7c3aed',
  furnitures: '#c2410c',
  appliances: '#0d9488',
  lighting: '#ca8a04',
  shape_rectangle: '#2563eb',
  shape_square: '#1d4ed8',
  shape_circle: '#1e40af',
  line_straight: '#dc2626',
  line_curved: '#b91c1c',
  line_s_curve: '#991b1b',
  text: '#111827',
}

const DEFAULT_COLOR = '#4b5563'

// Non-component export colocated with the palette it reads from; same
// pattern as AuthContext.tsx's `useAuth` hook export.
// eslint-disable-next-line react-refresh/only-export-components
export function colorForType(type: ObjectType): string {
  return TYPE_COLORS[type] ?? DEFAULT_COLOR
}

/**
 * U1 (canvas-tools): the modifier keys held during a select click/tap,
 * reported alongside the id so `CanvasStage`'s routing can distinguish
 * plain click (replace selection) from ctrl/meta+click (toggle membership).
 * ObjectShape itself stays selection-policy-free — it only relays what the
 * pointer event carried.
 */
export interface SelectionClickModifiers {
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * U3: the group-drag relay a selected member's drag events dispatch
 * into. `CanvasStage` owns the actual policy (delta computation, snapping
 * with the whole selection excluded, COLLECTIVE bounds clamping, imperative
 * co-member movement via its node registry, and the single batched
 * `updateItemsGeometry` commit) — ObjectShape only relays which member is
 * being dragged and its live node, exactly like `onSelect` relays clicks.
 * Passed while this object is part of the SELECTION (U6 widened U3's
 * 2+-only condition so a sole-selected box object shares the same
 * dragstart-capture/Alt-at-release pipeline; a sole-selected Line still
 * never gets the relay — anchor-only editing, U17); when absent, the
 * pre-U3 single-drag behavior below is untouched.
 *
 * U6: `onDragStart` lets `CanvasStage` capture every selected node's
 * pre-drag position (and Line points) for the Alt-drop duplicate's
 * IMPERATIVE revert, and `onDragEnd` carries the release event's `altKey`
 * — Alt is sampled at RELEASE (plan's interaction default), so ObjectShape
 * itself stays policy-free and only reports what the event carried,
 * exactly like `SelectionClickModifiers`.
 */
export interface GroupDragHandlers {
  onDragStart: (id: CanvasObject['id'], node: Konva.Node) => void
  onDragMove: (id: CanvasObject['id'], node: Konva.Node) => void
  onDragEnd: (id: CanvasObject['id'], node: Konva.Node, altKey: boolean) => void
}

/**
 * U6 (object-visuals): the tinted symbol GLYPH — U4's symbol Paths,
 * extracted so the artwork renders identically from BOTH consumers: the
 * symbol branch proper, and the image branch's loading/failed PLACEHOLDER
 * (R16: a pending or dead variant image renders its type's tinted default
 * symbol, so plans always read as plans — on screen and, via U7, in
 * exports). One component, one derivation of the Path props — not two
 * copies that could drift (the pan-tool learning's two-derivations hazard).
 *
 * Everything here is FULLY DECLARATIVE (props recomputed per render; no
 * node.cache()/filters — the imperative-divergence hazard), and
 * `listening={false}` throughout: the backing Rect in ObjectShape owns the
 * Group's hit area (U4 hit-area contract), so glyph Paths never pay
 * hit-canvas rendering.
 */
function SymbolGlyph({
  type,
  fill,
  width,
  height,
  zoom,
}: {
  type: CatalogType
  fill: string
  width: number
  height: number
  /** Stage zoom — only the outlines branch consumes it (its stroke opts
   * out of ALL scaling via strokeScaleEnabled, so zoom must be re-applied
   * by hand); every other glyph scales with the stage naturally. */
  zoom: number
}) {
  // Outlines are the exception to scaled-symbol rendering (user feedback):
  // resizing must EXPAND the room, never thicken the walls — INCLUDING
  // mid-gesture, which is why this is a stroked Rect with
  // `strokeScaleEnabled={false}` rather than filled bands: bands derive
  // from store dims that only commit at transformend, so the live gesture
  // scaled them; a scale-exempt stroke holds its width through the whole
  // drag. `outlineStrokeRect` (pure + tested) computes the inset rect and
  // the zoom-compensated stroke width. Deliberate, documented exception
  // to the U4 no-strokes contract — that rule guards against ANISOTROPIC
  // stroke distortion under scale, and a scale-exempt stroke cannot
  // distort. The SYMBOLS.outlines entry now only feeds the sidebar
  // thumbnails.
  if (type === 'outlines') {
    const frame = outlineStrokeRect(width, height, zoom)
    return (
      <Rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        stroke={fill}
        strokeWidth={frame.strokeWidth}
        strokeScaleEnabled={false}
        listening={false}
      />
    )
  }

  const definition = SYMBOLS[type]
  // Pure viewBox→box mapping (tested standalone): non-uniform stretch is
  // expected — the Transformer folds resize into width/height, and the
  // filled-geometry symbol contract makes anisotropic scale safe.
  const scaling = symbolScale(definition.viewBox, width, height)
  return (
    <>
      {definition.paths.map((data, index) => (
        <Path
          key={index}
          data={data}
          fill={fill}
          scaleX={scaling.scaleX}
          scaleY={scaling.scaleY}
          listening={false}
        />
      ))}
    </>
  )
}

/**
 * U6: the placed-variant image visual (R8/R10/R16/R20). A dedicated child
 * component — not inline in ObjectShape — because the registry hook must be
 * called unconditionally (rules of hooks) while ObjectShape itself branches
 * away for lines/text before the box visual is even resolved.
 *
 * The registry hook is the SINGLE load path (plan KTD: no `use-image` — it
 * cannot be seeded from a cache, so it could never deliver the synchronous
 * remount reuse an undo-of-delete needs): a cache hit hands back the
 * decoded element during THIS render, so a remounted variant object paints
 * its image on its first commit with no placeholder strobe. Load status
 * lives in the registry module + this node's React state ONLY — never the
 * zustand store (undo-redo learning: an image completion writing items
 * would push junk undo entries and flip `dirty`).
 *
 * While no decoded element is available — 'pending' fetch or settled
 * 'failed' (dead/foreign file; the R20 probe fires inside the registry so
 * the auth interceptor owns any session-expiry redirect) — the type's
 * tinted default symbol renders as the placeholder (R16). The one-render
 * window where `status` is still 'pending' but `image` is non-null is
 * exactly the commit the registry's 'loaded' flip is waiting on, so
 * image-presence is the render key.
 *
 * Explicit `width`/`height` on the Konva Image (the object's stored box):
 * required for correct stretch under the Transformer contract AND the
 * Firefox SVG fix — Firefox reports zero intrinsic size for some
 * SVG-as-image cases, so the drawn size must never rely on the element's
 * natural dimensions. `listening={false}`: the backing Rect owns hits,
 * exactly like the symbol Paths.
 */
function VariantImage({
  url,
  type,
  fill,
  width,
  height,
  zoom,
}: {
  url: string
  type: CatalogType
  fill: string
  width: number
  height: number
  zoom: number
}) {
  const { image } = useRegistryImage(url)
  if (image == null) {
    return <SymbolGlyph type={type} fill={fill} width={width} height={height} zoom={zoom} />
  }
  return <KonvaImage image={image} width={width} height={height} listening={false} />
}

interface ObjectShapeProps {
  object: CanvasObject
  isSelected?: boolean
  onSelect?: (id: CanvasObject['id'], modifiers?: SelectionClickModifiers) => void
  /** U4: double-click/tap relay — `CanvasStage` narrows a double-clicked
   * GROUP MEMBER's selection to just that member (member-mode). Like
   * `onSelect`, ObjectShape stays selection-policy-free and only reports
   * which object was double-clicked; the constituent single clicks still
   * fire `onSelect` first (browser click/click/dblclick ordering), which
   * the routing in CanvasStage expects. */
  onDoubleClick?: (id: CanvasObject['id']) => void
  /** Registers/unregisters this node's Konva ref with a parent-owned
   * `Map<id, Konva.Node>` — used by U8's SelectionTransformer. Optional so
   * this unit doesn't need that machinery yet. */
  shapeRef?: (node: Konva.Node | null) => void
  /** Grid size and canvas bounds for U8's reposition-drag `dragBoundFunc`
   * (grid-snap + bounds-clamp), same `coordinates.ts` helpers U7 already
   * uses for sidebar-drop placement. Optional so tests that don't exercise
   * dragging can omit them. */
  gridSize?: number
  canvasWidth?: number
  canvasHeight?: number
  /** Commits a repositioned-via-drag item's final x/y to the store, called
   * on `dragend` (U8's R13 "drag", distinct from U7's sidebar-to-canvas
   * creation drag). */
  onGeometryChange?: (id: CanvasObject['id'], patch: Partial<Pick<CanvasObject, 'x' | 'y'>>) => void
  /** U19: every Object currently on the floor plan (including this one —
   * `snapDragPosition` excludes `object.id` internally), used to compute
   * alignment-guide "stops" from every OTHER Object's bbox edges/center.
   * Optional so tests/callers that don't exercise alignment guides can omit
   * it, in which case no alignment-snap is attempted (grid-snap only, same
   * as before this unit). */
  allObjects?: CanvasObject[]
  /** U11's current Stage zoom — needed to convert U19's 5px screen-space
   * snap threshold into model-space units. Defaults to 1 (matches
   * `CanvasStage`'s own zoom default) so callers that don't exercise zoom
   * still get correct alignment-snap behavior. */
  zoom?: number
  /** U19: reports the currently-matched guide lines (or `NO_GUIDES`) up to
   * `CanvasStage` for rendering on the UI overlay layer, and to clear them
   * on `dragend`. */
  onAlignmentGuidesChange?: (guides: GuideLines) => void
  /** U3: present exactly while this object belongs to a multi-selection —
   * reroutes this node's drag gesture into `CanvasStage`'s group-drag
   * orchestration (see `GroupDragHandlers`). Also what makes a LINE member
   * draggable at all (single-selected Lines stay non-draggable,
   * anchor-only — U17). */
  groupDrag?: GroupDragHandlers
  /** False while the canvas is in a navigate-only mode (pan tool): the node
   * still LISTENS (a click selects it and hands over to the select tool),
   * but must not be draggable — a press over it has to reach the draggable
   * Stage so the drag pans instead of moving the object. */
  draggable?: boolean
  /** U7: true while this object is being edited through the DOM
   * `TextEditOverlay` — the Konva node hides (official Konva editable-text
   * pattern: the overlay's textarea IS the visible text during editing, so
   * the node underneath must not double-render). Only ever set for text
   * objects in practice, but implemented generically on the Group. */
  hidden?: boolean
}

/**
 * Renders one Object positioned at x/y/width/height/rotation, draggable for
 * U8's reposition-an-existing-item interaction. Resize/rotate is handled
 * externally by U8's `SelectionTransformer`, attached via the
 * `shapeRef`-registered node.
 *
 * U4 (object-visuals): catalog Objects render their tinted top-down SYMBOL
 * (`resolveBoxVisual` → `SYMBOLS` Paths over a hit-solid backing Rect —
 * see the symbol branch below); U6: a catalog Object carrying a valid
 * variant reference renders its uploaded IMAGE instead (`VariantImage`
 * above — registry-hook loading, symbol placeholder, store-free load
 * state); Shapes keep the generic colored Rect+label.
 * Line-typed Objects (U16) are structurally different — they have no
 * meaningful width/height "box," they're defined by `properties.points` —
 * so they branch to a dedicated `Konva.Line` render below instead.
 *
 * The Group is given an explicit `width`/`height` (matching the Rect's)
 * rather than leaving Konva to infer 0 — `SelectionTransformer` reads
 * `node.width()`/`node.height()` directly when folding resize scale back
 * into stored dimensions, which requires the Group to report its true size.
 * That Group wrapper contract (position/size/rotation/drag/dragBound/select
 * relays) is deliberately untouched by the U4 branch rework — every
 * existing interaction inherits onto symbols for free.
 */
export function ObjectShape({
  object,
  isSelected = false,
  onSelect,
  onDoubleClick,
  shapeRef,
  gridSize,
  canvasWidth,
  canvasHeight,
  onGeometryChange,
  allObjects,
  zoom = 1,
  onAlignmentGuidesChange,
  groupDrag,
  draggable = true,
  hidden = false,
}: ObjectShapeProps) {
  const fill = colorForType(object.type)

  // U16: Lines are defined by `properties.points`, not x/y/width/height —
  // rendered as a raw/tensioned Konva.Line, not the generic Rect+label
  // below. Not draggable as a whole Group (unlike catalog Objects/Shapes):
  // its points are absolute canvas coordinates rendered with the Group at
  // its natural origin, so a whole-node drag would desync the Group's
  // x/y from the points it renders. Per Key Technical Decisions, Lines get
  // their own point-based editing model (U17's `LineAnchorHandles`) instead
  // of the Transformer/whole-node-drag pattern every other type uses.
  //
  // U3 exception: while part of a MULTI-selection the Line becomes
  // draggable (otherwise a line-only selection — e.g. two marqueed walls —
  // would have no draggable member to grab), with NO dragBoundFunc: the
  // plan's group-drag rule skips per-member snapping/clamping entirely, and
  // `CanvasStage`'s group `onDragEnd` both commits the translated points
  // and resets the node's position offset back to zero in the same dragend
  // (a Line's x/y aren't React props, so a surviving offset would double
  // the committed translation on the store-driven re-render).
  if (isLineTool(object.type)) {
    const points = parseLinePoints(object.properties)
    const tension = getEffectiveTension(object.type, points.length)
    return (
      <Line
        ref={shapeRef}
        points={flattenPoints(points)}
        stroke={fill}
        strokeWidth={isSelected ? 3 : 2}
        tension={tension}
        lineCap="round"
        lineJoin="round"
        hitStrokeWidth={12}
        draggable={draggable && groupDrag != null}
        onClick={(event) =>
          onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
        }
        onTap={(event) =>
          onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
        }
        onDblClick={() => onDoubleClick?.(object.id)}
        onDblTap={() => onDoubleClick?.(object.id)}
        onDragStart={groupDrag ? (event) => groupDrag.onDragStart(object.id, event.target) : undefined}
        onDragMove={groupDrag ? (event) => groupDrag.onDragMove(object.id, event.target) : undefined}
        onDragEnd={
          groupDrag
            ? (event) => groupDrag.onDragEnd(object.id, event.target, event.evt.altKey)
            : undefined
        }
      />
    )
  }

  // U19: computed on every dragmove frame (Konva calls `dragBoundFunc` on
  // each move, not just at dragend). Alignment-snap (preferred) or
  // grid-snap (fallback per axis, see `AlignmentGuides.tsx`'s module doc for
  // the precedence rationale) runs first, then the existing bounds-clamp
  // always runs last — snap-then-clamp order is unchanged from U8. The
  // matched guides (if any) are reported up to `CanvasStage` as a side
  // effect so they render for this same frame; Konva already re-invokes this
  // function every dragmove frame regardless, so this doesn't add extra
  // render passes beyond what dragging already causes.
  //
  // U3: NOT used while this object is part of a multi-selection — the
  // group-drag policy in `CanvasStage` replaces both halves: snapping must
  // exclude every co-moving member (not just this one), and clamping
  // applies to the shared DELTA against the selection's COLLECTIVE bbox
  // (per-member clamping would distort the arrangement at the canvas edge).
  const dragBoundFunc = function dragBoundFunc(this: Konva.Node, pos: Point): Point {
    if (gridSize == null || canvasWidth == null || canvasHeight == null) return pos
    const { point: snapped, guides } = snapDragPosition(
      pos,
      object.width,
      object.height,
      allObjects ?? [],
      object.id,
      zoom,
      gridSize,
    )
    onAlignmentGuidesChange?.(guides)
    return clampToBounds(snapped, object.width, object.height, canvasWidth, canvasHeight)
  }

  // U7: text objects render a single auto-sizing Konva.Text (NO width prop —
  // Konva auto-sizes, and the stored width/height merely MIRROR that box)
  // inside the SAME draggable Group wrapper as the box branch below, so
  // selection, drag, dragBoundFunc snapping/clamping, group membership, and
  // the transformer all treat text like any other box object. Konva.Text's
  // hit region is its bounding rect, so the Group stays clickable without a
  // backing Rect.
  const textProperties = isTextType(object.type) ? parseTextProperties(object.properties) : null

  // U4/U6 (object-visuals): the generic box branch's visual decision, made
  // by the shared pure helper in visuals.ts (one derivation of one truth —
  // the defensive variant parser lives in the same module; see the pan-tool
  // learning on why the key/decision must not be re-derived here). Catalog
  // types get the tinted top-down symbol; a catalog object whose properties
  // carry a VALID variant reference gets the uploaded image (U6, with the
  // symbol as its R16 placeholder — invalid references fail closed to the
  // symbol inside resolveBoxVisual, AE1); Shapes keep the plain colored
  // Rect. The union's 'symbol'/'image' arms carry the narrowed CatalogType,
  // so indexing the exhaustive SYMBOLS map needs no cast. Everything below
  // is FULLY DECLARATIVE — scale/tint/image are props recomputed per
  // render, no node.cache()/filters (the imperative-divergence hazard).
  const boxVisual = resolveBoxVisual(object)
  // Label rule R17: a user-given name still renders on symbols AND images;
  // the redundant `|| object.type` fallback is gone (the visual IS the
  // type).
  const symbolLabel = symbolLabelText(object.name)

  return (
    <Group
      x={object.x}
      y={object.y}
      width={object.width}
      height={object.height}
      rotation={object.rotation}
      visible={!hidden}
      ref={shapeRef}
      draggable={draggable}
      dragBoundFunc={groupDrag ? undefined : dragBoundFunc}
      onClick={(event) =>
        onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
      }
      onTap={(event) =>
        onSelect?.(object.id, { ctrlKey: event.evt.ctrlKey, metaKey: event.evt.metaKey })
      }
      onDblClick={() => onDoubleClick?.(object.id)}
      onDblTap={() => onDoubleClick?.(object.id)}
      onDragStart={groupDrag ? (event) => groupDrag.onDragStart(object.id, event.target) : undefined}
      onDragMove={groupDrag ? (event) => groupDrag.onDragMove(object.id, event.target) : undefined}
      onDragEnd={(event) => {
        const node = event.target
        // U3: a selected member's drag commits through the group relay
        // (ONE batched store entry for the whole selection) instead of the
        // single-object commit below. U6: the release event's altKey rides
        // along — Alt held at release turns the drop into a duplicate.
        if (groupDrag) {
          groupDrag.onDragEnd(object.id, node, event.evt.altKey)
          return
        }
        onGeometryChange?.(object.id, { x: node.x(), y: node.y() })
        // U19: destroy the temporary guide lines once the drag interaction
        // ends (Approach: guides are removed on dragend/transformend).
        onAlignmentGuidesChange?.(NO_GUIDES)
      }}
    >
      {textProperties ? (
        <Text
          text={textProperties.text}
          fontFamily={textProperties.font_family}
          fontSize={textProperties.font_size}
          fontStyle={fontStyleFor(textProperties)}
          fill={textProperties.color}
        />
      ) : boxVisual.kind !== 'plain' ? (
        <>
          {/* U4 hit-area contract (U6: applies to the image branch
              IDENTICALLY — it is a box-shaped branch): a full-size,
              ALWAYS-MOUNTED backing Rect owns the Group's hit area.
              Konva.Path hit regions are painted-geometry-only, so without
              this an unselected sparse symbol (door leaf + arc) would be
              clickable only on its painted pixels — silently breaking
              click-select, group-drag grabs, and pan-mode click-to-select;
              for the image branch it additionally keeps the hit surface
              stable across the placeholder→image swap (the swap can never
              change what is clickable). The zero-alpha rgba fill
              (BACKING_RECT_FILL) is invisible on the scene canvas but keeps
              the hit graph solid (an absent fill would make Konva skip it).
              It also carries the selection stroke, exactly like the plain
              box branch below. */}
          <Rect
            width={object.width}
            height={object.height}
            fill={BACKING_RECT_FILL}
            stroke={isSelected ? '#111827' : undefined}
            strokeWidth={isSelected ? 2 : 0}
            cornerRadius={2}
          />
          {/* The visual: the uploaded image for a valid variant reference
              (U6 — registry-hook loading, symbol placeholder while pending/
              failed, R16), the tinted symbol Paths otherwise (U4 — R3 tint
              via `fill` only; NO stroke props, filled-geometry contract).
              Both draw at group-local (0,0) stretched to the stored box, so
              the Group's position/rotation/drag/transform contract is
              inherited unchanged. */}
          {boxVisual.kind === 'image' ? (
            <VariantImage
              url={boxVisual.url}
              type={boxVisual.type}
              fill={fill}
              width={object.width}
              height={object.height}
              zoom={zoom}
            />
          ) : (
            <SymbolGlyph
              type={boxVisual.type}
              fill={fill}
              width={object.width}
              height={object.height}
              zoom={zoom}
            />
          )}
          {/* Label rule R17 (symbol AND image visuals): only a non-empty
              user-given name renders (dark text — these sit on the light
              canvas, unlike the solid colored box the old white label sat
              on). */}
          {symbolLabel != null && (
            <Text
              text={symbolLabel}
              width={object.width}
              height={object.height}
              align="center"
              verticalAlign="middle"
              fontSize={11}
              fill="#111827"
              listening={false}
            />
          )}
        </>
      ) : (
        <>
          {/* Pre-U4 plain box branch, now Shapes-only (catalog types render
              the symbol branch above): solid colored Rect + centered label
              with the historical `name || type` fallback (R17 is scoped to
              symbol/image visuals). */}
          <Rect
            width={object.width}
            height={object.height}
            fill={fill}
            stroke={isSelected ? '#111827' : undefined}
            strokeWidth={isSelected ? 2 : 0}
            cornerRadius={2}
          />
          <Text
            text={object.name || object.type}
            width={object.width}
            height={object.height}
            align="center"
            verticalAlign="middle"
            fontSize={11}
            fill="#ffffff"
            listening={false}
          />
        </>
      )}
    </Group>
  )
}
