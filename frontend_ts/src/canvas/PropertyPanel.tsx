import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isLineTool } from './LineTool'
import {
  isTextType,
  measureTextBox,
  MIN_TEXT_FONT_SIZE,
  parseTextProperties,
  TEXT_FONT_FAMILIES,
} from './TextTool'
import type { TextStyling } from './TextTool'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject, ObjectType } from './types'
import { isCatalogType, VISUAL_PRESET_KEY, VISUAL_VARIANT_ID_KEY } from './visuals'

/**
 * R19/U10: a persistent side panel, visible whenever the selection is
 * non-empty. With EXACTLY ONE Object selected it shows that Object's
 * free-text `name` and a generic key-value editor for whatever's in its
 * `properties` JSON; with 2+ selected (U1's selection set) it shows an
 * "N objects selected" placeholder instead — the plan's exactly-one
 * contract (multi-editing properties is out of scope; the form's
 * remount-per-id and commit-on-unmount machinery below is inherently
 * single-item).
 *
 * Per the Key Technical Decisions ("no fixed per-catalog-type property
 * schema in this pass"), `properties` is edited generically — whatever
 * keys/values a user has entered — for every type. The one exception is
 * Lines: `properties.points`/`properties.curve_style` are structural data
 * rendered/edited via U17's `LineAnchorHandles`, not user-editable text
 * here, so those two keys are excluded from the generic editor for
 * line-typed Objects specifically (`LINE_STRUCTURAL_KEYS` below).
 *
 * Reads/writes go straight to `items[i].name`/`items[i].properties` via
 * `updateItemProperties` (see canvasStore.ts's "U10 finding" doc comment) —
 * NOT a separate `itemProperties` map. That map was U9's original scaffold
 * for this unit, but `ObjectShape.tsx` has always rendered `name` and (for
 * Lines) `properties.points` straight off `items[i]`; a map nothing reads
 * from would silently disconnect what this panel saves from what actually
 * renders. `updateItemProperties` keeps edits out of undo history (R15) via
 * zundo's `temporal.pause()`/`resume()`, not by living outside `items`.
 *
 * Values in the generic editor are edited/stored as plain strings — this
 * codebase's `properties` values may be arbitrary JSON, but the plan's
 * explicit "no per-type schema, free-form JSON edited generically" scope
 * stops short of specifying type-aware value widgets (number pickers,
 * checkboxes, etc.); a plain text value per key is the simplest generic
 * editor that satisfies R19 without inventing per-type UI the plan didn't
 * ask for. Non-string existing values are stringified for display/editing.
 *
 * `PropertyPanelForm` (below) is remounted via `key={selectedItem.id}`
 * whenever the selection changes, rather than resetting its local state
 * from a `useEffect`. This gets two things for free: (1) fresh local
 * `name`/`rows` state for the newly-selected item via `useState`
 * initializers, no effect-driven reset needed, and (2) "switching selection
 * while a field is mid-edit commits the pending edit first" falls directly
 * out of React's unmount-before-mount ordering — the outgoing form's
 * cleanup effect (an unmount handler) fires and flushes any pending edit
 * before the incoming form for the new selection ever renders.
 *
 * Explicit-save model: commits go straight to the store via
 * `updateItemProperties` (the instant local feedback R19 asks for) and
 * nowhere else — like every other canvas edit they stay local, marking the
 * store dirty, until the user explicitly saves (Save button / Ctrl+S in
 * `CanvasEditorPage`).
 */

const LINE_STRUCTURAL_KEYS = new Set(['points', 'curve_style'])

/** U7: a text object's reserved keys — `text` is the content (edited via
 * the canvas overlay, never as a raw key-value row) and the styling keys
 * get dedicated controls below (`TextStylingFields`), so all six hide from
 * the generic editor — the same treatment as `LINE_STRUCTURAL_KEYS`. */
const TEXT_STRUCTURAL_KEYS = new Set([
  'text',
  'font_family',
  'font_size',
  'bold',
  'italic',
  'color',
])

/** U6 (object-visuals; R15): a catalog object's variant reference —
 * `visual_variant_id`, the opaque server id `resolveBoxVisual` renders the
 * uploaded image from — is STRUCTURAL data exactly like a Line's `points`:
 * hidden from the generic rows and preserved verbatim through every commit
 * (the C1 corruption fix — `rowsToProperties` stringifies values, and a
 * stringified reference would fail the defensive parser and silently
 * demote the image to its placeholder symbol forever). All 7 catalog types
 * get this exclusion whether or not a reference is currently present, so
 * a user can't pre-plant the key either. */
const VISUAL_STRUCTURAL_KEYS = new Set([VISUAL_VARIANT_ID_KEY, VISUAL_PRESET_KEY])

function excludedKeysForType(type: ObjectType): Set<string> {
  if (isLineTool(type)) return LINE_STRUCTURAL_KEYS
  if (isTextType(type)) return TEXT_STRUCTURAL_KEYS
  if (isCatalogType(type)) return VISUAL_STRUCTURAL_KEYS
  return new Set()
}

interface PropertyRow {
  /** Stable identity for React list rendering, decoupled from `key` so an
   * in-progress key edit doesn't change the row's React `key` mid-edit. */
  rowId: string
  key: string
  value: string
  /** True for rows sourced from the selected item's existing `properties`;
   * false for a row added via "+ Add property" this session. Existing
   * keys are read-only (renaming would otherwise require diffing old-key
   * vs new-key identity) — only the value is editable; new rows allow
   * editing both key and value. */
  isExisting: boolean
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function rowsFromProperties(properties: Record<string, unknown>, excludedKeys: Set<string>): PropertyRow[] {
  return Object.entries(properties)
    .filter(([key]) => !excludedKeys.has(key))
    .map(([key, value]) => ({ rowId: key, key, value: stringifyValue(value), isExisting: true }))
}

/**
 * U6 commit-side guard (doc-review: adversarial): rows whose TRIMMED key
 * collides with an excluded (structural) key are dropped from the committed
 * properties — hiding structural keys from the row editor
 * (`rowsFromProperties`) alone doesn't stop "+ Add property" from typing
 * the reserved key by hand, and without this filter such a row would ride
 * `Object.assign` in `commit()` and clobber the preserved structural value
 * (for a variant object: overwrite the numeric `visual_variant_id` with a
 * string, silently killing the image, R15; for a Line: corrupt `points`).
 * Filtering here keeps the guard symmetric with the diffing — a
 * reserved-key row contributes nothing to `currentEditable`, so it can
 * neither commit nor even mark the form changed.
 */
function rowsToProperties(rows: PropertyRow[], excludedKeys: Set<string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const trimmedKey = row.key.trim()
    if (trimmedKey === '') continue
    if (excludedKeys.has(trimmedKey)) continue
    result[trimmedKey] = row.value
  }
  return result
}

function shallowEqualStringRecords(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => a[key] === b[key])
}

type PropertiesPatch = { name?: string; properties?: Record<string, unknown> }

/** U7: the untracked text-styling commit shape — the full next
 * `properties` object plus the remeasured mirrored box, matching the
 * store's `updateItemTextStyling`. */
type TextStylingCommit = (
  id: CanvasObject['id'],
  properties: Record<string, unknown>,
  size: { width: number; height: number },
) => void

interface TextStylingFieldsProps {
  item: CanvasObject
  onCommitStyling: TextStylingCommit
}

/**
 * U7: dedicated styling controls for a selected TEXT object — font family
 * (curated `TEXT_FONT_FAMILIES` select), font size, bold/italic toggles,
 * and color. Every commit goes through the UNTRACKED styling path (R15:
 * styling edits create no undo history — `updateItemTextStyling`) and
 * carries the REMEASURED mirrored width/height in the same store write, so
 * box-derived math (marquee/align/groups) never sees a stale box.
 *
 * The select/color/toggle controls are store-controlled (they re-render
 * from `item.properties` after each commit); the font-size input keeps
 * local draft state and commits on blur like the panel's other text
 * inputs, clamped to `MIN_TEXT_FONT_SIZE`.
 */
function TextStylingFields({ item, onCommitStyling }: TextStylingFieldsProps) {
  const styling = parseTextProperties(item.properties)
  const [fontSizeDraft, setFontSizeDraft] = useState(String(styling.font_size))

  function commitStyling(patch: Partial<TextStyling>) {
    const next = { ...styling, ...patch }
    // Full-replacement properties (the `updateItemProperties` convention),
    // preserving the content key and any generic keys the styling controls
    // don't own.
    const nextProperties: Record<string, unknown> = {
      ...item.properties,
      font_family: next.font_family,
      font_size: next.font_size,
      bold: next.bold,
      italic: next.italic,
      color: next.color,
    }
    onCommitStyling(item.id, nextProperties, measureTextBox(next.text, next))
  }

  function commitFontSizeDraft() {
    const parsed = Number(fontSizeDraft)
    const fontSize = Number.isFinite(parsed)
      ? Math.max(MIN_TEXT_FONT_SIZE, parsed)
      : styling.font_size
    setFontSizeDraft(String(fontSize))
    if (fontSize !== styling.font_size) commitStyling({ font_size: fontSize })
  }

  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">Text style</div>

      <Label htmlFor="property-panel-font-family" className="mb-1">
        Font
      </Label>
      <select
        id="property-panel-font-family"
        value={styling.font_family}
        onChange={(event) => commitStyling({ font_family: event.target.value })}
        className="mb-2 h-8 w-full rounded-md border bg-transparent px-2 text-sm"
      >
        {TEXT_FONT_FAMILIES.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>

      <Label htmlFor="property-panel-font-size" className="mb-1">
        Size
      </Label>
      <Input
        id="property-panel-font-size"
        type="number"
        min={MIN_TEXT_FONT_SIZE}
        value={fontSizeDraft}
        onChange={(event) => setFontSizeDraft(event.target.value)}
        onBlur={commitFontSizeDraft}
        onKeyDown={(event) => {
          // Enter commits the size draft immediately, like the panel's
          // other fields (user feedback).
          if (event.key === 'Enter') {
            event.preventDefault()
            commitFontSizeDraft()
          }
        }}
        className="mb-2"
      />

      <div className="mb-2 flex items-center gap-1">
        <Button
          type="button"
          variant={styling.bold ? 'default' : 'outline'}
          size="icon-sm"
          aria-label="Bold"
          aria-pressed={styling.bold}
          onClick={() => commitStyling({ bold: !styling.bold })}
        >
          <span className="font-bold">B</span>
        </Button>
        <Button
          type="button"
          variant={styling.italic ? 'default' : 'outline'}
          size="icon-sm"
          aria-label="Italic"
          aria-pressed={styling.italic}
          onClick={() => commitStyling({ italic: !styling.italic })}
        >
          <span className="italic">I</span>
        </Button>
      </div>

      <Label htmlFor="property-panel-text-color" className="mb-1">
        Color
      </Label>
      <Input
        id="property-panel-text-color"
        type="color"
        value={styling.color}
        onChange={(event) => commitStyling({ color: event.target.value })}
      />
    </div>
  )
}

interface PropertyPanelFormProps {
  item: CanvasObject
  onCommit: (id: CanvasObject['id'], patch: PropertiesPatch) => void
  /** U7: the untracked text-styling commit (see `TextStylingFields`) —
   * only used when `item` is a text object. */
  onCommitTextStyling: TextStylingCommit
}

/**
 * The actual editable form for one selected item. Remounted (via the
 * parent's `key={item.id}`) on every selection change — see the module doc
 * for why that's what makes "commit pending edit on selection switch" work
 * without any imperative selection-change detection.
 */
function PropertyPanelForm({ item, onCommit, onCommitTextStyling }: PropertyPanelFormProps) {
  const excludedKeys = excludedKeysForType(item.type)

  const [name, setName] = useState(item.name)
  const [rows, setRows] = useState<PropertyRow[]>(() => rowsFromProperties(item.properties, excludedKeys))

  // Tracks the last value actually saved to the store for this mount (starts
  // at the item's original values). Blur-commits and the unmount-flush both
  // diff against this, not directly against each other, so a mid-session
  // blur-commit followed later by an unmount-flush doesn't re-send an
  // already-saved value.
  const committedRef = useRef({ name: item.name, properties: item.properties })
  // Mirrors `name`/`rows` state, updated in the same event handlers that
  // call `setName`/`setRows` — used by the unmount-flush below, which (as
  // a `useEffect` cleanup with an empty dependency array) only ever closes
  // over the values from the initial render otherwise. Written from event
  // handlers only, never during render.
  const draftRef = useRef({ name, rows })

  function commit(nextName: string, nextRows: PropertyRow[]) {
    const patch: PropertiesPatch = {}

    if (nextName !== committedRef.current.name) {
      patch.name = nextName
    }

    const currentEditable = rowsToProperties(nextRows, excludedKeys)
    const committedEditable = rowsToProperties(
      rowsFromProperties(committedRef.current.properties, excludedKeys),
      excludedKeys,
    )
    if (!shallowEqualStringRecords(currentEditable, committedEditable)) {
      // Preserve excluded (structural) keys from the item's LIVE properties
      // (the `item` prop, always fresh on each render), not the possibly-
      // stale `committedRef` snapshot. An external writer — e.g.
      // `LineAnchorHandles` reshaping a Line — updates `properties.points`
      // directly in the store without remounting this form (same
      // `item.id` key), so reading `committedRef` here would silently
      // revert that external change the next time any editable field is
      // committed.
      const nextProperties: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(item.properties)) {
        if (excludedKeys.has(key)) nextProperties[key] = value
      }
      Object.assign(nextProperties, currentEditable)
      patch.properties = nextProperties
    }

    if (patch.name === undefined && patch.properties === undefined) return

    onCommit(item.id, patch)
    committedRef.current = {
      name: patch.name ?? committedRef.current.name,
      properties: patch.properties ?? committedRef.current.properties,
    }
  }

  useEffect(() => {
    return () => {
      commit(draftRef.current.name, draftRef.current.rows)
    }
    // Empty deps deliberately: this component is remounted (fresh `item`,
    // fresh refs) whenever the selection changes, via the parent's
    // `key={item.id}` — so this cleanup running exactly once, on unmount,
    // is exactly "flush before the next selection's form mounts".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleNameChange(value: string) {
    setName(value)
    draftRef.current = { ...draftRef.current, name: value }
  }

  function handleRowsChange(nextRows: PropertyRow[]) {
    setRows(nextRows)
    draftRef.current = { ...draftRef.current, rows: nextRows }
  }

  function handleBlur() {
    commit(draftRef.current.name, draftRef.current.rows)
  }

  /** Enter commits the pending field edit immediately (user feedback) —
   * the same commit blur runs, without stealing focus. The window-level
   * Enter-to-save shortcut skips editable targets, so a field-level Enter
   * commits HERE and only here. */
  function handleFieldKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      handleBlur()
    }
  }

  function handleAddRow() {
    handleRowsChange([...rows, { rowId: crypto.randomUUID(), key: '', value: '', isExisting: false }])
  }

  function handleDeleteRow(rowId: string) {
    const nextRows = rows.filter((row) => row.rowId !== rowId)
    handleRowsChange(nextRows)
    commit(name, nextRows)
  }

  return (
    <>
      <div>
        <div className="text-xs text-muted-foreground">{item.type}</div>
        <Label htmlFor="property-panel-name" className="mt-2 mb-1">
          Name
        </Label>
        <Input
          id="property-panel-name"
          type="text"
          value={name}
          onChange={(event) => handleNameChange(event.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleFieldKeyDown}
        />
      </div>

      {/* U7: text objects get dedicated styling controls (untracked commit
          path + mirrored-box remeasure); their reserved keys are excluded
          from the generic editor below via TEXT_STRUCTURAL_KEYS. */}
      {isTextType(item.type) && (
        <TextStylingFields item={item} onCommitStyling={onCommitTextStyling} />
      )}

      <div>
        <div className="mb-1 text-xs text-muted-foreground">Properties</div>
        {rows.map((row) => (
          <div key={row.rowId} className="mb-1 flex items-center gap-1">
            <Input
              aria-label={row.isExisting ? `Property key ${row.key}` : 'New property key'}
              type="text"
              value={row.key}
              readOnly={row.isExisting}
              onChange={(event) =>
                handleRowsChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, key: event.target.value } : r)))
              }
              onBlur={handleBlur}
              onKeyDown={handleFieldKeyDown}
              className="flex-1"
            />
            <Input
              aria-label={`Property value for ${row.key || row.rowId}`}
              type="text"
              value={row.value}
              onChange={(event) =>
                handleRowsChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, value: event.target.value } : r)))
              }
              onBlur={handleBlur}
              onKeyDown={handleFieldKeyDown}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete property ${row.key}`}
              onClick={() => handleDeleteRow(row.rowId)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={handleAddRow}>
          + Add property
        </Button>
      </div>
    </>
  )
}

export function PropertyPanel() {
  const items = useCanvasStore((state) => state.items)
  const selectedItemIds = useCanvasStore((state) => state.selectedItemIds)
  const updateItemProperties = useCanvasStore((state) => state.updateItemProperties)
  // U7: the untracked text-styling path (properties + mirrored box in one
  // paused set() — see canvasStore.ts).
  const updateItemTextStyling = useCanvasStore((state) => state.updateItemTextStyling)

  // Resolve the selection against `items` (dropping any id without a live
  // item) so the exactly-one/placeholder branch below can never try to
  // render a form for a nonexistent item.
  const selectedItems = items.filter((item) => selectedItemIds.includes(item.id))

  if (selectedItems.length === 0) return null

  return (
    <aside
      aria-label="Property panel"
      className="flex w-[260px] flex-col gap-3 overflow-y-auto border-l p-4"
    >
      {selectedItems.length === 1 ? (
        <PropertyPanelForm
          key={selectedItems[0].id}
          item={selectedItems[0]}
          onCommit={updateItemProperties}
          onCommitTextStyling={updateItemTextStyling}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {selectedItems.length} objects selected
        </p>
      )}
    </aside>
  )
}
