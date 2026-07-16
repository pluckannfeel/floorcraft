import type Konva from 'konva'
import { describe, expect, it } from 'vitest'
import { MIN_ITEM_SIZE } from './coordinates'
import { computeGeometryFromTransform, resolveTransformerNodes } from './SelectionTransformer'

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

  it('resolves an empty array for a multi-selection (U1: transformer attaches only for exactly-one; U3 extends to multi-node)', () => {
    const nodes = new Map<string | number, Konva.Node>([
      ['a', fakeNode('a')],
      ['b', fakeNode('b')],
    ])
    const getNode = (id: string | number) => nodes.get(id)
    expect(resolveTransformerNodes(['a', 'b'], getNode)).toEqual([])
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
