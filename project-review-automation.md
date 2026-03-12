# Project Review Automation

This workflow adds durable project-status history plus persisted weekly and monthly review snapshots so n8n can build daily, weekly, and month-end review loops without reconstructing everything from the current task state.

Importable workflow export:

- `n8n/mission-control-project-reviews.json`

## New storage

- `project_status_updates`
  - one upserted snapshot per `project_id` plus `captured_for_date`
  - intended for the daily 4:00 PM ET project status pass
- `briefing_review_snapshots`
  - persisted `weekly` and `monthly` review payloads
  - unique per user plus review window

## Auth

Send either machine key header:

```http
X-Mission-Control-Key: <MISSION_CONTROL_API_KEY or MISSION_CONTROL_ACTIONS_API_KEY>
```

## Daily project status pass

Recommended schedule: weekdays at `16:00` ET, before the `16:45` EOD brief.

Suggested n8n shape:

1. `GET /api/projects?with_stats=true`
2. Filter to projects worth summarizing.
   - examples: `open_task_count > 0`, `blockers_count > 0`, or `completed_task_count` changed recently
3. For each project, call:
   - `GET /api/tasks?project_id=<uuid>`
   - optional: `GET /api/project-status-updates?project_id=<uuid>&limit=5`
4. Ask Claude for a compact JSON payload.
5. `POST /api/project-status-updates`

The importable workflow already includes this branch. Replace the placeholder machine key and Anthropic API key values in the HTTP Request nodes before activation.

Example write payload:

```json
{
  "project_id": "uuid",
  "captured_for_date": "2026-03-12",
  "summary": "API integration is moving, but the vendor dependency is still the pacing item.",
  "rag": "Yellow",
  "changes_today": [
    "Closed 2 subtasks tied to the integration contract",
    "Added follow-up notes from the vendor thread"
  ],
  "blockers": [
    "Waiting on vendor sandbox credentials"
  ],
  "next_step": "Validate the callback flow once credentials arrive.",
  "needs_decision": "Decide whether to mock the sandbox if credentials slip past Friday.",
  "related_task_ids": ["task-uuid-1", "task-uuid-2"],
  "source": "n8n",
  "model": "claude-sonnet-4-6",
  "payload": {
    "open_tasks": 6,
    "done_today": 2
  },
  "sync_project_status_summary": true
}
```

Notes:

- `sync_project_status_summary` defaults to `true`.
- Same-day reruns upsert the existing daily row instead of creating duplicates.

## Weekly review

Recommended schedule: Friday at `16:10` ET.

Persist the deterministic weekly snapshot:

```bash
curl -s \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  "https://mission-control-orpin-chi.vercel.app/api/briefing/weekly-review?persist=true"
```

This returns the review and stores it in `briefing_review_snapshots`.

The importable workflow also turns that response into a short Gmail message.

If you want a separate LLM-written weekly narrative, generate it in n8n and then store it with:

```http
POST /api/briefing/review-snapshots
```

## Monthly review

Recommended schedule: last business day of the month after the weekly review has run.

Month-to-date structured review:

```bash
curl -s \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  "https://mission-control-orpin-chi.vercel.app/api/briefing/monthly-review?persist=true"
```

The monthly review aggregates:

- stored weekly review snapshots for the month
- stored project status updates for the month

The importable workflow gates this branch to the last business day of the month and emails the summary after persisting it through Gmail.

Useful read APIs:

- `GET /api/project-status-updates?from=2026-03-01&to=2026-03-31`
- `GET /api/briefing/review-snapshots?review_type=weekly&from=2026-03-01&to=2026-03-31`
- `GET /api/briefing/review-snapshots?review_type=monthly&limit=12`

## MCP

These are also available in MCP now:

- `get_weekly_review` with optional `persist=true`
- `get_monthly_review` with optional `persist=true`
