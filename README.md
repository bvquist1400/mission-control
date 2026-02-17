# Mission Control

Mission Control is a Next.js + Supabase app for daily operations, triage, implementations, and secure calendar-derived briefing signals.

## Local Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create local env:
   ```bash
   cp .env.example .env.local
   ```
3. Fill in Supabase keys and optional provider keys in `.env.local`.
4. Run the app:
   ```bash
   npm run dev
   ```

## Environment Variables

Primary variables are defined in `.env.example`.

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
