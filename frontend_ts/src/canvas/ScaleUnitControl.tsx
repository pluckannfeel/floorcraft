import { useRef, useState, type KeyboardEvent } from "react";
import { useUpdateFloorPlanSettings } from "../hooks/useFloorPlans";
import { UNITS, formatMeasurement, type Unit } from "./rulers";

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

  // Re-sync the draft when the persisted scale changes from elsewhere (a
  // successful PATCH merges the cache → new prop). React's "adjust state
  // during render" pattern rather than an effect (avoids a cascading
  // re-render): track the last-seen persisted value and reset the draft
  // when it moves. Not optimistic, so the prop never changes mid-edit to
  // clobber typing — it only moves after a commit.
  const [lastPersisted, setLastPersisted] = useState(realSizePerGridSquare);
  if (lastPersisted !== realSizePerGridSquare) {
    setLastPersisted(realSizePerGridSquare);
    setDraft(formatScale(realSizePerGridSquare));
  }

  const commitScale = () => {
    // Skip the blur that Enter/Escape triggers themselves (see the ref).
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    const parsed = Number(draft);
    // Reject empty / non-finite / non-positive (backend enforces > 0 too);
    // revert to the persisted value rather than PATCHing garbage.
    if (draft.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
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

  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="flex items-center gap-1">
        <span className="text-muted-foreground">1 sq =</span>
        <input
          type="number"
          inputMode="decimal"
          min={0.0001}
          step="any"
          aria-label="Meters per grid square"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitScale}
          className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-muted-foreground">m</span>
      </label>

      <select
        aria-label="Measurement unit"
        value={unit}
        onChange={(event) => handleUnitChange(event.target.value as Unit)}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {UNITS.map((value) => (
          <option key={value} value={value}>
            {UNIT_LABELS[value]}
          </option>
        ))}
      </select>

      {unit === "feet_inches" && (
        // Canonical-meters → display-unit hint, so a feet-and-inches user
        // sees what the metric scalar they're editing means (AE2 conversion).
        <span className="text-xs text-muted-foreground tabular-nums">
          = {formatMeasurement(realSizePerGridSquare, unit)}
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
