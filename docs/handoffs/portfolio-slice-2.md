# Portfolio slice 2: builder handoff detail (task 2f1cc72b)

The Baseline task comment has the summary and the reviewer prompts. This file holds the detail that didn't fit.

Branch `feat/portfolio-slice2`, base `c2c5123` (origin/main):

1. `9aae61b` Data + lists: migration 057, planned dates in the API/MCP/timeline, actionable-only "Assigned to you" with "Coming to you later", and the hand-back answer box.
2. `99e5cd1` The redesigned task page (`/r/task/[id]`, mockup section 4).
3. This file.

Nothing is pushed, deployed or applied to prod.

## Migration 057

- `project_sections.planned_start` / `planned_end`: `date`, nullable, no default. ADD COLUMN is catalog-only.
- `project_sections_planned_range_check`: `planned_start IS NULL OR planned_end IS NULL OR planned_end >= planned_start`. Either date can be set alone.
- Idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD`). Rollback: `supabase/rollbacks/057_add_section_planned_dates.down.sql`.
- The CHECK validates existing rows when it's added. Every existing row has both dates NULL, so it can't fail, but on prod the table gets a short `ACCESS EXCLUSIVE` lock. project_sections is small (tens of rows).
- `src/types/supabase.generated.ts`: `npm run gen:types` uses `--linked` (prod), so I generated from the private stack (`supabase gen types typescript --local`) and applied only the six `planned_*` lines. The file is otherwise byte-identical to the committed one (the local output drops the `__InternalSupabase` header). `test:types-drift` reports drift until 057 is on prod.

## Timeline only: what reads the planned dates

- They're read by `loadPortfolioInput` (`sections` select), by `buildTimeline` (`src/lib/portfolio.ts`), and by the section API/MCP responses (`PROJECT_SECTION_COLUMNS`).
- `listOwnedProjectSections` (used by the brief digest) now selects them too, so the `ProjectSection` type is truthful. The digest only uses the id, name, project and sort order: `groupTasksByProjectSections` takes a `Pick<…>`. `digest.ts` is unchanged.
- Nothing writes tasks. A lane's overdue red comes from task due dates only; a planned end in the past is never red.
- Proof: `test:portfolio-db` builds the AM and EOD digests, snapshots the task rows (due_at, priority_score, base_priority, status, updated_at) and the Portfolio outside the timeline, sets planned dates, and asserts all three are identical. Only the generation clock is ignored. The pure `test:portfolio` checks the same for the model.

## Choices I made (closest reversible option where the mockup is silent)

1. **"Coming to you later"** sits inside the "Assigned to you" tile, under a dashed divider, as a small list with a "Blocked" badge. Each item shows the app, what it waits on (the `waiting_on` text and the titles of unfinished dependencies), "next look <date>" from `follow_up_at` (else the due date), and the status line. The title opens the editor.
2. **Blocked** = status Blocked/Waiting, or an unresolved dependency (`fetchTaskDependencySummaries`, Brent's open tasks only, in chunks of 100). A dependency whose task is Done unblocks it.
3. **Hero:** the count is actionable items only. The sub-line reads "N more come to you once unblocked." when any are blocked. App rows get a quiet "Later · N" chip next to "You · N" (actionable). The timeline's "You" marker on lanes is unchanged: it means any open task of his.
4. **Timeline:** a section with planned dates is drawn from them, solid. With only a planned start and no dates on its tasks, the end is still a dashed estimate a week past the start. A section with planned dates appears even before it has tasks ("Planned · no tasks yet"). A backwards pair (the DB forbids it) falls back to the estimate. Legend: "Planned" is renamed "Not started" (it was the state colour) and dashed is "No dates yet (estimate)", plus one line of fine print.
5. **Decision warning** is a soft, one-time stop, not a hard requirement. The first Send shows the warning and the button becomes "Send without an answer"; typing in the box clears it. It applies on the Portfolio row, in the editor and on the task page. Decision = tag `decision` (any case) or a title starting "Decide:" or "Decision" (not "Decisions…").
6. **Box open by default** for any Brent-owned task, in the editor (no autofocus when it opens itself) and on the task page, including his blocked ones. Portfolio rows keep the "Hand back" button (an open box on every row would crowd the list).
7. **Task page:**
   - No "I'm stuck" button; Edit covers status changes.
   - The checklist is read-only on the page (tick items in Edit).
   - The description is a tile between the header and the two columns, folded when over 700 characters.
   - With no status line, "Where this stands" is built from the task's fields ("With Codex, blocked (waiting on Release 3.1). 1 of 1 checklist items done.").
   - Page width is 920 px, like the Portfolio (other records stay 820).
8. **Comments:**
   - Newest first. The latest 20 are shown; older ones fold under "Show N older comments".
   - "Add a comment" on the page saves "Brent: <text>" so agents and the gists know it's his.
   - Author chips come from the house prefixes, since comments have no author column: "Brent…:" / "Brent (handed back):" → You; "PM <date> <time>:" (stamp stripped), "HANDOFF" → Builder, "REVIEW" → Codex / Fable / Reviewer, "Claimed by…". Unknown text gets no chip, and "PM, can you…" is not attributed to the PM.
9. **Gist rule** (`commentGist`, pure):
   - It's the first sentence of the first paragraph (at least 12 characters; "e.g.", "vs.", initials and "5.5" don't end it) or, if there is none, that paragraph.
   - It's cut to 140 characters at a word with "…". Markdown markers, bullets, link URLs and code fences are removed.
   - "Show the full comment" appears only when the gist leaves something out, and unfolds the full Markdown.

## Tests (9/29, one at a time, private stack `mc-slice2`, API 59321 / DB 59322)

| Script | Result |
|---|---|
| test:portfolio | 33 passed (+7) |
| test:task-handoff | 17 passed (+3) |
| test:task-page (new, pure) | 20 passed |
| test:portfolio-db (new, local stack) | 14 passed |
| test:task-owner-db | 16 passed |
| test:mcp-contract | OK, 80 tools (snapshot +34 lines, additions only) |
| test:briefs / briefs-am | 20 / 17 |
| test:briefs-db / review-db / r2-db / am-db | 20 / 4 ok / 5 / 5 |
| the 21 other scripts | pass |
| test:today-sprint | npm script lacks the alias loader (pre-existing); passes with `--loader` |
| test:calendar-api | not run (needs a live app with a calendar feed) |
| test:types-drift | not run (reads prod) |

`npx tsc --noEmit` is clean, eslint on the 21 changed ts/tsx/mjs files is clean, and `npm run build` is OK.

**Fail-before:** the base `src/` (c2c5123) was checked out over the branch, with 057 rolled back for the DB suite:
- test:portfolio: 8 failed (the new actionable, planned and decision tests).
- test:task-handoff: 3 failed.
- test:portfolio-db: 13 of 14 failed. The "unchanged" proof passes on base, as it should.
- test:task-page: fails to load without `src/lib/task-page.ts`.

## Screenshots

Taken on the production build (`next start`), 390 px and 1280 px, light and dark. No page or dialog is wider than the viewport, and there are no console errors. Local only: the scratchpad `shots-final/` (41 PNGs).
- Portfolio with both lists and planned timelines.
- Task pages: long comments, the checklist, a dependency-blocked task, and an application record (the reader is unchanged).
- Flows:
  - Decision warning on the row and in the editor (`decision-*`).
  - Task page: unfold, add a comment, and a decision hand-back with its warning (`taskpage-*`).
  - The slice 2a modal and row hand-backs (`desktop-dark-*`, `row-phone-light-*`): hero 5 → 4.

Seed: Brent's real app/section/task snapshot from slice 1. Hand-set in the seed: planned dates, three blocked Brent tasks, a Decide task, the checklist and the comment texts, which are modelled on real ones and shortened.
