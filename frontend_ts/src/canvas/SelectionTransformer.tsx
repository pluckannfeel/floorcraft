import { useEffect, useRef } from 'react'
import type Konva from 'konva'
import { Transformer } from 'react-konva'
import { NO_GUIDES, snapResizeBox } from './AlignmentGuides'
import type { GuideLines } from './AlignmentGuides'
import {
  applyNodeTransformToPoints,
  constrainTransformBox,
  MIN_ITEM_SIZE,
  SELECTION_CHROME,
} from './coordinates'
import { computeLineBoundingBox, flattenPoints, pairPoints } from './LineTool'
import type { ItemGeometryPatch } from '../state/canvasStore'
import type { CanvasObject, Point } from './types'

export interface TransformSnapshot {
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
}

export interface TransformGeometryPatch {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/**
 * Folds a Konva node's post-transform scale into concrete width/height.
 *
 * Per Konva's documented Transformer pattern (Context & Research): resizing
 * via the Transformer mutates `scaleX`/`scaleY`, not `width`/`height`
 * directly. The caller is responsible for baking that scale into the
 * stored dimensions and resetting the node's own scale back to 1 — this
 * function does the (pure, Konva-independent) math; the caller does the
 * Konva-node side effects.
 *
 * U3 note on rotated members: this decomposition is exact for a rotated
 * node too. Konva composes a node's transform as translate → rotate → scale
 * (scale innermost), so a `w x h` rect at rotation θ with scale (sx, sy)
 * maps its corners to exactly the same absolute positions as a
 * `(w*sx) x (h*sy)` rect at the same x/y/θ with scale 1 — folding the scale
 * into the dimensions and resetting scale preserves the member's visual
 * position (covered by a numeric test in SelectionTransformer.test.tsx).
 */
// Non-component export colocated with the component that uses it — same
// pattern as ObjectShape.tsx's `colorForType`.
// eslint-disable-next-line react-refresh/only-export-components
export function computeGeometryFromTransform(
  snapshot: TransformSnapshot,
  minSize: number = MIN_ITEM_SIZE,
): TransformGeometryPatch {
  return {
    x: snapshot.x,
    y: snapshot.y,
    width: Math.max(minSize, snapshot.width * snapshot.scaleX),
    height: Math.max(minSize, snapshot.height * snapshot.scaleY),
    rotation: snapshot.rotation,
  }
}

/**
 * Resolves the array Konva's `Transformer.nodes()` should be called with
 * for a given selection: every selected id's registered node, in selection
 * order (unregistered ids — e.g. an item mid-mount — are skipped). Pure and
 * Konva-independent so the "selection change -> attach the right node set"
 * logic is testable without mounting a real `Transformer`.
 *
 * U3 (canvas-tools): a multi-selection now attaches EVERY selected node —
 * one Transformer around the common bounding box, Line members included
 * (`CanvasStage` renders `LineAnchorHandles` INSTEAD of this component only
 * for exactly-one-line selections, so a lone Line never reaches here).
 *
 * Calling `.nodes()` with the result of this function is itself both the
 * detach-from-old and attach-to-new step: Konva's `Transformer.nodes()`
 * fully replaces whatever was previously attached, so there's no separate
 * detach call needed when selection changes.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveTransformerNodes(
  selectedItemIds: CanvasObject['id'][],
  getNode: (id: CanvasObject['id']) => Konva.Node | undefined,
): Konva.Node[] {
  const nodes: Konva.Node[] = []
  for (const id of selectedItemIds) {
    const node = getNode(id)
    if (node) nodes.push(node)
  }
  return nodes
}

/**
 * One attached node's state at `transformend`, in pure data form (U3):
 * `snapshot` is the node's post-transform attrs, and `linePoints` is
 * present exactly when the node is a Line — its CURRENT (pre-bake) points,
 * which Konva's Transformer never touches (it only mutates
 * x/y/scale/rotation), so they're still the absolute canvas points the
 * store knows.
 */
export interface MemberTransformState {
  id: CanvasObject['id']
  snapshot: TransformSnapshot
  linePoints?: Point[]
}

/**
 * U3's multi-node `transformend` decomposition, pure so the whole commit
 * math is testable in jsdom: folds each box member's scale into
 * width/height (min-size clamped PER MEMBER, same
 * `computeGeometryFromTransform` as a single-selection resize) and maps
 * each Line member's points through its node transform
 * (`applyNodeTransformToPoints` — points scale proportionally), recomputing
 * the Line's descriptive x/y/width/height metadata from the new points.
 * The caller commits the returned patches in ONE `updateItemsGeometry`
 * call — one history entry per gesture.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeTransformCommit(
  members: MemberTransformState[],
  minSize: number = MIN_ITEM_SIZE,
): Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }> {
  return members.map(({ id, snapshot, linePoints }) => {
    if (linePoints) {
      const points = applyNodeTransformToPoints(linePoints, {
        x: snapshot.x,
        y: snapshot.y,
        scaleX: snapshot.scaleX,
        scaleY: snapshot.scaleY,
        rotation: snapshot.rotation,
      })
      // A Line's x/y/width/height are descriptive metadata mirroring the
      // points' bbox (LineTool.tsx convention) — keep them in sync in the
      // same patch. A degenerate 0-point Line has no bbox to describe.
      const metadata = points.length > 0 ? computeLineBoundingBox(points) : {}
      return { id, patch: { points, ...metadata } }
    }
    return { id, patch: computeGeometryFromTransform(snapshot, minSize) }
  })
}

/** Duck-types a Konva node as a `Konva.Line` (the only attached node kind
 * with a `points` accessor in this app: catalog Objects/Shapes are Groups).
 * Kept as a helper (not `instanceof Konva.Line`) so this module keeps its
 * type-only Konva import. */
function isLineNode(node: Konva.Node): node is Konva.Line {
  return typeof (node as Konva.Line).points === 'function'
}

/**
 * U4's selection-visual discriminator, pure for jsdom tests: true exactly
 * when the selection is one PERSISTENT group — 2+ selected ids that all
 * resolve to items sharing the same non-null `group_key`. The transformer
 * border then draws DASHED (the shared `SELECTION_CHROME` token's dash
 * variant) versus solid for ad-hoc multi-selects and plain single
 * selections, so "saved group" always reads differently from "things I
 * just marqueed". A mixed selection (a group plus loose items, or two
 * different groups) is ad-hoc by definition — solid. Member-mode (a single
 * grouped member) is NOT a group selection; its cue is `CanvasStage`'s
 * dashed group-context outline instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isPersistentGroupSelection(
  selectedItemIds: CanvasObject['id'][],
  objects: CanvasObject[],
): boolean {
  if (selectedItemIds.length < 2) return false
  let sharedKey: string | null = null
  for (const id of selectedItemIds) {
    const key = objects.find((object) => object.id === id)?.group_key
    if (key == null) return false
    if (sharedKey == null) {
      sharedKey = key
    } else if (key !== sharedKey) {
      return false
    }
  }
  return true
}

interface SelectionTransformerProps {
  /** The current selection set — every id with a registered node attaches
   * (U3's multi-node Transformer; see `resolveTransformerNodes`). */
  selectedItemIds: CanvasObject['id'][]
  /** Resolves a selected item's live Konva node from the parent-owned
   * `Map<id, Konva.Node>` populated by `ObjectShape`'s `shapeRef` callback. */
  getNode: (id: CanvasObject['id']) => Konva.Node | undefined
  canvasWidth: number
  canvasHeight: number
  /** U3: the finished gesture's per-member patches, committed by the caller
   * in ONE batched store action (`updateItemsGeometry`) — one history entry
   * per gesture, single-selection transforms included (a one-element
   * batch). */
  onTransformEnd: (patches: Array<{ id: CanvasObject['id']; patch: ItemGeometryPatch }>) => void
  /** U19: every Object currently on the floor plan, used to compute
   * alignment-guide "stops" during resize. Optional so tests/callers that
   * don't exercise alignment guides can omit it (no alignment-snap
   * attempted in that case, `boundBoxFunc` behaves exactly as before this
   * unit). */
  allObjects?: CanvasObject[]
  /** U11's current Stage zoom — converts U19's 5px screen-space snap
   * threshold into model-space units. Defaults to 1. */
  zoom?: number
  /** U19: reports the currently-matched guide lines (or `NO_GUIDES`) up to
   * `CanvasStage` for rendering, and to clear them on `transformend`. */
  onAlignmentGuidesChange?: (guides: GuideLines) => void
}

/**
 * Wraps Konva's `Transformer` (U8). Attaches to the selected items' nodes
 * via `.nodes([...])` — NOT the deprecated `.attachTo` — in an effect keyed
 * on `selectedItemIds`. Calling `.nodes()` again with a new array (or `[]`)
 * both detaches whatever was previously attached and attaches the new
 * selection in one call, so switching selection needs no separate detach
 * step.
 *
 * U3: multi-selections attach every selected node and commit ONE batched
 * patch list on `transformend` (see `computeTransformCommit`).
 * `flipEnabled` is off per the plan (folding a negative scale into
 * width/height would corrupt stored dimensions). Group MOVE is not this
 * component's job — the plan's Key Technical Decision is manual delta
 * application in `CanvasStage`/`ObjectShape`, NOT the Transformer's own
 * drag proxying, so the attach effect below unbinds Konva's built-in
 * `_proxyDrag` handlers (which would otherwise `startDrag()` every
 * attached node when one member is dragged, re-introducing exactly the
 * per-member `dragBoundFunc` clamping/snapping the plan forbids for group
 * drags, plus N per-member `dragend` commits instead of one batch).
 *
 * Applies uniformly to catalog Objects and Shapes (R21), and — inside
 * multi-selections — Lines too. The `LineAnchorHandles` point-editing model
 * remains only for exactly-one-line selections; `CanvasStage` routes that
 * case away from this component.
 */
export function SelectionTransformer({
  selectedItemIds,
  getNode,
  canvasWidth,
  canvasHeight,
  onTransformEnd,
  allObjects,
  zoom = 1,
  onAlignmentGuidesChange,
}: SelectionTransformerProps) {
  const transformerRef = useRef<Konva.Transformer>(null)

  // Alignment-snap during resize remains a SINGLE-selection affordance:
  // `snapResizeBox` adjusts one edge of one box against sibling stops,
  // which fights the collective bounding box of a multi-selection — the
  // plan explicitly waives alignment-snap for multi-selections in v1.
  const soleSelectedId = selectedItemIds.length === 1 ? selectedItemIds[0] : null

  // U4: a persistent-group selection draws a DASHED border (see
  // isPersistentGroupSelection above); everything else stays solid.
  const groupSelected = isPersistentGroupSelection(selectedItemIds, allObjects ?? [])

  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    const nodes = resolveTransformerNodes(selectedItemIds, getNode)
    transformer.nodes(nodes)

    // U3: strip Konva's built-in drag proxying from every attached node
    // (see the component doc above). The handlers are namespaced
    // `dragstart.tr-konva{id}`/`dragmove.tr-konva{id}` (Konva's private
    // `_getEventNamespace()`); removing exactly those two leaves the
    // transformer's own transform-change/`absoluteTransformChange`
    // subscriptions (same namespace, different event names) intact, so the
    // transformer chrome still follows the manual delta application on
    // every dragmove frame. If a future Konva rename makes this `off()` a
    // no-op the failure mode is benign (native proxy-drag returns; nothing
    // crashes).
    const namespace = `.tr-konva${(transformer as unknown as { _id: number })._id}`
    for (const node of nodes) {
      node.off(`dragstart${namespace}`)
      node.off(`dragmove${namespace}`)
    }

    transformer.getLayer()?.batchDraw()
  }, [selectedItemIds, getNode])

  return (
    <Transformer
      ref={transformerRef}
      // U3: folding a flipped (negative) scale into width/height would
      // store negative dimensions — disable flipping outright (plan's
      // multi-node transformer decision; applies to single selections too,
      // where dragging an anchor past the opposite edge previously flipped).
      flipEnabled={false}
      // U4 selection visuals: every border draws from the shared
      // SELECTION_CHROME token (one chrome language with the marquee and
      // the member-mode group outline); a persistent-group selection gets
      // the token's DASH variant, ad-hoc multi-selects and single
      // selections stay solid (an explicit empty dash array, not
      // `undefined` — react-konva only re-applies CHANGED props, so a
      // group→ad-hoc selection switch must write a concrete value to clear
      // the dash).
      borderStroke={SELECTION_CHROME.stroke}
      borderDash={groupSelected ? [...SELECTION_CHROME.dash] : []}
      // U19: alignment-snap runs first (adjusting newBox's x/y/width/height
      // per whichever edge matched — see `AlignmentGuides.tsx`'s
      // `snapResizeBox`/`applyAxisSnapToEdge`), then the existing
      // `constrainTransformBox` bounds/min-size clamp always runs last on
      // the (possibly snapped) box — same snap-then-clamp order U8's drag
      // path already established, applied here to resize too.
      // U3: for a multi-selection, `newBox` is the COLLECTIVE bounding box —
      // alignment-snap is bypassed (v1 waiver, see `soleSelectedId` above)
      // but the bounds/min-size clamp still applies to the collective box,
      // so a group resize stops at the canvas edge as one unit.
      boundBoxFunc={(oldBox, newBox) => {
        if (soleSelectedId == null) return constrainTransformBox(oldBox, newBox, canvasWidth, canvasHeight)
        const { box: snapped, guides } = snapResizeBox(newBox, allObjects ?? [], soleSelectedId, zoom)
        onAlignmentGuidesChange?.(guides)
        return constrainTransformBox(oldBox, { ...newBox, ...snapped }, canvasWidth, canvasHeight)
      }}
      onTransformEnd={() => {
        // Konva fires the Transformer's own `transformend` ONCE per gesture
        // (its `event.target` is just the first attached node), so this
        // handler iterates the selection itself rather than trusting the
        // event target — the per-node `transformend` events Konva also
        // fires are not subscribed anywhere.
        //
        // U19: destroy the temporary guide lines once the resize
        // interaction ends (Approach: guides are removed on
        // dragend/transformend).
        onAlignmentGuidesChange?.(NO_GUIDES)

        const attached: Array<{ node: Konva.Node; member: MemberTransformState }> = []
        for (const id of selectedItemIds) {
          const node = getNode(id)
          if (!node) continue
          attached.push({
            node,
            member: {
              id,
              snapshot: {
                x: node.x(),
                y: node.y(),
                width: node.width(),
                height: node.height(),
                scaleX: node.scaleX(),
                scaleY: node.scaleY(),
                rotation: node.rotation(),
              },
              linePoints: isLineNode(node) ? pairPoints(node.points()) : undefined,
            },
          })
        }
        if (attached.length === 0) return

        const patches = computeTransformCommit(attached.map((entry) => entry.member))

        // Bake the folded geometry directly onto each node so there's no
        // visual snap-back flicker before the store update round-trips
        // through React. Box nodes: reset scale to 1 and set the clamped
        // width/height (x/y/rotation are React-controlled Group props and
        // already match the patch). Line nodes: write the transformed
        // points and reset the FULL node transform to identity — a Line's
        // x/y/scale/rotation are NOT React props, so any leftover offset
        // would survive the commit and double the transform on re-render.
        attached.forEach(({ node }, index) => {
          const { patch } = patches[index]
          if (isLineNode(node)) {
            if (patch.points) node.points(flattenPoints(patch.points))
            node.position({ x: 0, y: 0 })
            node.scale({ x: 1, y: 1 })
            node.rotation(0)
          } else {
            node.scaleX(1)
            node.scaleY(1)
            if (patch.width !== undefined) node.width(patch.width)
            if (patch.height !== undefined) node.height(patch.height)
          }
        })

        onTransformEnd(patches)
      }}
    />
  )
}
