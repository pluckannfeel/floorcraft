import { useRef, useState, type KeyboardEvent } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_FLOOR_PLAN_NAME, useRenameFloorPlan } from "../hooks/useFloorPlans";

interface FloorPlanNameEditorProps {
  floorPlanId: number;
  /** The current persisted name, from the `['floorPlan', floorPlanId]`
   * query — a successful rename flows back here via `useRenameFloorPlan`'s
   * cache update, so this prop is always the settled source of truth. */
  name: string;
}

/**
 * U6/R13: the editor header's inline-editable floor-plan name. Two ways in
 * (the user explicitly asked for both): clicking the name itself, or the
 * pencil icon button. In edit mode, Enter or blur commits; Escape reverts
 * to the pre-edit name and exits WITHOUT a PATCH. Commits of an empty/
 * whitespace-only or unchanged name are client-side no-ops (no PATCH) that
 * just fall back to the previous name. While a rename PATCH is in flight,
 * the label optimistically shows the submitted name with a saving
 * indicator and edit mode can't be re-entered until it settles — on
 * failure the label reverts (the cache was never touched) and
 * `useRenameFloorPlan` raises the error toast.
 */
export function FloorPlanNameEditor({ floorPlanId, name }: FloorPlanNameEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Guards double-commit: Enter commits AND unmounts the input, and the
  // input's blur (also a commit path) can still fire around that unmount —
  // whichever path runs first wins, the other becomes a no-op.
  const finishedRef = useRef(false);
  const rename = useRenameFloorPlan(floorPlanId);

  const startEditing = () => {
    // Re-entering edit mode is blocked until an in-flight rename settles
    // (belt-and-braces alongside the `disabled` attributes below).
    if (rename.isPending) return;
    finishedRef.current = false;
    setDraft(name);
    setIsEditing(true);
  };

  const finishEditing = (commit: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setIsEditing(false);
    if (!commit) return; // Escape: revert, no PATCH.
    const trimmed = draft.trim();
    // Empty/whitespace-only falls back to the previous name (no PATCH, no
    // toast); an unchanged name is a no-op (no PATCH).
    if (trimmed === "" || trimmed === name) return;
    rename.mutate({ name: trimmed });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      finishEditing(true);
    } else if (event.key === "Escape") {
      finishEditing(false);
    }
  };

  if (isEditing) {
    return (
      <input
        autoFocus
        aria-label="Floor plan name"
        placeholder={DEFAULT_FLOOR_PLAN_NAME}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => finishEditing(true)}
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 w-64 rounded-md border border-input bg-background px-2 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    );
  }

  // While the PATCH is in flight, show the submitted name (the mutation's
  // `variables`); once it settles this falls back to `name` — which the
  // cache update made the NEW name on success, and left as the previous
  // name on failure (the revert).
  const displayName =
    rename.isPending && rename.variables ? rename.variables.name : name || "Floor plan";

  return (
    <div className="flex items-center gap-1">
      <h1 className="m-0 text-base font-semibold">
        <button
          type="button"
          onClick={startEditing}
          disabled={rename.isPending}
          className="rounded-md px-1 text-left hover:bg-muted disabled:opacity-70"
        >
          {displayName}
        </button>
      </h1>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rename floor plan"
        onClick={startEditing}
        disabled={rename.isPending}
      >
        <Pencil />
      </Button>
      {rename.isPending && (
        <span role="status" className="text-xs text-muted-foreground">
          Saving…
        </span>
      )}
    </div>
  );
}
