import { useRef, useState, type KeyboardEvent } from "react";
import { useUpdateFloorPlanSettings } from "../hooks/useFloorPlans";
import {
  MIN_REAL_SIZE_PER_GRID_SQUARE,
  UNITS,
  formatMeasurement,
  type Unit,
} from "./rulers";

interface ScaleUnitControlProps {
  floorPlanId: number;
  /** Current persisted scale in CANONICAL METERS per grid square (U1) — the
   * source of truth, flowed from the `['floorPlan', id]` query so a
   * successful PATCH's cache-merge lands back here. */
  realSizePerGridSquare: number;
  /** Current persisted display unit. */
  unit: Unit;
}

/** Human labels for the unit `<select>` options. */
const UNIT_LABELS: Record<Unit, string> = {
  meters: "Meters",
  feet_inches: "Feet & inches",
};

/** The scale scalar is canonical meters, so it round-trips exactly through
 * the input; `String` (not `toFixed`) preserves whatever precision the user
 * typed (e.g. 0.9144 from a foot-based plan) without inventing digits. */
function formatScale(meters: number): string {
  return String(meters);
}

/**
 * U4/R1-R4/F1/AE2: the editor header's scale + unit control.
 *
 * Two independent controls, each PATCHing only its own field via
 * `useUpdateFloorPlanSettings` (the not-optimistic cache-merge hook): on
 * success the `['floorPlan', id]` cache merges, `CanvasEditorPage`
 * re-renders, and the U3 ruler overlay relabels live — no canvas save, no
 * refetch.
 *
 * - The numeric input edits the CANONICAL-METERS scalar directly (v1 scope:
 *   "edit the scalar real-size value; typing an imperial dimension is a
 *   panel-era concern") — hence the fixed `m` suffix regardless of the
 *   display unit. Commits on Enter/blur; an invalid (≤0 / non-finite) or
 *   unchanged value is a no-op that reverts to the persisted value.
 * - The `<select>` switches the DISPLAY unit; the physical size is
 *   unchanged (canonical meters stays), so the rulers merely relabel (AE2).
 *   When feet-and-inches is selected, the architectural equivalent of the
 *   current scale is shown as a hint (e.g. `= 3' 0"`).
 *
 * Both are genuine `INPUT`/`SELECT` elements, so the global Enter-finalize /
 * Escape / Delete handlers' `isEditableTarget` guard skips them — typing a
 * scale value and pressing Enter commits the input, never the canvas
 * (the global-shortcut-mid-gesture learning).
 */
export function ScaleUnitControl({
  floorPlanId,
  realSizePerGridSquare,
  unit,
}: ScaleUnitControlProps) {
  const update = useUpdateFloorPlanSettings(floorPlanId);
  const [draft, setDraft] = useState(() => formatScale(realSizePerGridSquare));
  // Enter/Escape both blur the input to release focus, and blur is itself a
  // commit path — so a keyboard action would otherwise commit twice (Enter)
  // or commit a stale draft (Escape, whose revert hasn't re-rendered yet).
  // This flag makes the immediately-following blur a no-op; a genuine
  // tab/click-away blur (flag unset) still commits. Same double-commit guard
  // as FloorPlanNameEditor's `finishedRef`.
  const suppressBlurRef = useRef(false);
  // Whether the scale input currently holds focus (i.e. the user is mid-edit).
  // Kept in STATE, not a ref, so the re-sync below can read it during render
  // (reading a ref during render is disallowed) and re-runs when it changes.
  const [focused, setFocused] = useState(false);

  // Re-sync the draft when the persisted scale changes from elsewhere (a
  // successful PATCH merges the cache → new prop). React's "adjust state
  // during render" pattern rather than an effect (avoids a cascading
  // re-render): track the last-seen persisted value and reset the draft when
  // it moves — but ONLY while the input is unfocused. A prior commit's PATCH
  // can resolve (moving the prop) WHILE the user has re-focused and is typing
  // a new value; re-syncing then would silently discard their uncommitted
  // text. When they blur, `commitScale` reconciles their draft against the
  // now-current persisted value.
  const [lastPersisted, setLastPersisted] = useState(realSizePerGridSquare);
  if (lastPersisted !== realSizePerGridSquare) {
    setLastPersisted(realSizePerGridSquare);
    if (!focused) setDraft(formatScale(realSizePerGridSquare));
  }

  const commitScale = () => {
    // Skip the blur that Enter/Escape triggers themselves (see the ref).
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    const parsed = Number(draft);
    // Reject empty / non-finite / below the shared floor (which also covers
    // zero and negatives) — the same MIN the backend validator enforces, so
    // a sub-floor value reverts silently here instead of round-tripping to a
    // 400. Revert to the persisted value rather than PATCHing garbage.
    if (
      draft.trim() === "" ||
      !Number.isFinite(parsed) ||
      parsed < MIN_REAL_SIZE_PER_GRID_SQUARE
    ) {
      setDraft(formatScale(realSizePerGridSquare));
      return;
    }
    if (parsed === realSizePerGridSquare) return; // unchanged: no PATCH.
    update.mutate(
      { real_size_per_grid_square: parsed },
      // On failure the cache was never touched, so revert the draft to the
      // (still-persisted) previous value — mirrors the rename revert.
      { onError: () => setDraft(formatScale(realSizePerGridSquare)) },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commitScale(); // commits now (flag still false)…
      suppressBlurRef.current = true; // …so the blur below doesn't re-commit.
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setDraft(formatScale(realSizePerGridSquare));
      suppressBlurRef.current = true; // revert only — blur must not commit.
      event.currentTarget.blur();
    }
  };

  const handleUnitChange = (nextUnit: Unit) => {
    if (nextUnit === unit) return;
    update.mutate({ unit: nextUnit });
  };

  // Optimistically reflect an in-flight unit change. The PATCH isn't
  // optimistic, so without this the controlled <select> would snap back to
  // the persisted unit for the whole round-trip (and revert on failure) —
  // the same submitted-value-while-pending trick FloorPlanNameEditor uses for
  // the name. A scale-only patch carries no `unit`, so it falls through to
  // the persisted value; on error `isPending` clears and it reverts too.
  const displayUnit: Unit =
    update.isPending && update.variables?.unit ? update.variables.unit : unit;

  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">1 sq =</span>
        <input
          type="number"
          inputMode="decimal"
          min={MIN_REAL_SIZE_PER_GRID_SQUARE}
          step="any"
          aria-label="Meters per grid square"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commitScale();
          }}
          className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-muted-foreground">m</span>
      </label>

      <select
        aria-label="Measurement unit"
        value={displayUnit}
        onChange={(event) => handleUnitChange(event.target.value as Unit)}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {UNITS.map((value) => (
          <option key={value} value={value}>
            {UNIT_LABELS[value]}
          </option>
        ))}
      </select>

      {displayUnit === "feet_inches" && (
        // Canonical-meters → display-unit hint, so a feet-and-inches user
        // sees what the metric scalar they're editing means (AE2 conversion).
        <span className="text-xs text-muted-foreground tabular-nums">
          = {formatMeasurement(realSizePerGridSquare, displayUnit)}
        </span>
      )}

      {update.isPending && (
        <span role="status" className="text-xs text-muted-foreground">
          Saving…
        </span>
      )}
    </div>
  );
}
