# Intelligence Layer V1 Implementation Note

## Phase 1 Narrow Choices

## Planned Phase 6 Addition

- Add `recently_unblocked` as the next planned contract in the follow-up / reminder family. It should detect tasks whose blocking dependency was recently cleared so they do not silently become actionable and get missed.
- Planned payload should capture: which dependency cleared and when, how long the task was blocked before clearing, the current task status after unblocking, and the recommended next-action window.
- This is documentation-only for now. It is not part of the implemented v1 detector/promotion/reminder set.


- `follow_up_risk` uses `waiting_on:{taskId}:{normalizedWaitingOn}` as the canonical subject key because this repo does not have a first-class thread or conversation table yet.
- `stale_task` is intentionally limited to `Planned` and `In Progress` tasks. `Blocked/Waiting` work is handled by the dedicated `blocked_waiting_stale` detector instead of double-counting the same wait state by default.
- `ambiguous_task` only promotes from the explicit `needs_review = true` task flag plus missing clarifying task/comment/note context. It does not infer ambiguity from weak title heuristics in v1.
- Notes remain context input only. Active note decisions are preserved as stronger, separate context from note body text rather than flattened into generic note evidence.
- For v1 promotion, `applied` artifacts are treated as resolved and non-suppressing. A later fresh detection of the same family is evaluated as a fresh occurrence rather than being blocked by the historical applied record.
- Artifact evidence must remain a curated review-facing subset of contract evidence. Persistence should not blindly copy full detector evidence into the human-facing artifact record.
- Cross-type grouping remains explicit rather than default. The persistence/promotion layer only groups `stale_task` + `ambiguous_task` for the same task when the caller enables that rule.
- If a grouped artifact already exists and a later run only regenerates one covered family, v1 preserves the grouped artifact and records a grouped no-op instead of silently splitting the grouped review object back into single-family artifacts.
- Phase 3’s initial reminder slice operationalizes only accepted `follow_up_risk` artifacts. The concrete reminder output is an existing `task_comments` row with `source = 'system'`, plus a reminder execution ledger row, followed by an `accepted -> applied` artifact transition.
- Reminder execution remains proposal-layer-bound: it starts only from persisted accepted artifacts, writes the reminder output, records the execution as `started` then `completed`, and only then marks the artifact `applied`. If a completed execution already exists, v1 recovers by marking the artifact `applied` without emitting a duplicate comment; a lingering `started` execution is treated as in-flight and skipped in this narrow first slice.
- Phase 5 scheduled execution reuses the repo’s existing Vercel-cron route pattern while preserving New York local time year-round. Because Vercel cron is UTC-only, the deployment schedules paired weekday UTC triggers at `09:00/10:00` and `15:00/16:00`, and the route only executes during the first ten minutes of `05:00` or `11:00` in `America/New_York`. That keeps the effective schedule pinned to New York time across DST without changing detector or promotion behavior.
