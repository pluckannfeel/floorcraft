import { useEffect, useRef, useState } from 'react'
import { isLineTool } from './LineTool'
import { useCanvasStore } from '../state/canvasStore'
import type { CanvasObject, ObjectType } from './types'

/**
 * R19/U10: a persistent side panel, visible whenever `selectedItemId` is
 * set, showing the selected Object's free-text `name` and a generic
 * key-value editor for whatever's in its `properties` JSON.
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
 * U13 update: still commits straight to the store via `updateItemProperties`
 * (unchanged from U10 — the instant local feedback R19 asks for), but now
 * ALSO invokes an optional `onPersist(id, patch, previousItem)` callback
 * after that local commit, which `CanvasEditorPage` wires to
 * `handlePropertiesCommit` (dispatching the matching `PATCH` + rollback-on-
 * failure via `useObjects.ts`'s `useObjectPersistence`). `onPersist` is
 * optional (not a required prop replacing the store call) specifically so
 * this component's existing test suite — which renders `<PropertyPanel />`
 * directly against a manually-seeded store, with no `CanvasEditorPage`/
 * mutation machinery in play — keeps working unchanged; U13 only adds a
 * side channel, it doesn't change who owns the local write.
 */

const LINE_STRUCTURAL_KEYS = new Set(['points', 'curve_style'])

function excludedKeysForType(type: ObjectType): Set<string> {
  return isLineTool(type) ? LINE_STRUCTURAL_KEYS : new Set()
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

function rowsToProperties(rows: PropertyRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const trimmedKey = row.key.trim()
    if (trimmedKey === '') continue
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

interface PropertyPanelFormProps {
  item: CanvasObject
  onCommit: (id: CanvasObject['id'], patch: PropertiesPatch) => void
}

/**
 * The actual editable form for one selected item. Remounted (via the
 * parent's `key={item.id}`) on every selection change — see the module doc
 * for why that's what makes "commit pending edit on selection switch" work
 * without any imperative selection-change detection.
 */
function PropertyPanelForm({ item, onCommit }: PropertyPanelFormProps) {
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

    const currentEditable = rowsToProperties(nextRows)
    const committedEditable = rowsToProperties(rowsFromProperties(committedRef.current.properties, excludedKeys))
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
        <div style={{ fontSize: 12, color: '#6b7280' }}>{item.type}</div>
        <label htmlFor="property-panel-name" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
          Name
        </label>
        <input
          id="property-panel-name"
          type="text"
          value={name}
          onChange={(event) => handleNameChange(event.target.value)}
          onBlur={handleBlur}
          style={{ width: '100%' }}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Properties</div>
        {rows.map((row) => (
          <div key={row.rowId} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input
              aria-label={row.isExisting ? `Property key ${row.key}` : 'New property key'}
              type="text"
              value={row.key}
              readOnly={row.isExisting}
              onChange={(event) =>
                handleRowsChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, key: event.target.value } : r)))
              }
              onBlur={handleBlur}
              style={{ width: '45%' }}
            />
            <input
              aria-label={`Property value for ${row.key || row.rowId}`}
              type="text"
              value={row.value}
              onChange={(event) =>
                handleRowsChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, value: event.target.value } : r)))
              }
              onBlur={handleBlur}
              style={{ width: '45%' }}
            />
            <button type="button" aria-label={`Delete property ${row.key}`} onClick={() => handleDeleteRow(row.rowId)}>
              ×
            </button>
          </div>
        ))}
        <button type="button" onClick={handleAddRow}>
          + Add property
        </button>
      </div>
    </>
  )
}

interface PropertyPanelProps {
  /** U13: called with (id, patch, previousItem) right after a commit has
   * already been applied locally via `updateItemProperties` — lets
   * `CanvasEditorPage` dispatch the matching persistence call without this
   * component needing to know TanStack Query/`useObjects.ts` exist.
   * Optional so tests/callers that only care about the local-store
   * behavior (all of this file's existing U10 tests) can omit it. */
  onPersist?: (id: CanvasObject['id'], patch: PropertiesPatch, previous: CanvasObject) => void
}

export function PropertyPanel({ onPersist }: PropertyPanelProps = {}) {
  const items = useCanvasStore((state) => state.items)
  const selectedItemId = useCanvasStore((state) => state.selectedItemId)
  const updateItemProperties = useCanvasStore((state) => state.updateItemProperties)

  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null

  const handleCommit = (id: CanvasObject['id'], patch: PropertiesPatch) => {
    const previous = items.find((item) => item.id === id)
    updateItemProperties(id, patch)
    if (previous) onPersist?.(id, patch, previous)
  }

  if (!selectedItem) return null

  return (
    <aside
      aria-label="Property panel"
      style={{
        width: 260,
        borderLeft: '1px solid #e5e7eb',
        padding: 16,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <PropertyPanelForm key={selectedItem.id} item={selectedItem} onCommit={handleCommit} />
    </aside>
  )
}
