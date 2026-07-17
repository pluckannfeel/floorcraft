import type Konva from 'konva'
import { describe, expect, it } from 'vitest'
import { getRotatedBoundingBox, MIN_ITEM_SIZE } from './coordinates'
import {
  computeGeometryFromTransform,
  computeTransformCommit,
  resolveTransformerNodes,
} from './SelectionTransformer'

/**
 * `SelectionTransformer` wraps Konva's `Transformer`, which requires a real
 * canvas to construct/render — jsdom (this project's test environment) has
 * no canvas implementation, so mounting the actual `<Transformer>` /
 * `<Stage>` tree isn't practical here (consistent with the rest of this
 * codebase: no existing test mounts a Konva component either, only pure
 * `coordinates.ts` logic is exercised via `@testing-library`-free unit
 * tests).
 *
 * What IS automated-tested below, thoroughly:
 *   - `computeGeometryFromTransform`: the exact scale-folding math the
 *     plan calls out (scaleX/scaleY -> width/height, min-size clamp,
 *     rotation passthrough) — this is the entire "resize updates stored
 *     width/height, not scale" and "resizing below minimum is clamped"
 *     behavior, and it's fully Konva-independent.
 *   - `resolveTransformerNodes`: the exact "which node(s) should
 *     `Transformer.nodes()` be called with" logic that implements
 *     switch-selection-detaches-old-attaches-new — Konva's own
 *     `Transformer.nodes()` API guarantees that calling it with a new
 *     array both detaches whatever was previously attached and attaches
 *     the new list in one call, so testing that this function resolves
 *     the correct array for each selection state is equivalent to testing
 *     the detach/attach behavior itself, without needing a live Konva node.
 *
 * What is NOT automated-tested here, and why:
 *   - That clicking an Object in a real browser actually shows resize
 *     handles, that dragging a handle actually fires `onTransformEnd`
 *     with the values Konva computed, or that `dragBoundFunc`/
 *     `boundBoxFunc` are wired to the right Konva props at runtime. These
 *     require real pointer-drag physics against an actual `<canvas>`
 *     element, which jsdom cannot provide. This was verified by
 *     (a) code-reading each wiring point against Konva's documented
 *     `Transformer`/`dragBoundFunc` React API, and (b) the fact that
 *     `boundBoxFunc`/`onTransformEnd` in `SelectionTransformer.tsx` and
 *     `dragBoundFunc`/`onDragEnd` in `ObjectShape.tsx` delegate all of
 *     their actual decision logic to the pure, fully-tested functions in
 *     `coordinates.ts` and this file — the only untested surface is the
 *     thin Konva-prop plumbing itself (reading `node.x()`/`scaleX()`/etc.
 *     and calling the pure function), not any independent logic.
 */

describe('computeGeometryFromTransform', () => {
  it('folds scaleX/scaleY into width/height rather than leaving them as scale', () => {
    const patch = computeGeometryFromTransform({
      x: 50,
      y: 60,
      width: 40,
      height: 40,
      scaleX: 2,
      scaleY: 1.5,
      rotation: 0,
    })
    expect(patch).toEqual({ x: 50, y: 60, width: 80, height: 60, rotation: 0 })
  })

  it('passes x/y/rotation through unchanged', () => {
    const patch = computeGeometryFromTransform({
      x: 12,
      y: 34,
      width: 100,
      height: 50,
      scaleX: 1,
      scaleY: 1,
      rotation: 47,
    })
    expect(patch.x).toBe(12)
    expect(patch.y).toBe(34)
    expect(patch.rotation).toBe(47)
    expect(patch.width).toBe(100)
    expect(patch.height).toBe(50)
  })

  it('clamps a resize that would fall below the minimum size', () => {
    const patch = computeGeometryFromTransform({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      scaleX: 0.1, // 40 * 0.1 = 4px, below MIN_ITEM_SIZE (10)
      scaleY: 0.1,
      rotation: 0,
    })
    expect(patch.width).toBe(MIN_ITEM_SIZE)
    expect(patch.height).toBe(MIN_ITEM_SIZE)
  })

  it('respects a custom minSize override', () => {
    const patch = computeGeometryFromTransform(
      { x: 0, y: 0, width: 40, height: 40, scaleX: 0.5, scaleY: 0.5, rotation: 0 },
      25,
    )
    // 40 * 0.5 = 20, below the custom minSize of 25.
    expect(patch.width).toBe(25)
    expect(patch.height).toBe(25)
  })

  it('does not clamp a resize that stays above the minimum size', () => {
    const patch = computeGeometryFromTransform({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      scaleX: 0.5,
      scaleY: 0.5,
      rotation: 0,
    })
    expect(patch.width).toBe(20)
    expect(patch.height).toBe(20)
  })
})

describe('resolveTransformerNodes', () => {
  function fakeNode(id: string): Konva.Node {
    return { id } as unknown as Konva.Node
  }

  it('resolves an empty array when nothing is selected', () => {
    const getNode = () => fakeNode('a')
    expect(resolveTransformerNodes([], getNode)).toEqual([])
  })

  it('resolves a single-element array for an exactly-one selection', () => {
    const nodeA = fakeNode('a')
    const getNode = (id: string | number) => (id === 'a' ? nodeA : undefined)
    expect(resolveTransformerNodes(['a'], getNode)).toEqual([nodeA])
  })

  it('resolves an empty array when the selected id has no registered node', () => {
    const getNode = () => undefined
    expect(resolveTransformerNodes(['missing'], getNode)).toEqual([])
  })

  it('resolves EVERY selected node for a multi-selection, in selection order (U3 multi-node transformer)', () => {
    const nodeA = fakeNode('a')
    const nodeB = fakeNode('b')
    const nodes = new Map<string | number, Konva.Node>([
      ['a', nodeA],
      ['b', nodeB],
    ])
    const getNode = (id: string | number) => nodes.get(id)
    expect(resolveTransformerNodes(['b', 'a'], getNode)).toEqual([nodeB, nodeA])
  })

  it('skips unregistered ids inside a multi-selection instead of dropping the whole attach', () => {
    const nodeA = fakeNode('a')
    const getNode = (id: string | number) => (id === 'a' ? nodeA : undefined)
    expect(resolveTransformerNodes(['missing', 'a'], getNode)).toEqual([nodeA])
  })

  it('switching selection resolves the new node only, not the old one (detach-then-attach)', () => {
    const nodeA = fakeNode('a')
    const nodeB = fakeNode('b')
    const nodes = new Map<string | number, Konva.Node>([
      ['a', nodeA],
      ['b', nodeB],
    ])
    const getNode = (id: string | number) => nodes.get(id)

    const first = resolveTransformerNodes(['a'], getNode)
    expect(first).toEqual([nodeA])

    const second = resolveTransformerNodes(['b'], getNode)
    expect(second).toEqual([nodeB])
    expect(second).not.toContain(nodeA)
  })
})

// U3: the pure multi-node `transformend` commit math — the component reads
// each attached node into a `MemberTransformState` and delegates every
// decision here, so the whole decomposition is jsdom-testable.
describe('computeTransformCommit', () => {
  it('folds each BOX member\'s scale into its own width/height (AE2 multi-resize)', () => {
    const patches = computeTransformCommit([
      {
        id: 'a',
        snapshot: { x: 0, y: 0, width: 40, height: 40, scaleX: 2, scaleY: 1.5, rotation: 0 },
      },
      {
        id: 'b',
        snapshot: { x: 100, y: 50, width: 80, height: 20, scaleX: 2, scaleY: 1.5, rotation: 0 },
      },
    ])

    expect(patches).toEqual([
      { id: 'a', patch: { x: 0, y: 0, width: 80, height: 60, rotation: 0 } },
      { id: 'b', patch: { x: 100, y: 50, width: 160, height: 30, rotation: 0 } },
    ])
  })

  it("scales a LINE member's points proportionally and recomputes its bbox metadata (AE2)", () => {
    // The Line node ended the transform translated to (10, 20) and scaled
    // (2, 0.5); its pre-bake points are still the store's absolute points.
    const [patch] = computeTransformCommit([
      {
        id: 'wall',
        snapshot: { x: 10, y: 20, width: 0, height: 0, scaleX: 2, scaleY: 0.5, rotation: 0 },
        linePoints: [
          { x: 100, y: 100 },
          { x: 200, y: 300 },
        ],
      },
    ])

    expect(patch.id).toBe('wall')
    expect(patch.patch.points).toEqual([
      { x: 210, y: 70 },
      { x: 410, y: 170 },
    ])
    // Segment deltas scaled by exactly (2, 0.5): proportional, not skewed.
    expect(patch.patch).toMatchObject({ x: 210, y: 70, width: 200, height: 100 })
  })

  it('clamps each member to the minimum size independently during a group scale-down', () => {
    const patches = computeTransformCommit([
      // 100px wide: 100 * 0.2 = 20 — above MIN_ITEM_SIZE, folds normally.
      { id: 'big', snapshot: { x: 0, y: 0, width: 100, height: 100, scaleX: 0.2, scaleY: 0.2, rotation: 0 } },
      // 20px wide: 20 * 0.2 = 4 — below MIN_ITEM_SIZE, clamps to 10.
      { id: 'small', snapshot: { x: 50, y: 50, width: 20, height: 20, scaleX: 0.2, scaleY: 0.2, rotation: 0 } },
    ])

    expect(patches[0].patch).toMatchObject({ width: 20, height: 20 })
    expect(patches[1].patch).toMatchObject({ width: MIN_ITEM_SIZE, height: MIN_ITEM_SIZE })
  })

  it('a ROTATED member keeps its visual position through the decomposition (pure numeric check)', () => {
    // A 40x60 member at 30° that ends a group transform scaled (1.5, 2):
    // BEFORE the bake, Konva renders it as a 40x60 rect with scale (1.5, 2)
    // at rotation 30° — visually identical to a 60x120 rect at the same
    // x/y/rotation with scale 1 (Konva applies scale innermost). The folded
    // patch must therefore produce the exact same rotated bounding box.
    const snapshot = { x: 120, y: 80, width: 40, height: 60, scaleX: 1.5, scaleY: 2, rotation: 30 }
    const [{ patch }] = computeTransformCommit([{ id: 'rotated', snapshot }])

    const visualBoxBeforeBake = getRotatedBoundingBox(
      { x: snapshot.x, y: snapshot.y },
      snapshot.width * snapshot.scaleX,
      snapshot.height * snapshot.scaleY,
      snapshot.rotation,
    )
    const visualBoxAfterBake = getRotatedBoundingBox(
      { x: patch.x ?? 0, y: patch.y ?? 0 },
      patch.width ?? 0,
      patch.height ?? 0,
      patch.rotation ?? 0,
    )

    expect(visualBoxAfterBake.x).toBeCloseTo(visualBoxBeforeBake.x)
    expect(visualBoxAfterBake.y).toBeCloseTo(visualBoxBeforeBake.y)
    expect(visualBoxAfterBake.width).toBeCloseTo(visualBoxBeforeBake.width)
    expect(visualBoxAfterBake.height).toBeCloseTo(visualBoxBeforeBake.height)
    expect(patch.rotation).toBe(30)
  })

  it('a mixed box+line selection produces one patch per member, in member order', () => {
    const patches = computeTransformCommit([
      { id: 'box', snapshot: { x: 0, y: 0, width: 40, height: 40, scaleX: 1, scaleY: 1, rotation: 0 } },
      {
        id: 'line',
        snapshot: { x: 0, y: 0, width: 0, height: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        linePoints: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
    ])

    expect(patches.map((entry) => entry.id)).toEqual(['box', 'line'])
    expect(patches[0].patch.points).toBeUndefined()
    expect(patches[1].patch.points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ])
  })

  it('a degenerate 0-point line member commits empty points without bbox metadata (no NaN/Infinity)', () => {
    const [{ patch }] = computeTransformCommit([
      {
        id: 'empty',
        snapshot: { x: 5, y: 5, width: 0, height: 0, scaleX: 2, scaleY: 2, rotation: 0 },
        linePoints: [],
      },
    ])

    expect(patch.points).toEqual([])
    expect(patch.x).toBeUndefined()
    expect(patch.width).toBeUndefined()
  })
})
