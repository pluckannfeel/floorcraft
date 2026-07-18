import { useEffect, useRef, useState } from "react";
import { LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Header account menu: a three-line (hamburger) icon button opening a small
 * dropdown that holds the account actions — currently just Log out, moved
 * here from a standalone header button so the header's right edge stays a
 * compact Save + menu pair. Shared by the canvas editor header and the
 * dashboard header so both screens present the same affordance.
 *
 * Hand-rolled like `ContextMenu.tsx` (this codebase's existing menu
 * convention): open state + capture-phase outside-pointerdown to close, an
 * Escape handler on the wrapper (with `stopPropagation`, so dismissing the
 * menu never doubles as the canvas's window-level Escape → exit-tool), and
 * `menu`/`menuitem` roles with `aria-haspopup`/`aria-expanded` on the
 * trigger.
 */
export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleDocumentPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target))
        return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
        true,
      );
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Menu aria-hidden="true" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute top-full right-0 z-50 mt-1 min-w-36 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogOut className="size-4" aria-hidden="true" /> Log out
          </button>
        </div>
      )}
    </div>
  );
}
