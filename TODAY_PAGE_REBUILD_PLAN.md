# Today Page Rebuild — Design & Migration Plan (LW-5)

Design decisions locked with the owner on 2026-07-09. This plan is the source of
truth for the executing session. Read CLAUDE.md first; its conventions apply.

## Goals

1. **"Now" panel hero** — the first thing the eye lands on: next meeting + the
   top 2–3 actionable tasks. Triage-first.
2. **Server-rendered shell with per-section streaming** — no more all-or-nothing
   client skeleton; each section renders as its data arrives, and one slow
   section can't blank the page.
3. **Decompose the 1,900-line client monolith** (`src/app/page.tsx`) into
   server sections + small client islands.
4. **Demotions**: sprint progress shrinks to a header chip (full detail stays on
   /sprints); capacity meter is removed from the page entirely.

## Explicit non-goals (do not do these)

- **No mobile/responsive work.** Desktop only. Don't add breakpoint styling.
- No changes to any `/api/*` route's external behavior, the MCP surface, the
  brief/digest pipeline, or planner scoring.
- No visual-language changes: keep the existing theme tokens and card idiom
  (`rounded-card border border-stroke bg-panel p-5 shadow-sm`).
- Don't rebuild TaskDetailModal, FocusStatusBar, or the sidebar.

## Target layout (desktop, top to bottom)

```
PageHeader   title/date · Artifact Inbox chip · NEW sprint chip ("Sprint 12 · 7/12 · on track")
             (capacity meter REMOVED; needs-review count stays as a chip if currently present)
FocusStatusBar                                   (unchanged, client)
┌─────────────────────────────────────────────┬──────────────────────────┐
│ NOW PANEL (hero — visually dominant:        │ TODAY'S MEETINGS         │
│ larger type, accent border, ~2/3 width)     │ (existing list, with     │
│ · Next meeting: title + "in 42 min" + time  │  temporal badges —       │
│ · Top 3 actionable tasks (view=top3),       │  moves to sidebar column)│
│   each: title, due state, state badge,      │                          │
│   ✓ Done button, click → TaskDetailModal    │                          │
│ · One-line sync recency note                │                          │
└─────────────────────────────────────────────┴──────────────────────────┘
WEEK BOARD    (existing columns/drag/drop/overdue queue, moved down, unchanged behavior)
BLOCKED/WAITING STRIP  (compact single row of chips: task title + blocked_reason
              badge + follow-up date; data already fetched via view=waiting_summary)
TaskDetailModal (client, unchanged)
```

## Architecture

### Shared query layer first (Step 1, ships alone)

The current page fetches from `/api/tasks?view=...`, `/api/calendar/today`,
`/api/sprints`, etc. from the browser. The rebuilt page fetches server-side.
To avoid duplicating the view logic, extract it:

- New `src/lib/today/queries.ts` with functions taking `(supabase, userId, ...)`:
  - `queryTopThreeTasks` (from the `view=top3` block in `src/app/api/tasks/route.ts`)
  - `queryWeeklyBoardTasks` (from the `view=weekly_board` block)
  - `queryWaitingSummary` (from the `view=waiting_summary` block, incl. dependency enrichment)
  - `queryNeedsReviewCount` (from the `view=needs_review_count` block)
- Rewire `/api/tasks/route.ts` view branches to call these (behavior-identical —
  the MCP and other clients keep working; verify with test:mcp-contract + manual
  curl of each view).
- Calendar/sprint/sync/artifact fetchers: reuse whatever lib functions the API
  routes already delegate to; only extract where the logic lives inline in a route.

### Page shell (Step 2)

- `src/app/page.tsx` becomes a **server component**: resolves the Supabase
  server client + user once (redirect to /login when unauthenticated), renders
  `PageHeader`, `FocusStatusBar`, then the sections, each wrapped in
  `<Suspense fallback={<SectionSkeleton .../>}>`.
- Each section is an **async server component** in `src/components/today/sections/`
  that awaits its own query and renders either a server-only card (meetings,
  waiting strip) or a **client island** hydrated with the fetched data as props
  (now panel, week board).
- Timezone: the current page resolves the browser timezone client-side. Use ET
  (`DEFAULT_WORKDAY_CONFIG.timezone`) server-side — acceptable per owner (single
  user, ET). Remove the client timezone plumbing.
- Per-section error handling: each async section catches its own fetch error and
  renders the existing amber inline-warning pattern instead of throwing, so one
  failed feed never blanks the page (mirror today's `sectionErrors` behavior).

### Client islands (Step 3–4)

| Island | File | Interactivity to preserve |
|---|---|---|
| NowPanel | `src/components/today/sections/NowPanel.tsx` (client) | mark done (PATCH status), open TaskDetailModal, live "in N min" countdown (client interval) |
| WeekBoard | extract from current page.tsx ~lines 750–1850 | drag between day columns (PATCH due_at), ✓ Done, pin/unpin, overdue-queue toggle, weekend column, open modal |
| WaitingStrip | server component (no interactivity beyond link/modal-open) | click → TaskDetailModal (make it a small client wrapper if needed) |

A single client `TodayModalProvider` (context) owns the selected-task state so
any island can open TaskDetailModal; it also owns the `onTaskUpdated` refresh
(router.refresh() after mutations is acceptable — sections re-stream).

### Now panel content rules

- **Next meeting**: first event with `temporal_status != past` from today's
  calendar; show title, start–end, location, live countdown. If none: "No more
  meetings today."
- **Top tasks**: `queryTopThreeTasks` (Planned/In Progress by priority_score
  DESC — trustworthy post-migration-044). Render with the shared
  `getTaskVisualState` badges from `src/components/tasks/task-state.tsx`.
- **Sync note**: reuse `/api/planner/sync-today/latest` data — "Synced today at
  8:02 AM · 5 promoted" or "Not synced today."

### Blocked/Waiting strip

- Data: `queryWaitingSummary` (limit 8). Each chip: task title, `blocked_reason`
  badge (column added by migration ~049; render the enum value as a label,
  fall back to the "Waiting" badge when null), `follow_up_at` short date.
- If zero blocked tasks, render nothing (no empty section).

### Sprint header chip

- Replace the Sprint Progress card with a small header chip next to the date:
  `"{sprint.name} · {completed}/{total} · {health short-label}"`, linking to
  `/sprints/{id}`. Reuse `calculateSprintProgressMetrics` from
  `src/lib/today/sprint-progress.ts`. No sprint → no chip.
- Delete the CapacityMeter usage from this page (leave the component file; other
  surfaces may use it).

## Step plan (each independently shippable, in order)

1. **Extract shared queries** — `src/lib/today/queries.ts`; rewire /api/tasks
   views. No UI change. Gate: tsc, build, test:mcp-contract, curl each view
   locally and diff against pre-change responses.
2. **Server shell + meetings + sprint chip** — convert page.tsx to server
   component; meetings section + header chips server-rendered; the ENTIRE old
   client page moves temporarily into a `LegacyTodayBoard` client component
   rendered below (minus meetings/sprint/capacity, which are removed from it).
   Gate: visual parity check in the preview browser; every interaction still works.
3. **Now panel** — new hero island; remove any duplicated top-task rendering
   from the legacy component. Gate: done-button and modal work from the hero;
   skeleton renders while streaming.
4. **Week board island** — extract the board from LegacyTodayBoard into its own
   client component fed by server props; delete LegacyTodayBoard and all dead
   helpers (the old fetchTodayData client pipeline, timezone plumbing, etc.).
   Gate: drag-drop, pin, done, overdue queue all verified in preview; page.tsx
   should end well under 300 lines.
5. **Waiting strip + polish** — add the strip; final dead-code sweep; update
   CLAUDE.md/AGENTS.md key-files table if paths changed.

## Verification (every step)

- `npx tsc --noEmit`, `npm run build`, `npm run test:mcp-contract`,
  `npm run test:types-drift` (if any migration landed meanwhile, pull first).
- Drive the real page in the preview browser after each step: load, open a task
  modal, mark a task done, drag a task to another day, toggle the overdue queue.
- Commit per step with a descriptive message; push after each green step.
