# Portfolio timeline: progress fill and health (task 7f60062d)

Branch `claude/portfolio-health`, base `feca80e`. Nothing is pushed, deployed or migrated (planned dates already exist, migration 057).

## What the timeline shows now

- A section with **both** planned dates is a row: its planned window is the track, filled left to right by tasks done ÷ tasks in the section.
- Health chip beside the name, from `laneHealth()` in `src/lib/portfolio.ts` (pure; today in ET):
  - no tasks: grey "No tasks yet"; nothing open: "Done"; before the start: grey "Starts M/D"
  - after the planned end with work open: red "Late · due M/D"
  - expected = (days from start to today + 0.5) ÷ window days (both end days counted), clamped 0–1
  - done share + 0.25 < expected: amber "Behind"; done share ≥ expected + 0.15: green "Ahead"; otherwise green "On track"
- App card chip: worst health among started sections (Late > Behind > On track; "Done" when every scheduled section is finished; none when nothing has started). Line: "App Store target M/D · X of Y launch-list tasks done", counting sections with planned dates only. The name comes from `APP_TARGET_NAMES` (only Stock & Stir → "App Store"); anything else reads "Target M/D". Shown only when the project has a `target_date` or any planned section.
- The target date is a purple diamond in the axis row plus a dashed guide through the rows. The window stretches to include it (up to 12 weeks ahead); a target beyond that, or already past, has no marker but still appears in the line. Cancelled and Done projects' targets are ignored; with several projects the nearest upcoming target wins.
- "Earlier and unscheduled · N sections" (collapsed) lists, with "X of Y done": finished sections, sections with no planned dates (or only one of the two), each project's "Other tasks", and sections whose window ended more than 8 weeks ago. No more dashed guessed bars; an app with no planned sections at all shows only this list.
- Phone width (under 720 px): name, chip and meta sit above the bar, full width, with no sideways scroll; wide: name beside the bar.
- Planned dates still never change due dates, Assigned to you, priority, briefs or counts. Lane "overdue red" from task due dates no longer exists on the timeline: Late is judged from the planned end.

Files: `src/lib/portfolio.ts`, `src/lib/portfolio-queries.ts` (selects `projects.target_date`), `src/components/portfolio/PortfolioPage.tsx`, `src/components/portfolio/portfolio.css`, `scripts/test-portfolio.mjs`.
