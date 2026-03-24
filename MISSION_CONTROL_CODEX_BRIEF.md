# Mission Control Codex Build Brief

Use this brief to implement the Mission Control v1 canonical work-intelligence layer on top of the existing Mission Control app and API surface.

Read `MISSION_CONTROL_V1.md` first for the product contract. This brief is the implementation-facing companion.

## Build Goal

Create a Mission Control canonical tool/service layer so briefs and work-operating guidance do not have to manually stitch together raw task, calendar, commitment, and project reads in prompt space every time.

The backend/tool layer should:
- gather relevant data
- rank or compute what matters
- attach confidence, freshness, and caveats
- return a structured, operator-ready payload

The final model layer should do only the last-mile interpretation and voice.

Do not make the model reconstruct these conclusions from raw lists if a higher-level service can do it deterministically.

Important style rule: preserve the candidness of the original brief voice across daily, weekly, and monthly layers. Broader review windows should not cause the system to drift into sterile retrospective language or polished executive-report tone.

## Product Principles

1. **Mission Control remains the source of truth**
   - Keep operational reads and deterministic derivation in the app/backend layer.
   - Do not create a parallel work-reasoning datastore just to support briefs.

2. **Use job-shaped canonical services**
   - The assistant-facing service/tool surface should mirror Mission Control’s recurring work jobs.

3. **Prefer smart wrappers over raw mirrors**
   - Expose high-level operational reads.
   - Low-level list/get helpers can continue to exist beneath them.

4. **Be honest about uncertainty**
   - Every canonical read should expose confidence, freshness, and caveats.

5. **Avoid fake operational insight**
   - “No single dominant priority” and “status data looks stale” are valid outputs.

6. **Optimize for consistency and correctness over abstract flexibility**
   - Opinionated v1 services are better than generic mush.

## Canonical V1 Services / Tools

Build these 10 assistant-facing canonical reads:

1. `work_priority_stack_read`
2. `work_open_commitments_read`
3. `work_meeting_context_read`
4. `work_execution_state_read`
5. `work_tomorrow_prep_read`
6. `work_sync_today_recommendation_read`
7. `work_daily_brief_read`
8. `work_eod_review_read`
9. `work_weekly_review_read`
10. `work_monthly_review_read`

These are the public/canonical Mission Control v1 reads.

## Shared Contract Expectations

All canonical reads should return a common metadata shape where practical.

### Shared top-level metadata
Each canonical read should expose:
- `confidence` (`high | medium | low`)
- `freshness`
  - latest relevant timestamps by source where practical
  - stale/missing flags
- `caveats`
  - short human-readable caveat strings
- `supportingSignals`
  - concise structured reasons, not giant dumps
- optional `rawSignals`
  - only when explicitly requested via input flag
- `generatedAt`

Optional but encouraged:
- `sourceSummary`
- `missingDataFlags`
- `operatorContextUsed`

### General input conventions
All tools/services should support, where relevant:
- `date` or `anchorDate` (optional)
- optional `timezone`
- optional `includeRawSignals`
- optional `includeNarrativeHints` for render-layer handoff

## Service 1: `work_priority_stack_read`

### Purpose
Return the ranked set of work items that deserve Brent’s attention now, with reasons and rank logic visible.

### Inputs
Required/standard:
- `date` (optional if defaulted)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `limit`
- `focusScope` (`general | implementation | stakeholder | sprint | project`)
- `focusEntityId`
- `includeDeferredButImportant` (optional)

### Internal composition
Should read/derive from:
- tasks across overdue, due-soon, in-progress, blocked/waiting states
- focus directive if available
- implementation/project/sprint context
- capacity or meeting load if relevant
- recent task-comment activity
- stale-status detection

Should compute:
- ranked items
- why each item ranks where it does
- what should not be touched yet
- whether current data is fresh enough for a strong call

### Output shape
Suggested:
- `window`
- `topItems`
  - `taskId`
  - `title`
  - `rank`
  - `recommendedAction`
  - `whyNow`
  - `riskIfIgnored`
  - `statusFreshness`
- `deferForNow`
- `primaryTradeoff`
- shared metadata fields

### Notes
This should become one of the foundational services behind briefs and sync recommendations.

## Service 2: `work_open_commitments_read`

### Purpose
Return the open commitments state, grouped by stakeholder and split between what others owe Brent and what Brent owes others.

### Inputs
Required/standard:
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `direction` (`theirs | ours | both`)
- `staleThresholdDays`
- `includeColdFollowups`
- `stakeholderId`

### Internal composition
Should read/derive from:
- commitments
- stakeholders
- linked task state when present
- due dates / aging
- recent task or commitment activity

Should compute:
- grouped commitments
- cold follow-ups
- dependency concentration risk
- which commitment thread matters most right now

### Output shape
Suggested:
- `window`
- `theirs`
- `ours`
- `coldFollowups`
- `primaryRisk`
- `stakeholderHotspots`
- shared metadata fields

### Notes
This should not just mirror the commitments table. It should interpret aging, ownership, and risk.

## Service 3: `work_meeting_context_read`

### Purpose
Return the upcoming meetings that matter, what context belongs with them, and what prep would change the outcome.

### Inputs
Required/standard:
- `date` or `fromDateTime` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `lookaheadHours`
- `onlyUpcoming`
- `includeLowRelevance`
- `maxMeetings`

### Internal composition
Should read/derive from:
- calendar events
- calendar event context
- stakeholders
- commitments
- related tasks
- recent project/task signals if helpful

Should compute:
- meetings worth caring about
- meeting relevance ranking
- prep context
- unresolved issues linked to each meeting

### Output shape
Suggested:
- `window`
- `meetings`
  - `title`
  - `timeRange`
  - `relevance`
  - `whyItMatters`
  - `prepNotes`
  - `linkedStakeholders`
  - `openCommitments`
  - `relatedTasks`
- `topMeeting`
- `meetingsNeedingPrep`
- shared metadata fields

### Notes
Prefer relevance and leverage over exhaustive calendar recitation.

## Service 4: `work_execution_state_read`

### Purpose
Return the clearest current operating read: what is moving, blocked, stale, overloaded, or slipping.

### Inputs
Required/standard:
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `since`
- `compareToEarlierToday`
- `scope` (`day | sprint | project | implementation`)
- `scopeId`

### Internal composition
Should read/derive from:
- tasks by status
- due timing
- completed today
- stale follow-ups
- blocked/waiting items
- recent comment activity
- capacity and meeting load if relevant
- sprint/project health where helpful

Should compute:
- current operating state
- top risk
- momentum / traction assessment
- overload state
- stale-status confidence penalties

### Output shape
Suggested:
- `window`
- `summary`
- `topRisk`
- `momentum`
- `whatMoved`
- `whatIsStuck`
- `whatLooksStale`
- `loadAssessment`
- shared metadata fields

### Notes
This is the main “what’s actually going on?” service.

## Service 5: `work_tomorrow_prep_read`

### Purpose
Return the concrete prep Brent should do before the next work block starts.

### Inputs
Required/standard:
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `lookaheadDays`
- `includeColdFollowups`
- `includeMeetingPrep`

### Internal composition
Should read/derive from:
- incomplete tasks
- due-soon / rollover candidates
- next-day meetings
- cold commitments / stale follow-ups
- project/sprint context

Should compute:
- true rollover set
- tomorrow-first items
- prep actions
- what should be ready before the day opens

### Output shape
Suggested:
- `window`
- `rolloverItems`
- `tomorrowFirstThings`
- `meetingPrep`
- `coldFollowups`
- `prepPriorities`
- shared metadata fields

### Notes
This should not just list incomplete work. It should distinguish tomorrow-critical prep from general leftovers.

## Service 6: `work_sync_today_recommendation_read`

### Purpose
Return the ranked recommendation for which tasks should be added, kept, or left off today’s active list.

### Inputs
Required/standard:
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `maxTasks`
- `respectPinned` (default true)
- `focusScope`
- `focusEntityId`

### Internal composition
Should read/derive from:
- priority stack
- capacity logic
- due-soon tasks
- in-progress tasks
- blocker / dependency state
- existing synced today list and pinned state
- meeting load where helpful

Should compute:
- add/keep/drop recommendations
- rank order
- the main tradeoff behind each choice
- approval-required reminder metadata

### Output shape
Suggested:
- `window`
- `recommendations`
  - `action` (`add | keep | drop`)
  - `taskId`
  - `title`
  - `rank`
  - `reason`
  - `tradeoff`
- `capacitySummary`
- `approvalRequired`
- shared metadata fields

### Notes
This service should remain recommendation-only. Actual `sync_today` execution stays a separate approved write.

## Service 7: `work_daily_brief_read`

### Purpose
Return a fully structured, brief-ready morning/midday/eod payload built by composing the canonical reads above.

### Inputs
Required/standard:
- `mode` (`morning | midday | eod | auto`)
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `since`
- `includeNarrativeHints`
- `includeSectionMarkdown`

### Internal composition
Should compose from:
- `work_priority_stack_read`
- `work_open_commitments_read`
- `work_meeting_context_read`
- `work_execution_state_read`
- `work_tomorrow_prep_read` (especially for eod)
- `work_sync_today_recommendation_read` (especially for morning/midday)

Should compute:
- brief mode selection if `auto`
- section payloads per brief mode
- narrative hints for render layer
- confidence/freshness rollup from composed reads

### Output shape
Suggested:
- `requestedDate`
- `mode`
- `briefHeadline`
- `narrativeHints`
- `sections`
  - `tasks`
  - `meetings`
  - `commitments`
  - `guidance`
  - `doneToday` / `rollover` / `tomorrowPrep` as mode requires
- `suggestedSyncToday`
- shared metadata fields

### Notes
This should become the canonical wrapper behind `/api/briefing/digest`.
The render layer should consume this structured result instead of rebuilding logic.

## Service 8: `work_eod_review_read`

### Purpose
Return a durable end-of-day review artifact that captures the day’s honest operating outcome in a review-friendly structured shape.

### Inputs
Required/standard:
- `date` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `persist`
- `includeNarrativeHints`
- `includeSectionMarkdown`

### Internal composition
Should compose from:
- `work_execution_state_read`
- `work_tomorrow_prep_read`
- `work_open_commitments_read` where useful
- current day task completion / rollover state
- existing daily brief logic where it already works

Should compute:
- what actually got done
- what rolled forward
- what remained blocked or cold
- what tomorrow needs first
- a durable daily review payload suitable for weekly aggregation

### Output shape
Suggested:
- `requestedDate`
- `dayOutcome`
- `completedToday`
- `rolledForward`
- `openBlockers`
- `coldFollowups`
- `tomorrowFirstThings`
- `operatingRisks`
- `narrativeHints`
- shared metadata fields

### Persistence rule
This read should support durable storage as the daily review layer that weekly review consumes.
It should not depend on the render layer for its source-of-truth meaning.

## Service 9: `work_weekly_review_read`

### Purpose
Return a weekly review by reading stored EOD review artifacts first, then supplementing with lower-level data only when needed.

### Inputs
Required/standard:
- `date` or `anchorDate` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `persist`
- `includeNarrativeHints`
- `includeDailyArtifacts`

### Internal composition
Should compose from:
- stored `work_eod_review_read` artifacts for the weekly window
- project status updates / review history where useful
- shipped/stalled/pending-decision/cold-commitment rollups where useful
- lower-level raw reads only for supplementation or missing daily artifacts

Should compute:
- weekly patterns across day-end artifacts
- recurring blockers, rollovers, and pressure points
- what actually moved across the week
- what next week needs to protect or change
- a durable weekly review payload suitable for monthly aggregation

### Output shape
Suggested:
- `period`
- `dailyReviewCount`
- `weekPattern`
- `whatMoved`
- `whatKeptSlipping`
- `recurringRisks`
- `projectRollups`
- `nextWeekCalls`
- `narrativeHints`
- shared metadata fields

### Persistence rule
This read should persist a durable weekly review artifact.
Monthly review should consume these stored weekly artifacts instead of regenerating the month from scratch.

## Service 10: `work_monthly_review_read`

### Purpose
Return a monthly review by reading stored weekly review artifacts first, then supplementing with project history only where needed.

### Inputs
Required/standard:
- `date` or `anchorDate` (optional)
- `timezone` (optional)
- `includeRawSignals` (optional)

Optional additions to keep:
- `persist`
- `includeNarrativeHints`
- `includeWeeklyArtifacts`

### Internal composition
Should compose from:
- stored `work_weekly_review_read` artifacts for the monthly window
- project status history and durable review history where useful
- lower-level raw reads only where the weekly layer is missing needed detail

Should compute:
- the month’s defining patterns
- what improved, worsened, or stayed stuck
- recurring operating issues across the weekly summaries
- what the next month should do differently

### Output shape
Suggested:
- `period`
- `weeklyReviewCount`
- `monthPattern`
- `directionChanges`
- `recurringPressurePoints`
- `projectRollups`
- `nextMonthCalls`
- `narrativeHints`
- shared metadata fields

### Persistence rule
This read should persist a durable monthly review artifact for later comparison and future higher-level summaries.

## Daily -> Weekly -> Monthly Review Chain

This architecture should explicitly work as a durable review ladder:
- `work_eod_review_read` persists daily review artifacts
- `work_weekly_review_read` reads those EOD artifacts first and persists weekly review artifacts
- `work_monthly_review_read` reads stored weekly review artifacts first and persists monthly review artifacts

Higher-order reviews should prefer lower-order persisted review artifacts and only fall back to raw operational reads when the lower layer is missing detail or needs supplementation.

This keeps review logic layered, reduces repeated re-derivation, and preserves the candidness of the original daily brief voice as the time horizon widens.

## Internal Helper Modules To Add

These do not necessarily need to be public MCP tools.
Prefer keeping them internal unless a clear external use case appears.

Recommended internal helpers:
- `getDataFreshnessSnapshot`
- `detectStaleStatuses`
- `buildPriorityStack`
- `buildCommitmentRiskSummary`
- `rankUpcomingMeetings`
- `buildExecutionStateRead`
- `buildTomorrowPrepRead`
- `buildSyncTodayRecommendations`
- `buildEodReviewArtifact`
- `buildWeeklyReviewFromDailyArtifacts`
- `buildMonthlyReviewFromWeeklyArtifacts`
- `mergeCanonicalReadMetadata`
- `buildNarrativeHints`

These helpers should centralize work-logic and reduce duplicated reasoning across briefs and other reads.

## Recommended Build Order

Do **not** rebuild everything at once.

### Phase 1
Build first:
1. `work_priority_stack_read`
2. `work_execution_state_read`
3. shared metadata / freshness shape

Why:
- highest leverage
- underpins most other reads
- easiest to validate against current briefing behavior

### Phase 2
Build next:
4. `work_open_commitments_read`
5. `work_meeting_context_read`
6. `work_sync_today_recommendation_read`

Why:
- they add the stakeholder/calendar intelligence layer
- they improve daily brief usefulness without requiring a full rewrite first

### Phase 3
Build next:
7. `work_tomorrow_prep_read`
8. `work_eod_review_read`
9. `work_daily_brief_read`

Why:
- the daily layer should split into conversational briefing versus durable end-of-day review artifact production
- the brief wrapper becomes thinner and cleaner
- the daily review artifact becomes the weekly review substrate

### Phase 4
Build next:
10. `work_weekly_review_read`
11. `work_monthly_review_read`

Why:
- once durable daily artifacts exist, weekly can aggregate them cleanly
- once durable weekly artifacts exist, monthly can aggregate those instead of re-deriving the month from scratch
- this preserves layered review continuity

### Phase 5
Optional refactor/cleanup:
- rework `/api/briefing/digest` to delegate to `work_daily_brief_read`
- keep `/api/briefing/render` as a thin narrative render pass only
- rework weekly/monthly routes to delegate to canonical review reads
- expose new canonical reads through MCP if useful for Claude/OpenAI/OpenClaw usage

## Testing Expectations

Minimum expectations:
- unit/service-level tests for each canonical read
- stale-data tests
- missing-data tests
- low-confidence tests
- overloaded-day tests
- no-strong-priority tests
- no-important-meeting tests
- conflicting-signal tests
- sync recommendation approval-gating tests

Especially test:
- stale status data with recent comments that imply movement
- overloaded days where the best recommendation is to defer something important
- meeting context with weak or partial notes
- commitment hotspots with ambiguous linked tasks
- EOD rollover logic when nothing is marked Done today

### Important behavior rule
A canonical read should be allowed to return:
- lower confidence
- mixed signal
- no single dominant priority
- status data looks stale
- no meeting needs meaningful prep
- no good sync recommendation beyond keeping the list tight

These are valid outputs, not failures.

## Non-Goals For This Build

Do not try to build:
- a general org intelligence engine
- autonomous work management with silent writes
- giant generic `work_summary` mush that blurs all job boundaries
- speculative strategy advice from sparse operational data
- CRM replacement behavior
- broad transcript-memory stuffing into every brief

Keep the v1 layer aligned to Mission Control’s recurring work jobs.

## Durable Context (Small, Explicit, Not Transcript Soup)

To preserve some of the “Claude has context” feel without bloating token cost, add support for a small optional operator-context input/object.

This is not chat-history replay.
It is a tiny durable context shape such as:
- current focus directive
- current pressure points
- known stale-status caveat
- near-term implementation emphasis

Suggested shape:
- `operatorContext.summary`
- `operatorContext.currentFocus`
- `operatorContext.pressurePoints[]`
- `operatorContext.styleHints[]`

Use it sparingly in canonical reads and render prompts.

## Deliverables Codex Should Produce

1. **Canonical service contracts**
   - schemas for inputs and outputs
   - shared metadata schema

2. **Internal helper/service functions**
   - reusable ranking and derivation logic

3. **Thin route wrappers**
   - route handlers that delegate to canonical services

4. **Tests**
   - especially around stale data, uncertainty, and overload tradeoffs

5. **Sample fixture outputs**
   - inspectable example payloads for each canonical read

## Suggested First Checkpoint

The first checkpoint should not be “all briefs rewritten.”
It should be:

### Checkpoint A
- shared canonical metadata shape defined
- `work_priority_stack_read` implemented
- `work_execution_state_read` implemented
- sample outputs reviewed for operational correctness
- current digest logic updated to reuse at least one of these helpers/services

That will prove the canonical-layer direction before broader refactors.

## Recommended Starting Point In This Repo

Codex should first inventory the current Mission Control briefing and planner surface and identify:
- which logic in `src/lib/briefing/digest.ts` already maps cleanly to canonical reads
- which helper logic already exists for capacity, prep, sprint progress, and meeting decoration
- which APIs can remain unchanged while route internals are refactored
- where stale-status and freshness logic should become shared helpers instead of ad hoc logic
- which parts of `/api/briefing/render` should stay purely render-layer and lose responsibility for any latent business logic

Do not assume all canonical reads need to be built from scratch.
Prefer extracting and formalizing existing sound logic where it already works.
