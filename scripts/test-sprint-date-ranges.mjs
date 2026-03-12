#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), "src/lib/date-only.ts")
).href;

const dateOnly = await import(moduleUrl);

const {
  addDateOnlyDays,
  getSprintWeekRange,
  isDateOnlyAfter,
  isMondayToFridaySprintRange,
  resolveSprintWeekRange,
} = dateOnly;

assert.equal(addDateOnlyDays("2026-03-09", 7), "2026-03-16", "Date-only day math should stay on the same calendar day");
assert.equal(addDateOnlyDays("2026-03-09", -7), "2026-03-02", "Negative date-only offsets should work");
assert.equal(
  isDateOnlyAfter("2026-03-17", "2026-02-25"),
  true,
  "Later dates should compare after earlier dates"
);
assert.equal(
  isDateOnlyAfter("2026-02-25", "2026-02-25"),
  false,
  "Matching dates should not count as after"
);
assert.equal(
  isDateOnlyAfter("2026-02-24", "2026-02-25"),
  false,
  "Earlier dates should not compare after later dates"
);

assert.deepEqual(
  getSprintWeekRange("2026-03-03"),
  { startDate: "2026-03-02", endDate: "2026-03-06" },
  "A midweek date should resolve to that week's Monday-Friday sprint"
);
assert.deepEqual(
  getSprintWeekRange("2026-03-08"),
  { startDate: "2026-03-02", endDate: "2026-03-06" },
  "A weekend date should resolve to the previous work week"
);

assert.deepEqual(
  resolveSprintWeekRange("2026-03-03", "2026-03-06"),
  { startDate: "2026-03-02", endDate: "2026-03-06" },
  "Same-week dates should normalize to Monday-Friday"
);
assert.equal(
  resolveSprintWeekRange("2026-03-03", "2026-03-09"),
  null,
  "Cross-week sprint dates should be rejected"
);
assert.equal(
  isMondayToFridaySprintRange("2026-03-02", "2026-03-06"),
  true,
  "A canonical Monday-Friday range should be considered valid"
);
assert.equal(
  isMondayToFridaySprintRange("2026-03-03", "2026-03-09"),
  false,
  "A Tuesday-to-Monday range should be considered invalid"
);

console.log("Sprint date range tests passed.");
