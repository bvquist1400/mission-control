#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), 'src/lib/planner/scoring.ts')
).href;

const scoring = await import(moduleUrl);

const {
  calculatePriorityBlend,
  calculatePlannerScore,
  calculateStatusAdjust,
  isExceptionTask,
  isFollowUpDue,
  getPlannerConfigFromEnv,
  DEFAULT_PLANNER_CONFIG,
} = scoring;

const nowMs = Date.parse('2026-02-17T15:00:00.000Z');
const oneHourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
const threeHoursAheadIso = new Date(nowMs + 3 * 60 * 60 * 1000).toISOString();
const threeDaysAheadIso = new Date(nowMs + 3 * 24 * 60 * 60 * 1000).toISOString();

// 1) Clamp checks for priority_score before priorityBlend.
assert.equal(calculatePriorityBlend({ priority_score: null }), 0);
assert.equal(calculatePriorityBlend({ priority_score: -10 }), 0);
assert.equal(calculatePriorityBlend({ priority_score: 200 }), 15);

// 2) Explicit status adjust checks.
assert.equal(calculateStatusAdjust({ blocked: true }, nowMs).statusAdjust, -25);
assert.equal(calculateStatusAdjust({ waiting: true }, nowMs).statusAdjust, -15);
assert.equal(calculateStatusAdjust({ blocked: true, waiting: true }, nowMs).statusAdjust, -40);
assert.equal(calculateStatusAdjust({ waiting_on: 'Vendor reply' }, nowMs).statusAdjust, -15);
assert.equal(calculateStatusAdjust({ waiting_on: '   ' }, nowMs).statusAdjust, 0);

// 3) Blocked + follow-up due net effect.
assert.equal(
  calculateStatusAdjust({ blocked: true, follow_up_at: oneHourAgoIso }, nowMs).statusAdjust,
  10
);

// Follow-up parsing failure should not count as due.
assert.equal(isFollowUpDue({ follow_up_at: 'not-a-date' }, nowMs), false);

// Urgency must be pre-multiplier in score composition.
const urgencyPreMultiplier = calculatePlannerScore(
  {
    priority_score: 100,
    due_at: threeHoursAheadIso,
  },
  {
    nowMs,
  }
);
assert.equal(urgencyPreMultiplier.priorityBlend, 15);
assert.equal(urgencyPreMultiplier.urgencyBoost, 30);
assert.equal(urgencyPreMultiplier.preMultiplierScore, 45);
assert.equal(urgencyPreMultiplier.finalScore, 45);

// 4) Exception true for due within 24h.
assert.equal(
  isExceptionTask({ due_at: threeHoursAheadIso }, nowMs, DEFAULT_PLANNER_CONFIG),
  true
);

// 5) Exception true for blocked + follow-up due.
assert.equal(
  isExceptionTask(
    { blocked: true, follow_up_at: oneHourAgoIso, due_at: threeDaysAheadIso },
    nowMs,
    DEFAULT_PLANNER_CONFIG
  ),
  true
);

// 6) Critical exception appears only when includeCritical=true.
assert.equal(
  isExceptionTask(
    { priority_score: 95, due_at: threeDaysAheadIso },
    nowMs,
    DEFAULT_PLANNER_CONFIG
  ),
  false
);
assert.equal(
  isExceptionTask(
    { priority_score: 95, due_at: threeDaysAheadIso },
    nowMs,
    {
      ...DEFAULT_PLANNER_CONFIG,
      exceptions: {
        ...DEFAULT_PLANNER_CONFIG.exceptions,
        includeCritical: true,
      },
    }
  ),
  true
);

// 7) With flag off, high priority alone should not be exception.
assert.equal(
  isExceptionTask(
    { priority_score: 100, due_at: threeDaysAheadIso },
    nowMs,
    {
      ...DEFAULT_PLANNER_CONFIG,
      exceptions: {
        ...DEFAULT_PLANNER_CONFIG.exceptions,
        includeCritical: false,
      },
    }
  ),
  false
);

// Env-driven critical exception config.
const envEnabled = getPlannerConfigFromEnv({
  PLANNER_ENABLE_CRITICAL_EXCEPTION: 'true',
  PLANNER_CRITICAL_EXCEPTION_THRESHOLD: '93',
});
assert.equal(envEnabled.exceptions.includeCritical, true);
assert.equal(envEnabled.exceptions.criticalThreshold, 93);

const envInvalid = getPlannerConfigFromEnv({
  PLANNER_ENABLE_CRITICAL_EXCEPTION: 'banana',
  PLANNER_CRITICAL_EXCEPTION_THRESHOLD: 'not-a-number',
});
assert.equal(envInvalid.exceptions.includeCritical, DEFAULT_PLANNER_CONFIG.exceptions.includeCritical);
assert.equal(envInvalid.exceptions.criticalThreshold, DEFAULT_PLANNER_CONFIG.exceptions.criticalThreshold);

console.log('Planner scoring patch v2 tests passed.');
