# Today Page: Full Functional and Technical Summary

## Overview
The Today tab is the app’s root route (`/`) and is rendered inside the shared layout/sidebar shell.  
It combines 3 major systems in one screen:
1. A core task snapshot (`Top 3`, `Due Soon`, `Blocked/Waiting`, `Needs Review`)
2. Focus + Planner controls
3. An optional Daily Briefing subsystem

Primary references:
- `mission-control/src/app/layout.tsx:18`
- `mission-control/src/components/layout/Sidebar.tsx:8`
- `mission-control/src/app/page.tsx:236`

## 1) What the Today page renders
The page renders these sections in order:
1. `PageHeader` with title, description, current formatted date, and capacity chip when data is loaded.
2. `FocusStatusBar` (active directive).
3. Optional `DailyBriefing` (guarded by `NEXT_PUBLIC_ENABLE_DAILY_BRIEFING`).
4. `PlannerCard` (plan read/replan UI).
5. Main Today snapshot sections:
   - Top 3 Today
   - Due Soon (48h)
   - Blocked / Waiting
   - Needs Review

References:
- `mission-control/src/app/page.tsx:323`
- `mission-control/src/app/page.tsx:340`
- `mission-control/src/app/page.tsx:342`
- `mission-control/src/app/page.tsx:344`
- `mission-control/src/app/page.tsx:350`
- `mission-control/src/components/layout/PageHeader.tsx:9`

## 2) Core Today data pipeline (main snapshot data)
### 2.1 Initial load
On mount, `useEffect` runs `loadData()`, which calls `fetchTodayData()`.

References:
- `mission-control/src/app/page.tsx:266`
- `mission-control/src/app/page.tsx:269`
- `mission-control/src/app/page.tsx:274`

### 2.2 fetchTodayData() inputs
`fetchTodayData()` does two operations in parallel:
1. Fetch all tasks by paging `/api/tasks` in chunks of 200 (`offset` loop until page < 200)
2. Fetch today’s meeting minutes from `/api/calendar?rangeStart=...&rangeEnd=...`

References:
- `mission-control/src/app/page.tsx:67`
- `mission-control/src/app/page.tsx:71`
- `mission-control/src/app/page.tsx:131`
- `mission-control/src/app/page.tsx:132`
- `mission-control/src/app/page.tsx:90`

### 2.3 Derived datasets in the client
From full task list, Today computes:
1. **Top 3**
   - filter statuses `Planned` or `In Progress`
   - sort by `priority_score DESC`
   - take first 3
2. **Due Soon (48h)**
   - exclude done + exclude Top 3 IDs
   - require non-null due date and `due_at <= now + 48h`
   - sort overdue first, then earliest due date first
   - take first 6
3. **Blocked/Waiting**
   - status equals `Blocked/Waiting`
   - fallback waiting text to `"Unknown"`
4. **Needs Review count**
   - count tasks where `needs_review === true`
5. **Capacity**
   - call `calculateCapacity(allTasks, top3Ids, meetingMinutes)`

References:
- `mission-control/src/app/page.tsx:137`
- `mission-control/src/app/page.tsx:145`
- `mission-control/src/app/page.tsx:171`
- `mission-control/src/app/page.tsx:192`
- `mission-control/src/app/page.tsx:186`

## 3) Capacity calculation model
Capacity is computed from static workday assumptions plus task load:
1. Work minutes = 510 (8:00–4:30), lunch = 30, overhead = 90
2. Buffer minutes = `10 * (focusTaskCount - 1)` capped at 60
3. Available = work - lunch - overhead - buffer - meetings
4. Required = estimated minutes for:
   - tasks due today, and
   - Top 3 tasks (even if not due today), excluding done
5. RAG:
   - Green: required <= available
   - Yellow: 1–60 min over
   - Red: >60 min over

Display:
1. Compact chip with fill bar + `required/available` text
2. Expandable breakdown tooltip

References:
- `mission-control/src/lib/capacity.ts:7`
- `mission-control/src/lib/capacity.ts:33`
- `mission-control/src/lib/capacity.ts:55`
- `mission-control/src/lib/capacity.ts:106`
- `mission-control/src/components/today/CapacityMeter.tsx:32`

## 4) Main user interactions on Today
### 4.1 Quick complete
Clicking `✓ Done`:
1. Calls `PATCH /api/tasks/:id` with `{ status: "Done" }`
2. On success, reloads full Today data again via `fetchTodayData()`

References:
- `mission-control/src/app/page.tsx:224`
- `mission-control/src/app/page.tsx:305`
- `mission-control/src/app/page.tsx:307`

### 4.2 Task PATCH behavior
Task PATCH endpoint:
1. Validates allowed fields
2. Recalculates `priority_score` when `status` or `due_at` changes
3. Returns task with implementation join

References:
- `mission-control/src/app/api/tasks/[id]/route.ts:76`
- `mission-control/src/app/api/tasks/[id]/route.ts:158`
- `mission-control/src/app/api/tasks/[id]/route.ts:176`

### 4.3 Navigation into Backlog task details
Top cards link to `/backlog?expand=<taskId>`.  
Backlog reads this query param and auto-expands matching row.

References:
- `mission-control/src/app/page.tsx:358`
- `mission-control/src/components/backlog/BacklogList.tsx:411`
- `mission-control/src/components/backlog/BacklogList.tsx:427`

## 5) FocusStatusBar and planner coupling
### 5.1 FocusStatusBar behavior
On mount it fetches `/api/focus`, displays active directive, and notifies parent when directive ID changes.

References:
- `mission-control/src/components/today/FocusStatusBar.tsx:25`
- `mission-control/src/components/today/FocusStatusBar.tsx:28`
- `mission-control/src/components/today/FocusStatusBar.tsx:33`

### 5.2 Parent orchestration in Today page
Today page stores focus directive ID and sends planner signals:
1. `plannerReplanSignal` (for DailyBriefing refresh trigger)
2. `plannerAutoReplanKey` (for PlannerCard auto-replan flow)

References:
- `mission-control/src/app/page.tsx:241`
- `mission-control/src/app/page.tsx:245`
- `mission-control/src/app/page.tsx:252`

## 6) PlannerCard architecture
PlannerCard responsibilities:
1. Read latest plan for a selected date via `GET /api/planner/plan?date=...`
2. Trigger new plan generation via `POST /api/planner/plan`
3. Render plan sections: Now Next, Next 3, Queue, Exceptions, Windows
4. Support auto-replan on focus changes with debounce/cooldown/session dedupe

References:
- `mission-control/src/components/today/PlannerCard.tsx:385`
- `mission-control/src/components/today/PlannerCard.tsx:403`
- `mission-control/src/components/today/PlannerCard.tsx:516`
- `mission-control/src/components/today/PlannerCard.tsx:530`
- `mission-control/src/components/today/PlannerCard.tsx:692`

### 6.1 Planner scoring inputs
Planner API ranks tasks using:
1. Priority blend
2. Urgency boost
3. Stakeholder boost
4. Staleness boost
5. Status adjustments (blocked/waiting/follow-up due)
6. Implementation multipliers
7. Focus directive match multipliers
8. Meeting-context match boosts
9. Dependency blocked state

References:
- `mission-control/src/app/api/planner/plan/route.ts:444`
- `mission-control/src/app/api/planner/plan/route.ts:486`
- `mission-control/src/app/api/planner/plan/route.ts:565`
- `mission-control/src/app/api/planner/plan/route.ts:610`
- `mission-control/src/app/api/planner/plan/route.ts:638`
- `mission-control/src/lib/planner/scoring.ts:240`

### 6.2 Planner outputs
Planner output payload includes:
1. `nowNext`
2. `next3`
3. `queue` (top ranked)
4. `exceptions` (out-of-focus but urgent/critical)
5. `reasons_json` with score breakdown and “why” lines
6. Optional persistence into `plans` table

References:
- `mission-control/src/app/api/planner/plan/route.ts:963`
- `mission-control/src/app/api/planner/plan/route.ts:929`
- `mission-control/src/app/api/planner/plan/route.ts:1002`

## 7) Optional Daily Briefing subsystem
### 7.1 High-level behavior
When enabled, `DailyBriefing`:
1. Fetches deterministic briefing data from `/api/briefing?mode=...`
2. Fetches LLM model catalog from `/api/llm/models`
3. Optionally generates narrative text via `/api/briefing/narrative`
4. Refreshes briefing every 5 minutes
5. Supports mode override: auto/morning/midday/eod

References:
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:240`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:135`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:159`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:300`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:308`

### 7.2 Mode detection
Auto mode uses ET hour:
1. Morning: `<12`
2. Midday: `12–14`
3. EOD: `>=15`

Reference:
- `mission-control/src/lib/briefing/time-detection.ts:30`

### 7.3 Briefing API payload composition
`GET /api/briefing` builds:
1. Today calendar events + busy blocks/stats + focus blocks
2. Today task slices (completed/remaining/planned)
3. Capacity + progress summary
4. If EOD mode, tomorrow calendar + prep tasks + rollover tasks + estimated tomorrow capacity

References:
- `mission-control/src/app/api/briefing/route.ts:169`
- `mission-control/src/app/api/briefing/route.ts:188`
- `mission-control/src/app/api/briefing/route.ts:197`
- `mission-control/src/app/api/briefing/route.ts:238`
- `mission-control/src/app/api/briefing/route.ts:270`

### 7.4 Narrative generation details
`POST /api/briefing/narrative`:
1. Builds mode-specific deterministic context JSON
2. Hashes context + model scope for cache key
3. Uses short in-memory cache TTL (30 min)
4. Calls LLM with strict prompt (2-3 sentences, no bullets, no motivational language)
5. Normalizes/validates output before returning

References:
- `mission-control/src/app/api/briefing/narrative/route.ts:29`
- `mission-control/src/app/api/briefing/narrative/route.ts:286`
- `mission-control/src/app/api/briefing/narrative/route.ts:291`
- `mission-control/src/app/api/briefing/narrative/route.ts:338`
- `mission-control/src/app/api/briefing/narrative/route.ts:359`

## 8) Calendar path used by Today
Today core summary only needs `busyMinutes`, but currently calls full `/api/calendar` route.

`GET /api/calendar` currently performs:
1. Range validation + auth
2. Retention enforcement
3. ICS ingest/upsert/delete stale
4. Query events + context
5. Merge busy blocks + compute stats
6. Snapshot delta calculation + snapshot insert
7. Return full payload (`events`, `busyBlocks`, `stats`, `changesSince`, ingest metadata)

References:
- `mission-control/src/app/page.tsx:92`
- `mission-control/src/app/api/calendar/route.ts:70`
- `mission-control/src/app/api/calendar/route.ts:81`
- `mission-control/src/app/api/calendar/route.ts:82`
- `mission-control/src/app/api/calendar/route.ts:137`
- `mission-control/src/app/api/calendar/route.ts:165`
- `mission-control/src/lib/calendar.ts:1729`

### Calendar utilities used
1. Day-window builder (`buildDayWindows`)
2. Busy block merging (`mergeBusyBlocks`)
3. Busy statistics (`calculateBusyStats`)

References:
- `mission-control/src/lib/calendar.ts:1335`
- `mission-control/src/lib/calendar.ts:1457`
- `mission-control/src/lib/calendar.ts:1476`

## 9) Task list API behavior as used by Today
`GET /api/tasks`:
1. Authenticates user
2. Reads query filters (`status`, `due_soon`, `needs_review`, pagination, etc.)
3. Fetches tasks + implementation join
4. Enriches every returned task with dependency summaries

References:
- `mission-control/src/app/api/tasks/route.ts:44`
- `mission-control/src/app/api/tasks/route.ts:63`
- `mission-control/src/app/api/tasks/route.ts:96`
- `mission-control/src/app/api/tasks/route.ts:102`

Dependency enrichment uses:
- `fetchTaskDependencySummaries` in `lib/task-dependencies`

Reference:
- `mission-control/src/lib/task-dependencies.ts:48`

## 10) Data contracts used by Today
Primary task/capacity types:
1. `Task`, `TaskWithImplementation`
2. `CapacityResult`, `RagStatus`
3. `TaskStatus`, `TaskType`

References:
- `mission-control/src/types/database.ts:22`
- `mission-control/src/types/database.ts:132`
- `mission-control/src/types/database.ts:205`
- `mission-control/src/types/database.ts:1`

Briefing contracts:
1. `BriefingResponse`
2. `TodayBriefingData`
3. `TomorrowBriefingData`
4. `BriefingNarrativeResponse`

Reference:
- `mission-control/src/lib/briefing/contracts.ts:29`

## 11) Auth and freshness behavior
1. Routes use `requireAuthenticatedRoute` (API key, Bearer token, or Supabase cookie).
2. Most Today-related client fetches use `cache: "no-store"` for fresh reads.

References:
- `mission-control/src/lib/supabase/route-auth.ts:17`
- `mission-control/src/app/page.tsx:54`
- `mission-control/src/components/today/FocusStatusBar.tsx:28`
- `mission-control/src/components/today/PlannerCard.tsx:388`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:249`

## 12) Timezone behavior
Today page combines local and ET conventions:
1. `localDateString()` for calendar call date string in Today main page
2. ET-based mode detection and formatting in Briefing/Planner logic
3. Workday focus windows default to ET

References:
- `mission-control/src/components/utils/dates.ts:1`
- `mission-control/src/lib/briefing/time-detection.ts:7`
- `mission-control/src/lib/workday.ts:8`

## 13) Practical load implications of current design
Current load on first Today visit can include:
1. Full task pagination loop from browser (`/api/tasks` multiple pages if large dataset)
2. Full calendar ingest/stats/snapshot path (`/api/calendar`)
3. Focus fetch (`/api/focus`)
4. Planner plan fetch (`/api/planner/plan`)
5. Optional briefing fetch (`/api/briefing`), model catalog fetch (`/api/llm/models`), and optional narrative generation (`/api/briefing/narrative`)

References:
- `mission-control/src/app/page.tsx:67`
- `mission-control/src/app/page.tsx:92`
- `mission-control/src/components/today/FocusStatusBar.tsx:28`
- `mission-control/src/components/today/PlannerCard.tsx:387`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:248`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:140`
- `mission-control/src/components/today/briefing/DailyBriefing.tsx:166`
