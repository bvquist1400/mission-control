#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), "src/lib/today/week-board.ts")
).href;

const {
  addDateOnlyDays,
  getDateStartInTimeZone,
  getDisplayedWeekRange,
  isDueAtInDisplayedWeek,
  isDueAtInWeekStarting,
} = await import(moduleUrl);
const timeZone = "America/New_York";
const tuesdayAfterDueTime = new Date("2026-08-04T22:00:00Z");

assert.equal(
  isDueAtInDisplayedWeek("2026-08-04T21:00:00Z", tuesdayAfterDueTime, timeZone),
  true,
  "An overdue Tuesday task must remain eligible for Tuesday's board column"
);

assert.deepEqual(
  getDisplayedWeekRange(tuesdayAfterDueTime, timeZone),
  { start: "2026-08-03", end: "2026-08-09" },
  "The displayed week must run Monday through Sunday"
);
assert.equal(addDateOnlyDays("2026-08-03", 7), "2026-08-10");
assert.equal(
  isDueAtInWeekStarting("2026-08-12T16:00:00Z", "2026-08-10", timeZone),
  true,
  "A future selected week must include its own due tasks"
);
assert.equal(
  isDueAtInWeekStarting("2026-08-09T16:00:00Z", "2026-08-10", timeZone),
  false,
  "A selected week must exclude tasks from the preceding week"
);
assert.equal(
  getDateStartInTimeZone("2026-08-10", timeZone).toISOString(),
  "2026-08-10T04:00:00.000Z",
  "Summer week boundaries must use the EDT offset"
);
assert.equal(
  getDateStartInTimeZone("2026-12-07", timeZone).toISOString(),
  "2026-12-07T05:00:00.000Z",
  "Winter week boundaries must use the EST offset"
);
assert.equal(
  isDueAtInDisplayedWeek("2026-08-04T23:00:00Z", tuesdayAfterDueTime, timeZone),
  true,
  "A not-yet-due Tuesday task must remain eligible for Tuesday's board column"
);
assert.equal(
  isDueAtInDisplayedWeek("2026-08-07T21:00:00Z", tuesdayAfterDueTime, timeZone),
  true,
  "A task later in the displayed week must remain eligible"
);
assert.equal(
  isDueAtInDisplayedWeek("2026-08-02T21:00:00Z", tuesdayAfterDueTime, timeZone),
  false,
  "Older overdue work must stay out of the displayed week columns"
);
assert.equal(
  isDueAtInDisplayedWeek("2026-08-03T03:30:00Z", tuesdayAfterDueTime, timeZone),
  false,
  "The week boundary must use the configured timezone, not the UTC date"
);

console.log("Weekly board date eligibility tests passed.");
