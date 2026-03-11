# Daily Brief Email Workflow

Use `GET /api/briefing/render` as the email-facing endpoint for scheduled brief emails.

## Why

- One server-side call replaces the old calendar/tasks/stakeholders/commitments fan-out.
- Facts stay deterministic through the digest layer.
- A small LLM pass adds the candid chief-of-staff framing.
- The response already includes `subject`, `html`, and `text`.
- n8n only needs to schedule the call and hand the result to an email node.

## Auth

Send either the legacy or actions machine key:

```http
X-Mission-Control-Key: <MISSION_CONTROL_API_KEY or MISSION_CONTROL_ACTIONS_API_KEY>
```

## Recommended schedules

- Morning: `08:05` ET with `mode=morning`
- Midday: `12:30` ET with `mode=midday`
- EOD: `16:45` ET with `mode=eod`

For midday and EOD, pass `since` when you want the update window to start from the morning brief send time. If you omit it, the digest falls back to the start of the ET day.

## Example requests

Morning:

```bash
curl -s \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  "https://mission-control-orpin-chi.vercel.app/api/briefing/render?mode=morning"
```

Midday with an explicit activity window:

```bash
curl -s \
  -H "X-Mission-Control-Key: $MISSION_CONTROL_API_KEY" \
  "https://mission-control-orpin-chi.vercel.app/api/briefing/render?mode=midday&since=2026-03-11T13:05:00.000Z"
```

## Response fields n8n should use

- `subject` -> email subject
- `html` -> primary email body
- `text` -> plain-text fallback
- `syncApprovalText` -> optional copy/paste block for approving `sync_today` in chat
- `digest` -> structured facts if you want to log or inspect the brief

## Minimal n8n shape

1. Cron trigger at the chosen ET schedule.
2. HTTP Request node to `/api/briefing/render`.
3. Email node using `{{$json.subject}}`, `{{$json.html}}`, and `{{$json.text}}`.

Do not auto-apply `suggested_sync_today`. The digest only recommends changes.

## Importable workflow

Repo export:

- `n8n/mission-control-daily-briefs.json`

What it includes:

- weekday morning, midday, and EOD schedule triggers
- one HTTP Request node per brief mode
- one SMTP Send Email node per brief mode
- ET-based `since` calculation for midday and EOD using `08:05 ET`
- workflow timezone set to `America/New_York`

Setup after import:

1. Import `n8n/mission-control-daily-briefs.json` into n8n.
2. Attach your SMTP credential to each `Send ... Email` node.
3. Either set these n8n environment variables or replace the placeholder expressions directly in the nodes:
   - `MISSION_CONTROL_BASE_URL`
   - `MISSION_CONTROL_ACTIONS_API_KEY` or `MISSION_CONTROL_API_KEY`
   - `DAILY_BRIEF_TO_EMAIL`
   - `DAILY_BRIEF_FROM_EMAIL`
4. Save, test one branch manually, then activate the workflow.

The workflow is imported inactive on purpose.

## Manual sync_today follow-up

If the email's `Suggested sync_today` section looks right, you can copy those recommended lines back into an MCP-enabled chat and approve them there.

Recommended operator flow:

1. Copy the suggested `sync_today` items including task IDs.
2. Paste them into Claude/ChatGPT connected to Mission Control.
3. Say `sync these` or `apply this sync_today recommendation`.

That keeps the email as recommendation-only while still letting the chat apply the change after explicit approval.
