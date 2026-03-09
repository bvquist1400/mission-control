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

Required for the app: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Optional: `DEFAULT_USER_ID`, `LLM_ADMIN_USER_ID`, and the settings below.

If you want machine-auth access for Claude MCP, the legacy ChatGPT custom GPT, or the new public remote MCP deployment, also configure:

- `MISSION_CONTROL_API_KEY` for the existing Claude MCP / legacy machine-auth flow
- `MISSION_CONTROL_ACTIONS_API_KEY` for the private ChatGPT custom GPT Actions flow
- `MISSION_CONTROL_USER_ID` for the user that machine-auth requests run as
- `DEPLOYMENT_ROLE=main|mcp` to split the protected main app from the public MCP deployment
- `MCP_CANONICAL_APP_URL` for stable user-facing URLs returned from `search` / `fetch`
- `MCP_UPSTREAM_API_URL` for the public MCP deployment to call the protected main app upstream routes

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
- `NEXT_PUBLIC_SPRINT_HOLIDAYS=2026-01-01,2026-05-25,2026-07-03` optional comma-separated `YYYY-MM-DD` list used by Today sprint pacing; excluded from workday counts in addition to weekends

### Machine auth settings

- `MISSION_CONTROL_API_KEY`: legacy backend key used by Claude and existing external callers
- `MISSION_CONTROL_ACTIONS_API_KEY`: dedicated backend key used only by the private ChatGPT custom GPT Actions integration
- `MISSION_CONTROL_USER_ID`: required when either machine key is enabled
- `MISSION_CONTROL_ACTIONS_API_KEY` is a Mission Control backend key, not an OpenAI API key
- Use a distinct value for `MISSION_CONTROL_ACTIONS_API_KEY` so `/api/mcp` remains reserved for the legacy Claude key
- The actions key is restricted to the allowlisted non-delete routes used by the ChatGPT Actions surface
- Delete operations are intentionally excluded from the ChatGPT Actions v1 surface

### Remote MCP deployment settings

- `DEPLOYMENT_ROLE=main` on the normal app deployment
- `DEPLOYMENT_ROLE=mcp` on the public MCP-only deployment
- `MCP_CANONICAL_APP_URL=https://your-main-app.example.com` on both deployments
- `MCP_UPSTREAM_API_URL=https://your-main-app.example.com` on the public `mcp` deployment
- The public `mcp` deployment serves only `/api/mcp`, `/oauth/*`, `/.well-known/*`, `/login`, and `/auth/callback`
- The protected main deployment exposes `/api/mcp-upstream` and `/api/mcp-upstream/*` for bearer-token upstream calls only

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
- Claude continues to use `/api/mcp` with `MISSION_CONTROL_API_KEY`.
- ChatGPT uses a private custom GPT with Actions and sends `X-Mission-Control-Key: <MISSION_CONTROL_ACTIONS_API_KEY>`.
- Public remote MCP clients use OAuth authorization code + PKCE with dynamic client registration.
- Public remote MCP auth is limited to `/api/mcp` and `/api/mcp-upstream/*`; general app APIs do not accept MCP OAuth bearer tokens.

## Remote MCP

Mission Control now supports a public remote MCP deployment for hosted MCP-compatible LLM products.

- Public MCP endpoint: `https://<your-mcp-domain>/api/mcp`
- OAuth authorize endpoint: `https://<your-mcp-domain>/oauth/authorize`
- OAuth token endpoint: `https://<your-mcp-domain>/oauth/token`
- Dynamic client registration endpoint: `https://<your-mcp-domain>/oauth/register`
- Authorization server metadata: `https://<your-mcp-domain>/.well-known/oauth-authorization-server`
- Protected resource metadata: `https://<your-mcp-domain>/.well-known/oauth-protected-resource/api/mcp`

Scope model:

- `mcp.read`: read/list/search/fetch/briefing/calendar style operations
- `mcp.write`: non-destructive mutations
- `mcp.delete`: destructive deletes only; request this separately from the default read/write consent

Tool behavior:

- Existing domain-specific tools remain available.
- Generic `search(query)` and `fetch(id)` are additive retrieval tools.
- `search` returns stable URLs pointing to `MCP_CANONICAL_APP_URL`.

Deployment outline:

1. Deploy the existing app normally with `DEPLOYMENT_ROLE=main`.
2. Deploy the same repo a second time with `DEPLOYMENT_ROLE=mcp`.
3. Point `MCP_UPSTREAM_API_URL` on the public `mcp` deployment at the protected main app domain.
4. Keep `MISSION_CONTROL_API_KEY` and `MISSION_CONTROL_ACTIONS_API_KEY` only on `main` while migrating legacy clients.

ChatGPT setup:

1. Open ChatGPT Developer Mode or MCP app setup.
2. Add the public MCP server URL: `https://<your-mcp-domain>/api/mcp`.
3. Let ChatGPT dynamically register as a public OAuth client.
4. Approve the default `mcp.read mcp.write` consent in the browser.
5. Re-run consent with `mcp.delete` only if you explicitly want destructive tools enabled.

Product note:

- As of March 8, 2026, OpenAI Help Center documentation says full write-capable MCP in ChatGPT beta is for Business and Enterprise/Edu, while Pro is read/fetch only in developer mode.
- This is a product-availability constraint, not a code limitation in this repo.

## Mission Control GPT

Use one private custom GPT in ChatGPT as the ChatGPT-facing surface. Claude remains unchanged and continues to use MCP in parallel.

You do not need an OpenAI API key for normal use inside ChatGPT. The only extra credential for this integration is `MISSION_CONTROL_ACTIONS_API_KEY`.

1. Open the GPT builder in ChatGPT and create a private GPT.
2. Paste your adapted Mission Control instructions into the GPT Instructions field.
3. Import the tracked OpenAPI schema from `/openapi/chatgpt-actions-v1.yaml`.
4. Configure the action authentication header as `X-Mission-Control-Key` with `MISSION_CONTROL_ACTIONS_API_KEY`.
5. Add prompt starters such as `morning brief`, `midday brief`, `eod brief`, `weekly review`, `recommend my today list but do not sync yet`, `review these meeting notes and suggest updates`, and `apply these meeting notes to Mission Control`.

Notes:
- The tracked schema file in this repo is [`/Users/owner/dev/Cooper Mission Control/mission-control/public/openapi/chatgpt-actions-v1.yaml`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/public/openapi/chatgpt-actions-v1.yaml).
- A paste-ready builder instruction draft lives at [`/Users/owner/dev/Cooper Mission Control/mission-control/chatgpt-gpt-instructions.md`](/Users/owner/dev/Cooper%20Mission%20Control/mission-control/chatgpt-gpt-instructions.md).
- Re-import the schema in the GPT builder after action-surface changes; the custom GPT does not auto-refresh from this repo.
- Claude still uses MCP.
- ChatGPT uses the private custom GPT with Actions.
- Deletes are intentionally excluded from the ChatGPT Actions v1 schema.

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
- `027_add_mcp_oauth.sql` — Adds OAuth client, authorization code, access token, and refresh token storage for public remote MCP

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
npm run test:mcp-oauth
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
