# Calendar Data (Local Development Only)

Use this directory only for local `.ics` calendar exports while developing.

## Local file setup

1. Export an Outlook/M365 calendar feed as ICS.
2. Save it locally at:
   `data/calendar/work-calendar.ics`
3. Set `CALENDAR_SOURCE=local` in `.env.local`.
4. Keep `CALENDAR_LOCAL_ICS_PATH=data/calendar/work-calendar.ics` (or update to your local path).

## Security rules

- Never commit calendar exports (`.ics`, `.xml`, or similar) to git.
- Runtime ingestion does not read sharing XML files from this folder.
- Store only sanitized calendar content in Supabase through the API pipeline.
