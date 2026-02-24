# Baseline

Baseline is a Next.js + Supabase app for daily operations, triage, implementations, and secure calendar-derived briefing signals.

## Local Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env.local` with your Supabase keys and optional provider keys (see Environment Variables below).
4. Run the app:
   ```bash
   npm run dev
   ```

## Environment Variables

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `DEFAULT_USER_ID`, `LLM_ADMIN_USER_ID`, and the settings below.

### Calendar settings

- `CALENDAR_SOURCE=local|ical|none`
  - `local`: load events from local ICS file path (`CALENDAR_LOCAL_ICS_PATH`)
  - `ical`: load events from `WORK_ICAL_URL`
  - `none`: skip ingest and only serve already-stored sanitized rows
- `WORK_ICAL_URL=` optional remote Outlook/M365 ICS feed URL
- `CALENDAR_LOCAL_ICS_PATH=data/calendar/work-calendar.ics`
- `CALENDAR_RETENTION_DAYS=14`
- `CALENDAR_FUTURE_HORIZON_DAYS=30`
- `CALENDAR_BODY_MAX_CHARS=4000`
- `CALENDAR_STORE_BODY=false` (default privacy mode)
- `ENABLE_CALENDAR_ENRICHMENT=false` (reserved)

### Planner settings

- `PLANNER_ENABLE_CRITICAL_EXCEPTION=false`
- `PLANNER_CRITICAL_EXCEPTION_THRESHOLD=90`

### Focus directive API

- `GET /api/focus`: returns current active focus directive (`active`) and optional fallback `note`
- `POST /api/focus`: creates a focus directive (supports `implementation`, `stakeholder`, `task_type`, `query` scopes)
- `PATCH /api/focus/:id`: updates an existing directive (including activation/deactivation)
- `POST /api/focus/clear`: clears active directive(s) for the current user

## Calendar Privacy Model

- Calendar exports in `data/calendar/` are ignored by git.
- Runtime calendar ingestion reads explicit source config only (no XML sharing URL discovery at runtime).
- Stored data is sanitized and scoped by user with Supabase RLS.
- `/api/calendar` returns only approved fields for brief generation and UI cards.
- User-authored meeting context is stored separately (`calendar_event_context`) and merged into `/api/calendar` for planner use.
- `PATCH /api/calendar` supports saving or clearing per-event `meeting_context` notes.

## Authentication

- App API routes require an authenticated Supabase session.
- Use `/login` to request a magic-link sign-in email.
- Callback route (`/auth/callback`) exchanges the auth code and returns to app routes.

## Database

Apply Supabase SQL migrations from `supabase/migrations/`:

- `001_initial_schema.sql`
- `002_calendar_schema.sql`
- `003_task_comments_dependencies.sql`
- `004_add_task_type_task.sql`
- `005_focus_planner_brain.sql`
- `006_calendar_event_context.sql`
- `007_llm_model_eval.sql` — LLM model catalog, user preferences, and usage telemetry
- `008_task_status_workflow.sql` — Renames task status enum values (Next->Backlog, Scheduled->Planned, Waiting->Blocked/Waiting) and adds In Progress
- `009_add_quick_capture_feature.sql` — Adds `quick_capture` to LLM feature CHECK constraints
- `010_missing_rls_policies.sql` — Adds missing RLS policies for inbox_items and status_updates

### Task status values

After migration 008, the valid `task_status` enum values are:

`Backlog` | `Planned` | `In Progress` | `Blocked/Waiting` | `Done`

The old values (`Next`, `Scheduled`, `Waiting`) no longer exist.

### LLM features

Supported feature names for model preferences and usage tracking:

`briefing_narrative` | `intake_extraction` | `quick_capture`

## Validation

Run checks:

```bash
npm run lint
npm run build
npm run test:planner-scoring
npm run test:calendar-sanitize
```

Calendar API contract check (requires running app at `http://localhost:3000` by default):

```bash
npm run dev
# in another terminal
npm run test:calendar-api
```

Optional env for contract test:

- `CALENDAR_API_BASE_URL` (default `http://localhost:3000`)
- `CALENDAR_TEST_BEARER_TOKEN` (if you want to provide an existing token)
