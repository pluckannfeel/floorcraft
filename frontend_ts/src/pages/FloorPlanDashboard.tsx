import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { UserMenu } from '@/components/UserMenu'
import { useAuth } from '../auth/AuthContext'
import type { FloorPlan } from '../canvas/types'
import { useCreateFloorPlan, useFloorPlans } from '../hooks/useFloorPlans'

/**
 * U4: post-login dashboard (R4) — lists the user's floor plans as a grid of
 * Tailwind-styled cards (R6/R10), each linking to its editor route (R7),
 * with a "Create new" action that creates an untitled plan and navigates
 * straight into it (R5/R13). Deliberately no rename/delete/duplicate
 * actions here (R8).
 *
 * Required interaction states (design review):
 * 1. "Create new" is disabled/pending while the mutation is in flight, so a
 *    double-click can't fire two POSTs.
 * 2. A failed LIST query renders a distinct error state (message + retry) —
 *    NOT the zero-plans empty state, which would misrepresent an error as
 *    "you have no floor plans."
 * 3. Zero plans renders a friendly empty state that still surfaces Create.
 * 4. A failed CREATE stays on the dashboard with an error toast (handled in
 *    useCreateFloorPlan) and never navigates — navigation only happens in
 *    the mutation's onSuccess.
 */

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function FloorPlanCard({ plan }: { plan: FloorPlan }) {
  const created = formatDate(plan.created_at)
  const updated = formatDate(plan.updated_at)

  return (
    <li>
      <Link
        to={`/floor-plans/${plan.id}`}
        className="block rounded-lg border border-border bg-background p-4 transition-colors hover:border-ring hover:bg-muted"
      >
        <span className="block truncate font-medium">{plan.name || 'Untitled'}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {created && <>Created {created}</>}
          {created && updated && ' · '}
          {updated && <>Updated {updated}</>}
        </span>
      </Link>
    </li>
  )
}

export function FloorPlanDashboard() {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const floorPlansQuery = useFloorPlans()
  const createFloorPlan = useCreateFloorPlan()

  const handleCreate = () => {
    // Belt-and-braces alongside the `disabled` attribute below: even if a
    // second click lands before React re-renders the disabled state, the
    // in-flight mutation makes this a no-op (required state #1).
    if (createFloorPlan.isPending) return
    createFloorPlan.mutate(undefined, {
      // Navigation ONLY on success (required state #4) — onError is handled
      // inside useCreateFloorPlan (toast), and the user stays here.
      onSuccess: (created) => navigate(`/floor-plans/${created.id}`),
    })
  }

  const createButton = (
    <Button onClick={handleCreate} disabled={createFloorPlan.isPending}>
      {createFloorPlan.isPending ? 'Creating…' : 'Create new'}
    </Button>
  )

  // When the empty state is showing it carries its own Create CTA — hiding
  // the header's copy avoids two identical "Create new" buttons on screen.
  const isEmpty =
    !floorPlansQuery.isPending &&
    !floorPlansQuery.isError &&
    floorPlansQuery.data.length === 0

  let content
  if (floorPlansQuery.isPending) {
    content = (
      <p role="status" className="py-12 text-center text-muted-foreground">
        Loading your floor plans…
      </p>
    )
  } else if (floorPlansQuery.isError) {
    // Required state #2: distinct from the empty state below.
    content = (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-10 text-center"
      >
        <p className="font-medium text-destructive">Couldn't load your floor plans.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Something went wrong while fetching them — your plans are safe.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => floorPlansQuery.refetch()}
        >
          Retry
        </Button>
      </div>
    )
  } else if (floorPlansQuery.data.length === 0) {
    // Required state #3: friendly empty state, Create still surfaced.
    content = (
      <div className="rounded-lg border border-dashed border-border p-12 text-center">
        <p className="text-lg font-medium">No floor plans yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create your first floor plan to start designing.
        </p>
        <div className="mt-5 flex justify-center">{createButton}</div>
      </div>
    )
  } else {
    content = (
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {floorPlansQuery.data.map((plan) => (
          <FloorPlanCard key={plan.id} plan={plan} />
        ))}
      </ul>
    )
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Your floor plans</h1>
        <div className="flex items-center gap-2">
          {!isEmpty && createButton}
          {/* Log out lives in the hamburger account menu (final-polish
              round) — the same `UserMenu` the editor header uses. */}
          <UserMenu onLogout={() => logout()} />
        </div>
      </header>
      {content}
    </main>
  )
}
