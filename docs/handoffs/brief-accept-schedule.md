# Brief Accept: assign to Brent + pick a due date

Baseline task `98683030-840a-4737-bed5-ec0d74e64299`. Branch
`feat/brief-accept-schedule`, base `ffb7e40`.

## Why

Accept on a brief proposal created a Backlog task with no due date, and since
migration 056 the task defaulted to `owner = 'agent'`, so accepted work never
showed in Brent's "Assigned to you" (Brent: "I don't want to miss any").

## What changed

| Area | Change |
|---|---|
| `supabase/migrations/058_brief_accept_owner_due.sql` | `CREATE OR REPLACE brief_item_transition`, same signature, locking, compare-and-set, `SECURITY INVOKER`, `search_path`, REVOKE/GRANT. Only the task INSERT changes: `owner = 'brent'` and `due_at` from the optional `p_task->>'due_at'`. Absent/JSON null = no date. Anything else must match an ISO 8601 timestamp with an explicit offset and cast cleanly, else `22023` and the whole call (the item claim included) rolls back. `now`, `today`, `infinity`, `epoch`, date-only, offset-less, impossible dates and non-strings are all refused. |
| `supabase/rollbacks/058_brief_accept_owner_due.down.sql` | 055's function block verbatim (lines 118–259 of 055), inside BEGIN/COMMIT. |
| `src/lib/briefs/due.ts` (new, browser-safe) | ET date math moved here from `keys.ts` (re-exported there unchanged) plus the Accept choices: `today` (today ET), `tomorrow` (exactly `resolveTomorrowDueAt`, as carry-over uses it), `this_week` (Friday of this ET week; next Friday from Fri/Sat/Sun), `none`, or a `YYYY-MM-DD`. Every date = 23:59:59.999 ET that day via `buildRecurringDueAt` (DST-correct). |
| `src/lib/briefs/validate.ts` | Actions: optional `due` on `accept` only; strict (preset any case, or an exact real `YYYY-MM-DD`); `null`, `""`, other words, loose dates → 400. Items: optional `suggested_due` on `proposed_task` only; must be an exact real `YYYY-MM-DD`, else the save is rejected (items are strict by design; the routine retries on errors). |
| `src/lib/briefs/service.ts` | Accept resolves `due ?? "tomorrow"` at the action's `now`, sends `due_at` to the RPC, and includes the due date in the first priority score (the due-proximity boost). A date `due` must equal the item's `suggested_due` (400 otherwise, before anything runs). The result gains `due_at` and `owner` only when that call created the task. A repeat Accept is still a no-op success (`already: true`) and never touches the task. `getBrief` also reads the task `owner` (additive). |
| `src/app/api/mcp/route.ts` + snapshot | `act_on_brief_items` actions accept `due`; `save_brief` / `save_eod_brief` items accept `suggested_due` (without it, zod would strip the field). Additive only; snapshot updated. |
| `src/components/briefs/*` | Under each open proposal card: "Due" + a chip for the notes' date ("Mon 10/12 (from notes)", pre-selected when present) + Today / Tomorrow / This week / No date (Tomorrow pre-selected otherwise) + the ET day a relative choice lands on. The Accept button and the A key send the card's pick. The accepted tile reads "Accepted · yours · due Wed 9/30" or "… · no date" (falls back to the old "Accepted 4:15 PM" until the task is loaded). On a phone the row sits above the buttons. |
| `docs/routines/eod.md` | New section "Proposed: due dates on proposals (not live until Brent OKs the routine change)" with the field, a one-paragraph prompt addition and the chat syntax. The prompt between the lines is unchanged. |
| Tests | `scripts/test-briefs-accept.mjs` (pure, 14) and `scripts/test-briefs-accept-db.mjs` (local stack, 10), with `test:briefs-accept` / `test:briefs-accept-db` in `package.json`. |

The AM routine produces no `proposed_task` items (morning.md: "No
`proposed_task` items: proposals come from meeting notes, and that's the EOD's
job"). Nothing in the code branches on edition, so a proposal on any brief
behaves the same; the DB test proves it on an AM brief.

`src/types/supabase.generated.ts` is unchanged: the function signature is the
same, and types generated from the local stack differ from the committed file
only in the linked-only `__InternalSupabase` header.

## How to verify

Local stack (own project id, ports 62321/62322): on a fresh stack run the
local grants, then lines 258–259 of 055 (docs/handoffs/portfolio-slice-1.md,
"Local setup"). Then:

```
BRIEFS_TEST_SUPABASE_URL=http://127.0.0.1:62321 BRIEFS_TEST_ANON_KEY=… \
BRIEFS_TEST_SERVICE_ROLE_KEY=… BRIEFS_TEST_DB_CONTAINER=supabase_db_<project> \
npm run test:briefs-accept-db
npm run test:briefs-accept
```

The DB test covers: default = tomorrow ET with owner brent; today / this_week /
none / the notes' date; priority includes the due boost; a wrong or missing
notes date is a 400 with nothing changed; a repeat Accept with any other
choice leaves the task row identical; racing Accepts with different dues give
one task; the page path under RLS; an AM brief; the RPC refusing 16 bad
`due_at` shapes with 22023 and no claim; and 058 applied twice, rolled back to
055's exact function (md5 of `pg_get_functiondef`, same security/grants,
accepted tasks' rows identical), old behaviour back on the rollback, then
re-applied. It leaves the stack on 058.

On the page: open a brief with open proposals, pick a chip, press Accept (or
A), and check the tile says where it went; the task shows in Portfolio
"Assigned to you".

## Prod order (each step needs Brent's OK in chat)

1. **Migration 058 first** (`db push --linked --dry-run`, then `--yes`, per the
   PM recipe). Safe with the current code: the deployed service sends no
   `due_at`, so Accepts made between the two steps get owner brent and no due
   date.
2. **Then deploy the code** (fast-forward main, push, both Vercel contexts
   green). Deploying the code first would make Accept send `due_at` to the old
   function, which ignores it: tasks would be created as owner agent with no
   date until 058 lands.
3. Only after both, and only with Brent's OK: the routine prompt addition in
   `docs/routines/eod.md` (a live routine change).

Rollback: apply `supabase/rollbacks/058_brief_accept_owner_due.down.sql`
(Accept goes back to owner agent / no date; tasks already created keep what
they have), and revert the code if wanted. The code works on either function.

## Not done / residual risks

- The rollback restores the body of `055_add_briefs.sql` as committed. That it
  equals the function live in prod was not checked (no prod reads); a reviewer
  with prod read access can compare `md5(pg_get_functiondef(...))`.
- A notes date already in the past is still offered and pre-selected (the
  task is then overdue at once). Brent can pick another choice.
- The relative-date preview on the card uses the viewer's clock; it only
  differs from the server's result in the seconds around ET midnight.
- CLAUDE.md / AGENTS.md still say "latest: 057" and don't mention the due
  choice (outside this build's allowed paths).
