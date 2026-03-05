#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), "src/lib/today/sprint-progress.ts")
).href;

const sprintProgress = await import(moduleUrl);

const {
  parseSprintHolidaySet,
  countBusinessDaysInclusive,
  addBusinessDays,
  calculateSprintProgressMetrics,
} = sprintProgress;

const parsedHolidays = parseSprintHolidaySet("2026-03-04, nope, 2026-02-30, 2026-03-05");
assert.equal(parsedHolidays.has("2026-03-04"), true);
assert.equal(parsedHolidays.has("2026-03-05"), true);
assert.equal(parsedHolidays.size, 2, "Only valid YYYY-MM-DD holidays should be parsed");

assert.equal(
  countBusinessDaysInclusive("2026-03-02", "2026-03-08"),
  5,
  "Mon-Sun week should include five business days"
);
assert.equal(
  countBusinessDaysInclusive("2026-03-02", "2026-03-08", new Set(["2026-03-04"])),
  4,
  "A configured holiday should reduce business-day count"
);

assert.equal(addBusinessDays("2026-03-06", 0), "2026-03-06", "Adding zero days should keep a weekday date");
assert.equal(addBusinessDays("2026-03-07", 0), "2026-03-09", "Weekend start should roll to next business day");
assert.equal(addBusinessDays("2026-03-06", 1), "2026-03-09", "Friday +1 business day should land on Monday");
assert.equal(
  addBusinessDays("2026-03-06", 1, new Set(["2026-03-09"])),
  "2026-03-10",
  "Holiday should be skipped when adding business days"
);

const onTrackMetrics = calculateSprintProgressMetrics({
  sprintStartDate: "2026-03-02",
  sprintEndDate: "2026-03-13",
  todayDate: "2026-03-06",
  totalTasks: 10,
  completedTasks: 5,
});
assert.equal(onTrackMetrics.daysLeft, 6, "Days left should include today when it is a workday");
assert.equal(onTrackMetrics.expectedCompletedByNow, 5);
assert.equal(onTrackMetrics.tasksBehindPace, 0);
assert.equal(onTrackMetrics.forecastFinishDate, "2026-03-12");
assert.equal(onTrackMetrics.forecastWithinSprint, true);
assert.equal(onTrackMetrics.onTrack, true);

const atRiskForecastMetrics = calculateSprintProgressMetrics({
  sprintStartDate: "2026-03-02",
  sprintEndDate: "2026-03-13",
  todayDate: "2026-03-06",
  totalTasks: 10,
  completedTasks: 2,
});
assert.equal(atRiskForecastMetrics.tasksBehindPace, 3);
assert.equal(atRiskForecastMetrics.forecastWithinSprint, false);
assert.equal(atRiskForecastMetrics.onTrack, false);

const noTrendMetrics = calculateSprintProgressMetrics({
  sprintStartDate: "2026-03-02",
  sprintEndDate: "2026-03-13",
  todayDate: "2026-03-06",
  totalTasks: 6,
  completedTasks: 0,
});
assert.equal(noTrendMetrics.forecastFinishDate, null, "No completion trend should produce null forecast");
assert.equal(noTrendMetrics.forecastWithinSprint, null);
assert.equal(noTrendMetrics.onTrack, false);

console.log("Today sprint progress tests passed.");
