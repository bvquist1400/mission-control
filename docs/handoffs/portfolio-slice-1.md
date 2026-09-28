# Portfolio slice 1 — builder handoff detail (task 2f1cc72b)

The Baseline task comment has the summary and the reviewer prompt. This file holds the detail that didn't fit.

## Design choices

- **Rows = applications** (implementations). Timeline lanes = project sections, plus one "Other tasks" lane for a project's unsectioned tasks; a project with no sections is one lane named after the project. Cancelled projects are skipped.
- **% done = Done ÷ all tasks** in the app. Recurring templates don't count; Parked and Missed count as not done. Rounding never shows 100% with work left or 0% once anything is done.
- **Where it stands** = the most recently updated open task's `status_line`, else the first sentence of the app's `status_summary`. **Next** = the app's `next_milestone` (+ date), else the soonest upcoming due open task, else the top-priority open task.
- **Timeline**: ET calendar dates throughout. A lane runs from its earliest task creation (or earlier due date) to its latest due date. Open lanes with no due date are dashed and end a week after today. Done lanes end at the last update (tasks have no completed_at). The window starts on a Monday, at most 8 weeks back, and ends at most 12 weeks ahead; longer bars get a "→". Lanes that finished before the window are hidden and counted.
- **Scope**: Personal / Work / All via `?scope=`, default Personal, using the existing `personal` tag rule (task tag or project tag).
- **Full-bleed**: `/portfolio` and `/r/*` render without the sidebar, like `/briefs/*`, with a "← Baseline" link, so the v5 light/dark look doesn't sit next to the dark-only rail.
- **Markdown**: an in-repo parser instead of a new dependency. Single newlines inside a paragraph become line breaks (the way these notes are written). Headings shift down one level (the page title is the h1).

## Tests run (9/28 ~5:25 PM, one at a time, private local stack)

| Script | Result |
|---|---|
| test:portfolio (new, pure) | 26 passed |
| test:task-owner-db (new, local stack) | 14 passed |
| test:mcp-contract | OK, 80 tools (snapshot updated: additions only) |
| test:briefs / briefs-am | 20 / 17 passed |
| test:briefs-db / briefs-r2-db / briefs-review-db / briefs-am-db | 20 / 5 / 4 / 5 passed |
| planner-scoring, personal-exclusion, task-recurrence, calendar-sanitize, sprint-dates, week-board, mcp-oauth, mcp-intelligence-artifacts, notes, intelligence-layer (5 suites), implementation/meeting/task notes UI, work-intelligence, project-sections, task-external-source | all pass |
| test:today-sprint | npm script lacks the alias loader (pre-existing); 1/1 passes when run with `--loader ./scripts/alias-loader.mjs` |
| test:calendar-api | not run: needs a live app on :3000 with a calendar feed |
| test:types-drift | not run: reads the linked prod project; will report drift until 056 is applied, then should pass |

Also: `npx tsc --noEmit` clean, eslint clean on changed files, `npm run build` OK, 056 rollback → re-apply round trip OK.

## Local setup (reviewer)

Scratchpad: `/private/tmp/claude-501/-Users-owner-dev-Cooper-Mission-Control/00cb8eda-06a0-4795-89b5-cd98b3642245/scratchpad/`

- `stack/` — Supabase config, project `mc-portfolio`, API 56321, DB 56322, migrations symlinked to this worktree. Stopped with data kept: `supabase start --workdir <scratchpad>/stack`.
- A fresh stack doesn't grant old tables to the API roles. Run `local-grants.sql` (docker exec into `supabase_db_mc-portfolio`), then re-run lines 258–259 of `055_add_briefs.sql`, because the blanket grant re-opens `brief_item_transition` to anon and `test:briefs-db` checks that it's closed.
- `test:briefs-r2-db` needs `BRIEFS_TEST_DB_CONTAINER=supabase_db_mc-portfolio`.
- Seed: `seed-portfolio.mjs` (then `seed-updated-at.sql` via psql) and `seed-note.mjs`; the preview user's login is in `local-seed-login.txt`. Owners and status lines in the seed are hand-set.
- Preview: config `portfolio-local` (port 3110) in `/Users/owner/dev/Cooper Mission Control/.claude/launch.json`; the worktree's `.env.local` points at the local stack.
- Screenshots: `capture.mjs <outdir> <paths> [--open-all]` (headless Chrome, cookie sign-in). Final set in `shots-final/` (20 PNGs).
- Local-only noise: "JWT issued at future" in the layout's brief-status query comes from Docker clock skew.
