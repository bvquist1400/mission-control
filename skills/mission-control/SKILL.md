---
name: mission-control
description: "Query and update Brent's Baseline app data — tasks, implementations, stakeholders, commitments, calendar, briefings, and focus directives — via live API calls."
---

# Baseline API Skill

You are connected to Brent's Baseline app — a personal operations dashboard built on Next.js + Supabase, deployed at Vercel.

## Auth

Every request must include this header:
```
X-Mission-Control-Key: <set from your local MISSION_CONTROL_API_KEY or MISSION_CONTROL_ACTIONS_API_KEY>
```

Never commit a live Mission Control key into this file.

**Base URL:** `https://mission-control-orpin-chi.vercel.app`

Always add `Content-Type: application/json` for POST/PATCH requests.

---

## How to Call the API

Use the WebFetch tool for GET requests. For POST/PATCH/DELETE, use the Bash tool with curl:

```bash
# GET example
curl -s -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  "https://mission-control-orpin-chi.vercel.app/api/tasks"

# POST example
curl -s -X POST \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Do the thing","status":"Backlog"}' \
  "https://mission-control-orpin-chi.vercel.app/api/tasks"

# PATCH example
curl -s -X PATCH \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"Done"}' \
  "https://mission-control-orpin-chi.vercel.app/api/tasks/TASK_ID_HERE"
```

---

## Data Model Reference

**Task statuses:** `Backlog` | `Planned` | `In Progress` | `Blocked/Waiting` | `Parked` | `Done`
**Task types:** `Task` | `Ticket` | `MeetingPrep` | `FollowUp` | `Admin` | `Build`
**RAG statuses:** `Green` | `Yellow` | `Red`
**Implementation phases:** `Intake` | `Discovery` | `Design` | `Build` | `Test` | `Training` | `GoLive` | `Hypercare` | `Steady State` | `Sundown`
**Project stages:** `Proposed` | `Planned` | `Ready` | `In Progress` | `Blocked` | `Review` | `Done` | `On Hold` | `Cancelled`
**Commitment statuses:** `Open` | `Done` | `Dropped`
**Commitment directions:** `ours` (we promised them) | `theirs` (they promised us)

Important task fields:
- `actual_minutes` — actual time spent (nullable)
- `project_id` — linked project UUID (nullable)
- `sprint_id` — linked sprint UUID (nullable)
- `recurrence` — recurring template config or generated-instance marker

Important stakeholder fields:
- `context` — structured JSON object with `last_contacted_at`, `preferred_contact`, `current_priorities`, `notes`

Important implementation fields:
- `health_snapshot` — latest computed health snapshot used for score trends

---

## API Endpoints

### TASKS

#### List tasks
```
GET /api/tasks
```
Query params (all optional):
- `status` — filter by status (e.g. `?status=Blocked%2FWaiting`)
- `needs_review=true` — only tasks flagged for review
- `implementation_id` — filter by application UUID
- `project_id` — filter by project UUID
- `due_soon=true` — due within 48 hours, excluding `Done` and `Parked`
- `include_done=true` — include completed tasks (default: excluded)
- `include_parked=true` — include parked tasks (default: excluded)
- `limit` — max results (default 100, max 500)
- `offset` — pagination offset

Returns: array of task objects, each including joined `implementation` and `project`.

**MCP tool:** `list_tasks`

#### Get single task
```
GET /api/tasks/:id
```
Returns: full task object with joined implementation and project.

#### Create task
```
POST /api/tasks
```
Body:
```json
{
  "title": "string (required)",
  "description": "string|null",
  "status": "Backlog",
  "task_type": "Task",
  "estimated_minutes": 30,
  "estimate_source": "default",
  "due_at": "2026-02-25T17:00:00Z",
  "priority_score": 50,
  "blocker": false,
  "needs_review": false,
  "waiting_on": "string|null",
  "implementation_id": "uuid|null",
  "project_id": "uuid|null",
  "stakeholder_mentions": ["name1"],
  "source_type": "Manual",
  "source_url": "string|null",
  "pinned_excerpt": "string|null",
  "initial_comment": "string (creates first comment)",
  "initial_checklist": ["step 1", "step 2"],
  "blocked_by_task_id": "uuid (creates dependency)"
}
```

#### Update task
```
PATCH /api/tasks/:id
```
Body: any subset of updatable fields:
`title`, `description`, `status`, `task_type`, `estimated_minutes`, `actual_minutes`, `estimate_source`, `due_at`, `needs_review`, `blocker`, `waiting_on`, `follow_up_at`, `implementation_id`, `project_id`, `sprint_id`, `pinned_excerpt`, `pinned`

Priority score is automatically recalculated when `status` or `due_at` changes.

#### List parked tasks
```
GET /api/tasks/parked
```
Query params:
- `implementation_id`
- `project_id`
- `limit`
- `offset`

Returns only `Parked` tasks, with the same joined implementation/project data and dependency info as `GET /api/tasks`.

**MCP tool:** `list_parked_tasks`

#### Park a task (convenience)
```
POST /api/tasks/park/:id
```
Sets `status = "Parked"` and returns the updated task.

**MCP tool:** `park_task`

#### Configure recurring task template
```
POST /api/tasks/:id/recur
```
Body:
```json
{
  "frequency": "daily",
  "next_due": "2026-03-04",
  "day_of_week": null,
  "day_of_month": null
}
```
Notes:
- accepts either `{ ...fields }` or `{ "recurrence": { ...fields } }`
- setting recurrence parks the template task and clears `sprint_id`
- `DELETE /api/tasks/:id/recur` removes recurrence from the task

**MCP tools:** `set_task_recurrence`, `clear_task_recurrence`

#### Generate recurring tasks
```
GET /api/tasks/generate-recurring
POST /api/tasks/generate-recurring
```
Intended for cron or manual trigger. Generates due recurring instances as new `Backlog` tasks, then advances each template’s `next_due`.

**MCP tool:** `generate_recurring_tasks`

#### Delete task
```
DELETE /api/tasks/:id
```
Returns: `{ success: true }`

---

### TASK COMMENTS

#### List comments
```
GET /api/tasks/:id/comments
```

#### Add comment
```
POST /api/tasks/:id/comments
```
Body: `{ "content": "string" }`

---

### TASK CHECKLIST

#### Get checklist
```
GET /api/tasks/:id/checklist
```

#### Update checklist items
```
PATCH /api/tasks/:id/checklist
```
Body: `{ "items": [{ "id": "uuid", "is_done": true }] }`

---

### TASK DEPENDENCIES

#### List dependencies
```
GET /api/tasks/:id/dependencies
```
Returns: `{ blocking: [...], blocked_by: [...] }` — tasks that block this one and tasks it blocks.

#### Add dependency
```
POST /api/tasks/:id/dependencies
```
Body: `{ "blocker_task_id": "uuid" }` — marks another task as blocking this one.

---

### SPRINTS

Week-level planning groups for tasks.

#### List sprints
```
GET /api/sprints
```
Returns sprints ordered by `start_date` descending, each with optional `focus_implementation`.

**MCP tool:** `list_sprints`

#### Create sprint
```
POST /api/sprints
```
Body:
```json
{
  "name": "Week of Mar 3",
  "start_date": "2026-03-03",
  "end_date": "2026-03-07",
  "theme": "Stabilize REDCap",
  "focus_implementation_id": "uuid|null"
}
```

**MCP tool:** `create_sprint`

#### Get sprint detail
```
GET /api/sprints/:id
```
Returns sprint metadata plus:
- `total_tasks`
- `completed_tasks`
- `completion_pct`
- `tasks_by_status`

**MCP tool:** `get_sprint`

#### Update sprint
```
PATCH /api/sprints/:id
```
Body: any subset of `name`, `start_date`, `end_date`, `theme`, `focus_implementation_id`

**MCP tool:** `update_sprint`

#### Delete sprint
```
DELETE /api/sprints/:id
```

**MCP tool:** `delete_sprint`

---

### PROJECTS

Projects sit between Applications and Tasks. Each project has name, stage, RAG, target date, ServiceNow SPM ID, status summary, description, and links to one Application.

#### List projects
```
GET /api/projects
```
Query params:
- `implementation_id` — filter by application UUID
- `with_stats=true` — enriches with `open_task_count` and `implementation` object

Returns project objects using `stage` (not legacy `phase`).

#### Get project detail
```
GET /api/projects/:id
```
Returns: full project + `blockers_count`, `open_tasks[]`, `implementation`

#### Create project
```
POST /api/projects
```
Body:
```json
{
  "name": "string (required)",
  "description": "string|null",
  "implementation_id": "uuid|null",
  "stage": "Planned",
  "rag": "Green",
  "target_date": "2026-06-01",
  "servicenow_spm_id": "string|null",
  "status_summary": "string",
  "portfolio_rank": 1
}
```

#### Update project
```
PATCH /api/projects/:id
```
Body: any subset of: `name`, `description`, `implementation_id`, `stage`, `rag`, `target_date`, `servicenow_spm_id`, `status_summary`, `portfolio_rank`

#### Delete project
```
DELETE /api/projects/:id
```
Returns: `{ success: true }`

**MCP tools:** `list_projects`, `get_project`, `create_project`, `update_project`, `delete_project`
**Task filtering by project:** `GET /api/tasks?project_id=UUID`
**Create/update tasks with project:** include `project_id` in POST/PATCH task body

---

### APPLICATIONS (Implementations)

The app calls these "Applications" in the UI. Underlying table is `implementations`.

#### List applications
```
GET /api/applications
```
Query params:
- `with_stats=true` — enriches with `blockers_count`, `next_action`, `risk_level`, `risk_score`, and `risk_signals`

Default response: `[{ id, name, phase, rag }]`
With stats: full implementation object + `blockers_count`, `next_action: {id, title}`, `risk_level`, `risk_score`, `risk_signals`

#### Get application detail
```
GET /api/applications/:id
```
Returns: full implementation + `blockers_count`, `open_tasks[]`, `recent_done_tasks[]`

#### Create application
```
POST /api/applications
```
Body:
```json
{
  "name": "string (required)",
  "phase": "Intake",
  "rag": "Green",
  "target_date": "2026-06-01",
  "status_summary": "string",
  "next_milestone": "string",
  "next_milestone_date": "2026-03-15",
  "stakeholders": ["name1", "name2"],
  "keywords": ["keyword1"]
}
```

#### Update application
```
PATCH /api/applications/:id
```
Body: any subset of: `name`, `phase`, `rag`, `target_date`, `status_summary`, `next_milestone`, `next_milestone_date`, `stakeholders`, `keywords`, `priority_weight`, `priority_note`, `portfolio_rank`

#### Copy/generate status update
```
POST /api/applications/:id/copy-update
```
Generates a formatted status update blurb for the application. Returns: `{ text: "..." }`

#### Get application health scores
```
GET /api/applications/health-scores
```
Returns:
```json
[
  {
    "id": "uuid",
    "name": "REDCap",
    "health_score": 70,
    "health_label": "At Risk",
    "signals": ["2 blockers", "3 Blocked/Waiting tasks"],
    "trend": "stable"
  }
]
```

**MCP tool:** `get_application_health_scores`

---

### STAKEHOLDERS

#### List stakeholders
```
GET /api/stakeholders
```
Query: `search` — filters by name/email/org
Returns: array with `open_commitments_count` attached to each.

#### Get stakeholder
```
GET /api/stakeholders/:id
```

#### Create stakeholder
```
POST /api/stakeholders
```
Body: `{ "name": "string (required)", "email": null, "role": null, "organization": null, "notes": null }`

Returned stakeholders always include normalized `context`.

#### Update stakeholder
```
PATCH /api/stakeholders/:id
```
Body: any subset of `name`, `email`, `role`, `organization`, `notes`, `context`

Example context patch:
```json
{
  "context": {
    "last_contacted_at": "2026-03-03T15:00:00Z",
    "preferred_contact": "email",
    "current_priorities": "Finalize UAT plan",
    "notes": "Follow up after steering review"
  }
}
```

---

### COMMITMENTS

Commitments are promises tracked between Brent and a stakeholder.

#### List commitments for a stakeholder
```
GET /api/stakeholders/:id/commitments
```
Returns: array of commitments for that stakeholder.

#### Create commitment
```
POST /api/stakeholders/:id/commitments
```
Body:
```json
{
  "title": "string (required)",
  "direction": "ours",
  "status": "Open",
  "due_at": "2026-02-28T00:00:00Z",
  "notes": "string|null",
  "task_id": "uuid|null"
}
```

#### Update commitment
```
PATCH /api/commitments/:id
```
Body: any subset of: `title`, `status`, `direction`, `due_at`, `done_at`, `notes`, `task_id`

---

### FOCUS DIRECTIVES

Focus directives tell the planner to prioritize or limit certain areas.

#### Get active focus
```
GET /api/focus
```
Query: `include_history=true` — returns recent directives too
Returns: `{ active: FocusDirective|null, directives?: [...] }`

#### Set focus directive
```
POST /api/focus
```
Body:
```json
{
  "text": "Focus on Epic Healthcare this week",
  "scope_type": "implementation",
  "scope_id": "uuid-of-implementation",
  "strength": "strong",
  "is_active": true,
  "starts_at": null,
  "ends_at": null,
  "reason": "Board presentation Friday"
}
```
`scope_type` options: `implementation`, `stakeholder`, `task_type`, `query`
- For `implementation`: provide `scope_id` (UUID)
- For others: provide `scope_value` (string, e.g. stakeholder name or task type)
`strength` options: `nudge`, `strong`, `hard`

#### Update/deactivate focus
```
PATCH /api/focus/:id
```
Body: `{ "is_active": false }` to deactivate.

#### Clear all active focus directives
```
POST /api/focus/clear
```
Deactivates all currently active directives. Returns: `{ cleared: number }`

---

### BRIEFING

The briefing aggregates calendar + tasks + capacity into a snapshot for a given time of day.

#### Get briefing
```
GET /api/briefing
```
Query params:
- `mode` — `morning` | `midday` | `eod` | `auto` (default: auto-detects from current time ET)
- `date` — ISO date string e.g. `2026-02-20` (default: today ET)

Returns a rich object:
```json
{
  "requestedDate": "2026-02-20",
  "mode": "morning",
  "autoDetectedMode": "morning",
  "currentTimeET": "8:45 AM",
  "today": {
    "calendar": { "events": [...], "busyBlocks": [...], "stats": {...}, "focusBlocks": [...] },
    "tasks": { "planned": [...], "completed": [...], "remaining": [...] },
    "capacity": { "available_minutes": 240, "required_minutes": 180, "rag": "Green", "breakdown": {...} },
    "progress": { "completedCount": 2, "totalCount": 5, "percentComplete": 40 }
  },
  "commitments": {
    "cold_commitments": [...]
  },
  "risk_radar": [...],
  "health_scores": [...],
  "tomorrow": { ... }  // only present in eod mode
}
```

Additional briefing data:
- `commitments.cold_commitments` — open `theirs` commitments that have aged past the threshold
- `risk_radar` — per-implementation risk signals
- `health_scores` — per-implementation health scores and trends
- `tomorrow.tomorrow_context` — joins tomorrow’s meetings to related tasks and commitments (EOD mode)

#### Get brief digest
```
GET /api/briefing/digest
```
Query params:
- `mode` — `morning` | `midday` | `eod` | `auto` (default: auto-detects from current time ET)
- `date` — ISO date string e.g. `2026-02-20` (default: today ET)
- `since` — optional ISO timestamp to define the activity window for midday/EOD updates

Returns a deterministic low-token brief payload with:
- `subject` — email-ready subject line
- `markdown` — email-ready markdown body
- `narrative` — opening paragraph
- `sprint` — current sprint summary and health assessment when a sprint is active
- `tasks.due_soon`, `tasks.blocked`, `tasks.in_progress`, `tasks.completed_today`, `tasks.rolled_to_tomorrow`
- `meetings` — only meetings that have not yet ended, including notes/context, matched commitments, and related tasks
- `commitments.theirs` / `commitments.ours` — open commitments grouped by stakeholder
- `guidance_title`, `guidance` — the `Where to Start`, `Afternoon Focus`, or `Tomorrow Prep` section
- `suggested_sync_today` — recommendation only, never auto-apply

#### Get brief render
```
GET /api/briefing/render
```
Query params:
- `mode` — `morning` | `midday` | `eod` | `auto`
- `date` — ISO date string e.g. `2026-02-20`
- `since` — optional ISO timestamp to define the update window

Returns:
- `subject` — email-ready subject line
- `html` — chief-of-staff brief rendered as HTML email
- `text` — plain-text fallback
- `digest` — the underlying deterministic digest facts
- `copy` — LLM-written `opening_narrative`, `what_matters_most`, `guidance`, and `watchout`

#### Get briefing narrative (LLM-generated)
```
GET /api/briefing/narrative
```
Returns an AI-generated prose summary of the current day.

#### Get weekly review
```
GET /api/briefing/weekly-review
```
Optional query params:
- `date` — ISO date `YYYY-MM-DD`; defaults to today and reviews the current week-to-date
- `persist` — optional boolean; when `true`, also stores the weekly snapshot for later monthly review

Returns:
```json
{
  "week": { "start_date": "2026-03-02", "end_date": "2026-03-06" },
  "shipped": [...],
  "stalled": [...],
  "cold_commitments": [...],
  "pending_decisions": [...],
  "health_scores": [...],
  "next_week_suggestions": ["..."]
}
```

#### Get monthly review
```
GET /api/briefing/monthly-review
```
Optional query params:
- `date` — ISO date `YYYY-MM-DD`; defaults to today and reviews the current month-to-date
- `persist` — optional boolean; when `true`, also stores the monthly snapshot

Returns:
```json
{
  "month": { "start_date": "2026-03-01", "end_date": "2026-03-31" },
  "totals": {
    "weekly_snapshot_count": 4,
    "project_status_update_count": 18,
    "projects_with_updates": 5
  },
  "weekly_snapshots": [...],
  "project_rollups": [...]
}
```

**MCP tools:** `get_briefing`, `get_brief_digest`, `get_brief_render`, `get_weekly_review`, `get_monthly_review`

---

### CALENDAR

#### Get calendar events
```
GET /api/calendar?rangeStart=2026-02-20&rangeEnd=2026-02-20
```
Triggers iCal ingestion, then returns events for the date range.
Returns: `{ events, busyBlocks, stats, changesSince, ingest }`

Each event: `{ start_at, end_at, title, with_display, is_all_day, body_scrubbed_preview, meeting_context }`

#### Update meeting context
```
PATCH /api/calendar
```
Body: `{ "external_event_id": "...", "start_at": "...", "meeting_context": "string or null" }`

---

### PLANNER

#### Get today's plan
```
GET /api/planner/plan
```
Returns the AI/scored task plan for today, considering capacity, focus directives, and task priority.

#### Sync Claude picks to Today tab
```
POST /api/planner/sync-today
```
Body:
```json
{
  "task_ids": ["uuid-1", "uuid-2", "uuid-3"]
}
```
Rules:
- `task_ids` is required and must be a non-empty array
- max 20 items
- promotes listed tasks to `Planned`
- sets `due_at` to today when missing
- demotes non-listed `Planned` tasks back to `Backlog` unless `pinned=true`

Returns:
```json
{
  "promoted": 3,
  "demoted": 2,
  "skipped_pinned": 1,
  "sync_at": "2026-02-24T09:05:00Z"
}
```

---

## Common Patterns for Claude

**Morning brief workflow (required)**
1. Generate the morning brief from `GET /api/briefing/digest?mode=morning` or MCP `get_brief_digest`.
2. Select the surfaced task UUIDs for today's focus list.
3. Call `POST /api/planner/sync-today` with `{ "task_ids": [...] }`.
4. Append this confirmation line to the brief:
`✅ Synced X tasks to Today tab (Y demoted, Z pinned task protected).`

**Scheduled email brief workflow**
1. Call `GET /api/briefing/render?mode=morning|midday|eod` or MCP `get_brief_render`.
2. Use `subject` plus `html` for the email body and `text` as fallback.
3. Do not auto-apply `suggested_sync_today`; keep it as a recommendation.

**EOD status-summary workflow (required)**
1. Generate the EOD brief from `GET /api/briefing/digest?mode=eod` or MCP `get_brief_digest`.
2. Identify implementations with meaningful same-day activity (for example: completed tasks, new blockers, cleared blockers, or milestone movement).
3. If no material implementation changes occurred, explicitly say no status-summary drafts are needed.
4. If changes occurred, draft `1-2` sentences per implementation in this format:
`{App} — {Phase} ({RAG}). {Status summary sentence(s)}`
5. Present drafts to Brent for approval before any write call.
6. Only after explicit approval, call `PATCH /api/applications/:id` with `{ "status_summary": "..." }` for each approved draft.

**"What's on my plate today?"**
→ Call `GET /api/briefing/digest?mode=auto` or use `get_brief_digest` — gives the low-token full picture.

**"What are my blockers?"**
→ Call `GET /api/tasks?status=Blocked%2FWaiting` or `GET /api/tasks?status=Backlog&needs_review=true`

**"How are my implementations doing?"**
→ Call `GET /api/applications?with_stats=true`

**"Which applications need attention most?"**
→ Call `GET /api/applications/health-scores` or use `get_application_health_scores`

**"Give me my weekly review"**
→ Call `GET /api/briefing/weekly-review` or use `get_weekly_review`

**"Give me my monthly review"**
→ Call `GET /api/briefing/monthly-review` or use `get_monthly_review`

**"What did I commit to [person]?"**
→ First `GET /api/stakeholders?search=name`, then `GET /api/stakeholders/:id/commitments`

**"Create a task for X"**
→ `POST /api/tasks` with title and any known fields

**"Mark task X as done"**
→ `PATCH /api/tasks/:id` with `{ "status": "Done" }`

**"What's my schedule today?"**
→ `GET /api/calendar?rangeStart=TODAY&rangeEnd=TODAY` (substitute today's ISO date)

**"Add a comment to task X"**
→ `POST /api/tasks/:id/comments` with `{ "content": "..." }`

**"What tasks need my review?"**
→ `GET /api/tasks?needs_review=true`

**"Park this task for later"**
→ `POST /api/tasks/park/:id` or use `park_task`

**"Show me the parking lot"**
→ `GET /api/tasks/parked` or use `list_parked_tasks`

**"Make this recur every week"**
→ `POST /api/tasks/:id/recur` or use `set_task_recurrence`

**"Create next recurring tasks now"**
→ `POST /api/tasks/generate-recurring` or use `generate_recurring_tasks`

**"Plan this week"**
→ Use `list_sprints`, `create_sprint`, `get_sprint`, or `update_sprint`, then update tasks with `sprint_id`

**"Focus on [application] this week"**
→ Get app ID from `GET /api/applications`, then `POST /api/focus` with scope_type=implementation

---

## Notes

- All timestamps are ISO 8601 UTC strings. Dates for calendar range are `YYYY-MM-DD`.
- If calendar events include `time_range_et`, `start_time_et`, `end_time_et`, or `date_et`, use those fields as the source of truth for display instead of converting raw ISO timestamps yourself.
- If calendar events include `temporal_status`, use it directly to decide whether a meeting is past, in progress, or upcoming.
- `priority_score` is 0–100, higher = more urgent. Auto-calculated when status/due_at changes.
- `estimated_minutes` is capped at 480 (8 hours).
- `actual_minutes` is tracked separately and feeds briefing/capacity estimation accuracy.
- Tasks are returned sorted by `priority_score` descending by default.
- `Done` and `Parked` tasks are excluded from most task lists unless explicitly requested.
- When IDs are needed and not known, first list the collection to find them.
- The app is single-user — all data is Brent's.
