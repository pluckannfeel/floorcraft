import { useEffect, useRef } from 'react'
import type Konva from 'konva'
import { Transformer } from 'react-konva'
import { NO_GUIDES, snapResizeBox } from './AlignmentGuides'
import type { GuideLines } from './AlignmentGuides'
import { constrainTransformBox, MIN_ITEM_SIZE } from './coordinates'
import type { CanvasObject } from './types'

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
 * Resolves the array Konva's `Transformer.nodes()` should be called with for
 * a given selection: zero nodes when nothing is selected (or the selected
 * id has no registered node yet), exactly one otherwise. Pure and
 * Konva-independent so the "switch selection -> attach the right node"
 * logic is testable without mounting a real `Transformer`.
 *
 * Calling `.nodes()` with the result of this function is itself both the
 * detach-from-old and attach-to-new step: Konva's `Transformer.nodes()`
 * fully replaces whatever was previously attached, so there's no separate
 * detach call needed when selection changes.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveTransformerNodes(
  selectedItemId: CanvasObject['id'] | null,
  getNode: (id: CanvasObject['id']) => Konva.Node | undefined,
): Konva.Node[] {
  if (selectedItemId == null) return []
  const node = getNode(selectedItemId)
  return node ? [node] : []
}

interface SelectionTransformerProps {
  selectedItemId: CanvasObject['id'] | null
  /** Resolves the selected item's live Konva node from the parent-owned
   * `Map<id, Konva.Node>` populated by `ObjectShape`'s `shapeRef` callback. */
  getNode: (id: CanvasObject['id']) => Konva.Node | undefined
  canvasWidth: number
  canvasHeight: number
  onTransformEnd: (id: CanvasObject['id'], patch: TransformGeometryPatch) => void
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
 * Wraps Konva's `Transformer` (U8). Attaches to the selected item's node via
 * `.nodes([ref])` — NOT the deprecated `.attachTo` — in an effect keyed on
 * `selectedItemId`. Calling `.nodes()` again with a new array (or `[]`) both
 * detaches whatever was previously attached and attaches the new selection
 * in one call, so switching selection needs no separate detach step.
 *
 * Applies uniformly to catalog Objects and Shapes (R21). Lines get a
 * distinct point-based editing model (U17, `LineAnchorHandles`) instead of
 * this Transformer — this component doesn't need to know about that split;
 * whichever caller renders it (later, type-dispatching in `ObjectShape`)
 * simply won't render it for Line-typed selections.
 */
export function SelectionTransformer({
  selectedItemId,
  getNode,
  canvasWidth,
  canvasHeight,
  onTransformEnd,
  allObjects,
  zoom = 1,
  onAlignmentGuidesChange,
}: SelectionTransformerProps) {
  const transformerRef = useRef<Konva.Transformer>(null)

  useEffect(() => {
    const transformer = transformerRef.current
    if (!transformer) return

    transformer.nodes(resolveTransformerNodes(selectedItemId, getNode))
    transformer.getLayer()?.batchDraw()
  }, [selectedItemId, getNode])

  return (
    <Transformer
      ref={transformerRef}
      // U19: alignment-snap runs first (adjusting newBox's x/y/width/height
      // per whichever edge matched — see `AlignmentGuides.tsx`'s
      // `snapResizeBox`/`applyAxisSnapToEdge`), then the existing
      // `constrainTransformBox` bounds/min-size clamp always runs last on
      // the (possibly snapped) box — same snap-then-clamp order U8's drag
      // path already established, applied here to resize too.
      boundBoxFunc={(oldBox, newBox) => {
        if (selectedItemId == null) return constrainTransformBox(oldBox, newBox, canvasWidth, canvasHeight)
        const { box: snapped, guides } = snapResizeBox(newBox, allObjects ?? [], selectedItemId, zoom)
        onAlignmentGuidesChange?.(guides)
        return constrainTransformBox(oldBox, { ...newBox, ...snapped }, canvasWidth, canvasHeight)
      }}
      onTransformEnd={(event) => {
        // U19: destroy the temporary guide lines once the resize
        // interaction ends (Approach: guides are removed on
        // dragend/transformend).
        onAlignmentGuidesChange?.(NO_GUIDES)
        if (selectedItemId == null) return
        const node = event.target

        const patch = computeGeometryFromTransform({
          x: node.x(),
          y: node.y(),
          width: node.width(),
          height: node.height(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
          rotation: node.rotation(),
        })

        // Reset scale to 1 and bake the folded dimensions directly onto the
        // node so there's no visual snap-back flicker before the store
        // update round-trips through React.
        node.scaleX(1)
        node.scaleY(1)
        node.width(patch.width)
        node.height(patch.height)

        onTransformEnd(selectedItemId, patch)
      }}
    />
  )
}
