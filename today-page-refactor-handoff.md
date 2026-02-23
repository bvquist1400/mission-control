# Today Page Refactor — Codex Handoff

## Repo
`https://github.com/bvquist1400/mission-control`

## Context
The Mission Control app is a personal task/calendar/stakeholder management system. The owner now gets daily briefings and planning through an external MCP integration (Claude via Cooper Agent), which makes the in-app Daily Briefing subsystem and the Planner redundant. The Today page needs to become a fast, lightweight quick-view dashboard — not a command center.

## Reference Document
See `today-page-full-summary.md` (attached to repo or provided alongside this doc) for the full current architecture, file paths, and line references.

---

## Goal
Strip the Today page (`src/app/page.tsx`) down to 6 fast, targeted reads and a clean card layout. Remove all heavy client-side computation, full task pagination, and redundant subsystems.

---

## Current Problems

1. **Full task pagination on load** — Browser pages through `/api/tasks` in 200-record chunks until exhausted, then derives Top 3, Due Soon, Blocked, and Needs Review client-side. This is the biggest perf hit.
2. **Full calendar ingest on every load** — `/api/calendar` runs ICS ingest, upsert, stale deletion, snapshot deltas, busy block merging every time the page opens. Today only needs today's events + busy minutes.
3. **Daily Briefing subsystem** — Fires 3 additional API calls (`/api/briefing`, `/api/llm/models`, `/api/briefing/narrative`) including an LLM generation call. This is fully replaced by the external MCP briefing workflow.
4. **Planner on Today** — `PlannerCard` handles plan fetch, plan generation (POST), auto-replan on focus changes with debounce/cooldown/session dedup. Complex orchestration that belongs elsewhere.
5. **Client-side derived datasets** — Top 3, Due Soon, Blocked/Waiting, Needs Review, and Capacity are all computed in the browser from the full task list. Should be server-side.

---

## Target Architecture

### What the Today page renders (in order)

1. `PageHeader` with date and capacity chip (keep)
2. `FocusStatusBar` (keep as-is — single lightweight `/api/focus` call)
3. **Today's Meetings card** (NEW — lightweight, read-only)
4. **Top 3 card** (refactored — server-filtered)
5. **Due Soon card** (refactored — server-filtered)
6. **Blocked/Waiting card** (refactored — server-filtered)

### What gets removed from Today

- `DailyBriefing` component and all its API calls
- `PlannerCard` component and all its orchestration
- `plannerReplanSignal` / `plannerAutoReplanKey` state management
- The full task pagination loop (`fetchTodayData` paging logic)
- Client-side dataset derivation (Top 3 sort, Due Soon filter, etc.)

### What moves (not deleted, relocated)

- `PlannerCard` → either its own `/planner` route or onto `/backlog`
- `DailyBriefing` → disable via feature flag (already gated by `NEXT_PUBLIC_ENABLE_DAILY_BRIEFING`), or remove entirely. The MCP integration replaces it.

---

## Implementation Plan

### Phase 1: New server-side task endpoints

Create purpose-built API endpoints (or extend `/api/tasks` with new query modes) that return exactly what each Today card needs. No client-side filtering.

#### 1a. Top 3 endpoint
- **Route**: `GET /api/tasks?view=top3` (or dedicated `/api/tasks/top3`)
- **Logic**: Filter to `status IN ('Planned', 'In Progress')`, sort by `priority_score DESC`, `LIMIT 3`
- **Returns**: Array of 3 tasks with implementation join

#### 1b. Due Soon endpoint
- **Route**: `GET /api/tasks?view=due_soon` (or use existing `due_soon=true` param)
- **Logic**: Exclude `status = 'Done'`, require `due_at <= NOW() + INTERVAL '48 hours'` and `due_at IS NOT NULL`, sort overdue first then by `due_at ASC`, `LIMIT 6`
- **Note**: Exclude Top 3 task IDs. Either accept them as a param or run both queries server-side and deduplicate.
- **Returns**: Array of up to 6 tasks

#### 1c. Blocked/Waiting endpoint
- **Route**: `GET /api/tasks?status=Blocked/Waiting` (already exists)
- **Returns**: Array of blocked tasks — no change needed, just stop fetching the full list

#### 1d. Needs Review count
- **Route**: `GET /api/tasks?view=needs_review_count` (or embed in a summary endpoint)
- **Logic**: `SELECT COUNT(*) FROM tasks WHERE needs_review = true AND status != 'Done'`
- **Returns**: `{ count: number }`

### Phase 2: Lightweight calendar endpoint

#### 2a. Create `/api/calendar/today` (or `/api/calendar?mode=summary`)
- **Does**: Queries already-ingested events for today's date range. Computes `busyMinutes` from stored events.
- **Does NOT**: Run ICS ingest, upsert, stale deletion, or snapshot delta calculation.
- **Returns**:
```json
{
  "events": [
    {
      "title": "string",
      "start": "ISO datetime",
      "end": "ISO datetime",
      "location": "string | null"
    }
  ],
  "busyMinutes": 120
}
```

#### 2b. Move heavy ingest to a separate trigger
- Option A: Cron job (e.g., every 15 min)
- Option B: Dedicated `POST /api/calendar/sync` endpoint, callable from a refresh button or on the Calendar page
- Option C: Run ingest only on the full Calendar page (`/calendar` route), not on Today

### Phase 3: Capacity from lightweight inputs

#### 3a. Refactor `calculateCapacity` inputs
- Currently requires the full task list and meeting minutes
- After refactor, it needs: `busyMinutes` (from Phase 2), estimated minutes for Top 3 tasks + tasks due today (from Phase 1 endpoints)
- Either compute server-side in a `/api/capacity` endpoint, or compute client-side from the small payloads already fetched (preferred — it's just arithmetic on <10 tasks)

### Phase 4: Simplify `page.tsx`

#### 4a. Remove imports and state
- Remove `DailyBriefing` import and render
- Remove `PlannerCard` import and render
- Remove `plannerReplanSignal`, `plannerAutoReplanKey`, and related `useCallback` / state
- Remove `fetchTodayData()` function entirely

#### 4b. Replace with parallel fetches
```typescript
// Pseudocode for new loadData
const [top3, dueSoon, blocked, reviewCount, calendar, focus] = await Promise.all([
  fetch('/api/tasks?view=top3'),
  fetch('/api/tasks?view=due_soon'),
  fetch('/api/tasks?status=Blocked/Waiting'),
  fetch('/api/tasks?view=needs_review_count'),
  fetch('/api/calendar/today'),
  fetch('/api/focus'),
]);
```

All 6 calls fire in parallel. Each returns a small, targeted payload. No pagination loops.

#### 4c. New "Today's Meetings" card
- Simple read-only list from `calendar.events`
- Shows: time, title, location (if present)
- No stakeholder commitment linking (handled externally via MCP briefs)
- Sorted chronologically
- Style: match existing card components

### Phase 5: Relocate Planner

- Move `PlannerCard` to `/backlog` page or create a new `/planner` route
- Remove all focus-change auto-replan wiring from Today — that orchestration lives wherever the Planner goes
- The Planner still works the same way, it just doesn't load on the Today page anymore

---

## Files Likely Touched

| File | Action |
|------|--------|
| `src/app/page.tsx` | Major refactor — gut and simplify |
| `src/app/api/tasks/route.ts` | Add `view` query param handling for top3, due_soon, needs_review_count |
| `src/app/api/calendar/route.ts` | Add lightweight mode OR create new `today` route |
| `src/components/today/PlannerCard.tsx` | Move to new location (backlog or own route) |
| `src/components/today/briefing/DailyBriefing.tsx` | Remove from Today imports (keep file if feature-flagged) |
| `src/components/today/FocusStatusBar.tsx` | No changes |
| `src/components/today/CapacityMeter.tsx` | Minor — adapt to accept pre-computed inputs instead of full task list |
| `src/lib/capacity.ts` | Minor — may need to accept smaller input shape |

---

## What NOT to change

- `/api/tasks/[id]/route.ts` (PATCH behavior) — unchanged
- `/api/focus` — unchanged
- `/api/planner/plan` — unchanged (just not called from Today anymore)
- Backlog page — unchanged (still links from Today cards via `?expand=<taskId>`)
- Auth behavior — unchanged
- Task data types / contracts — unchanged

---

## Success Criteria

1. Today page fires ≤6 API calls on load, all in parallel
2. No full task list pagination from the browser
3. No ICS ingest triggered by opening Today
4. No LLM calls triggered by opening Today
5. Page renders meetings, Top 3, Due Soon, Blocked, and capacity chip
6. Planner is accessible from another route but not on Today
7. All existing task card interactions (✓ Done, link to backlog) still work
