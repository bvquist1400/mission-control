# Work Notes V1 Implementation Note

## Confirmed Calendar Event Identity

- The repo already had a canonical event-identity pattern in MCP/search: `calendar:<encoded>`.
- The encoded portion is base64url of `source|externalEventId|startAt`.
- Work Notes V1 reuses that exact format for `note_links.entity_id` when `entity_type = 'calendar_event'`.
- The shared helper now lives in `src/lib/calendar-event-identity.ts`.

## Confirmed `updated_at` Maintenance Pattern

- The repo uses a shared Postgres trigger function, `set_updated_at()`.
- New tables with `updated_at` fields attach table-specific `BEFORE UPDATE` triggers that call that shared function.
- Work Notes V1 follows that pattern for `notes` and `note_decisions` in `supabase/migrations/032_add_notes.sql`.

## Deviations And Constraints

- The original prompt referenced `users(id)`, but this repo does not expose a public `users` table. The new note tables reference `auth.users(id)` instead.
- Calendar-event note links validate against `calendar_events(user_id, source, external_event_id, start_at)`, which is the repo’s stable row-level event identity.
- Existing meeting-context storage in the repo still keys context by `{source, external_event_id}`; Work Notes V1 keeps that behavior untouched and uses the more specific row-level event identity only for note linking.
- Entity-filtered note listing defaults to an any-link match for the requested entity. Callers can now add `link_role` to narrow results to a specific relationship semantics such as `primary_context` or `meeting_for`.
- The shared notes domain was split so `src/lib/notes.ts` keeps the public service surface while `src/lib/notes-shared.ts` and `src/lib/notes-relations.ts` hold validation, normalization, entity resolution, and hydration helpers.
