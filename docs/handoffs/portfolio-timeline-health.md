# Portfolio timeline: progress fill and health (task 7f60062d)

Branch `claude/portfolio-health`, base `feca80e`. Nothing is pushed, deployed or migrated (planned dates already exist, migration 057).

## What the timeline shows now

- A section with **both** planned dates is a row: its planned window is the track, filled left to right by tasks done ÷ tasks in the section.
- Health chip beside the name, from `laneHealth()` in `src/lib/portfolio.ts` (pure; today in ET):
  - no tasks: grey "No tasks yet"; nothing open: "Done"; before the start: grey "Starts M/D"
  - after the planned end with work open: red "Late · due M/D"
  - expected = (days from start to today + 0.5) ÷ window days (both end days counted), clamped 0–1
  - done share + 0.25 < expected: amber "Behind"; done share ≥ expected + 0.15: green "Ahead"; otherwise green "On track"
- App card chip: worst health among started sections **drawn on the chart**, as just "Late", "Behind" or "On track" (never the lane's "Late · due M/D"); none when nothing drawn has started. Line: "Target M/D · X of Y tasks done", counting drawn sections only (finished, unscheduled and long-past sections change neither the chip nor the count). Shown only when the project has a `target_date` or a section is drawn.
- The target date (label "Target M/D") is a purple diamond in the axis row plus a dashed guide through the rows. The window stretches to include it (up to 12 weeks ahead); a target beyond that, or already past, has no marker but still appears in the line. Cancelled and Done projects' targets are ignored; with several projects the nearest upcoming target wins.
- "Earlier and unscheduled · N sections" (collapsed) lists, with "X of Y done": finished sections, sections with no planned dates (or only one of the two), each project's "Other tasks", and sections whose window ended more than 8 weeks ago. Each row also says "in progress" or "waiting", "overdue since M/D" (a task due date has passed) and the "You" badge. No more dashed guessed bars; an app with nothing drawn shows only this list, open by default.
- Phone width (under 720 px): name, chip and meta sit above the bar, full width, with no sideways scroll; wide: name beside the bar.
- Planned dates still never change due dates, Assigned to you, priority, briefs or counts. Lane "overdue red" from task due dates no longer exists on the timeline: Late is judged from the planned end.

Files: `src/lib/portfolio.ts`, `src/lib/portfolio-queries.ts` (selects `projects.target_date`), `src/components/portfolio/PortfolioPage.tsx`, `src/components/portfolio/portfolio.css`, `scripts/test-portfolio.mjs`.
