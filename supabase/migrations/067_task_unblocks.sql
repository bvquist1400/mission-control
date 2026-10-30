-- 067: "Now unblocked" (Baseline task 2f6b39f2, slice S2 = task 1349c17a; plan
-- /Users/owner/dev/baseline-plans/unblocked-and-datepicker/PLAN.md, rules 1-8).
--
-- Brent 10/30 ("yes all three"):
--   * a later due date is kept ("Keep the later date (Recommended)"): only a
--     missing or past due date moves to the unblock day;
--   * the pill stays "Until I act, no limit": NO timeout. It clears only when
--     Brent starts, finishes, parks or re-dates the task, adds a new blocker,
--     the blocker is reopened, or (S3) he acts on its brief row;
--   * also waiting on something else: "Pill, but stay Waiting (Recommended)".
--
-- When a task or a commitment becomes Done, each task waiting on it (an active
-- task_dependencies link, is_resolved = false) whose OTHER active links all
-- point at Done items is unblocked. Done is written by the task API (app, MCP,
-- FamCal) AND by SQL (brief_item_transition's "Done"), so this is a database
-- trigger, not app code. "Resolved" means exactly what the app computes
-- (src/lib/task-dependencies.ts isDependencyResolved: status = 'Done'; a
-- Dropped commitment still blocks). Removing a link by hand is not a trigger.
--
-- NO BACKFILL: applying 067 changes no existing row. tasks.unblocked_at is added
-- nullable with no default (no rewrite, every row NULL), task_unblocks starts
-- empty, and tasks waiting on items that are ALREADY Done are left alone. Only
-- Done events after 067 is live unblock anything.
--
-- 1. tasks.unblocked_at (new, nullable, additive): set while the task shows the
--    green "Now unblocked" pill; NULL otherwise. Every existing task read that
--    selects * (GET /api/tasks/{id}, the task lists, Today, MCP get_task /
--    list_tasks) returns it, so S3 and MCP need no new read. Written only by
--    the functions below (transaction-local setting
--    mission_control.unblock_writer = 'on', which no API request can set):
--    trg_tasks_unblock_pill (BEFORE INSERT/UPDATE) forces it NULL on INSERT
--    (a new or copied task is never "now unblocked"), ignores any other attempt
--    to set it (keeps the old value), and treats a write of NULL as a manual
--    clear. No foreign key to task_unblocks (it would make PostgREST embeds
--    between the two tables ambiguous); the invariant "unblocked_at IS NOT NULL
--    iff the task has an open task_unblocks row" is kept by every path below.
--
-- 2. task_unblocks (new table): one row per unblock, for the pill, Undo and S3's
--    brief section ("unblocked since the previous brief": user_id + unblocked_at,
--    open = cleared_at IS NULL). It records the item whose Done unblocked it
--    (blocker_type + blocker_task_id / blocker_commitment_id), every item it was
--    waiting on at that moment (waited_on_task_ids / waited_on_commitment_ids),
--    the ET landing day, the status, due date and priority before and after, the
--    change token (062's due_change_id) its due-date write produced, its system
--    comment, and when/why the pill cleared and whether it was reverted. At most
--    one open row per task (unique partial index). Owner can read; rows are
--    written only by the functions here (RLS policies require the setting
--    above); never deleted except with their task (ON DELETE CASCADE).
--
-- 3. task_unblock_on_status_change() (AFTER UPDATE OF status on tasks AND on
--    commitments, only when the status enters or leaves Done):
--    a. Enters Done: for each task W with an active link to it (id order):
--       lock W (FOR NO KEY UPDATE) BEFORE re-reading its links, so two blockers
--       finished at the same moment can't both miss the last-one check (the
--       second waits for the first's commit, then its fresh READ COMMITTED read
--       sees it), and a link added or a blocker reopened concurrently (both also
--       lock W before acting) is either seen or sees this. Then W is unblocked only if
--       ALL its active links point at Done items, W is Backlog, Planned, In
--       Progress or Blocked/Waiting (Parked, Missed, Done untouched), and W has
--       no open unblock already (a bulk Done of two blockers in one statement
--       unblocks once). Rule by rule:
--       - status (rule 3): Blocked/Waiting -> Planned only when nothing else
--         holds it (waiting_on empty, or blocked_reason 'prerequisite');
--         otherwise it stays Blocked/Waiting with the pill. Other statuses are
--         unchanged. waiting_on / blocked_reason / follow_up_at are not touched
--         (the task API doesn't clear them on a status change either);
--       - due date (rule 4, Brent: keep the later date): the landing day is the
--         unblock day in ET; for a WORK task (not tagged `personal` itself or
--         through its project, the app's isPersonalTaskOrProject) a Saturday or
--         Sunday lands on Monday, the same working-day rule as the cascade and
--         the brief's "Tomorrow" (a work task due on a weekend would only show
--         up as overdue on Monday). A due date is set only when there is none or
--         its ET day is before the landing day; it becomes the END of the
--         landing day in ET (23:59:59.999, DST-correct), exactly what the
--         brief's Pick a date writes (src/lib/briefs/due.ts). A later date is
--         kept;
--       - recurring tasks (template or instance, rule 2): pill and comment only,
--         status and date never change (like the cascade);
--       - priority_score: when the status or date changes it is recalculated the
--         way src/lib/priority.ts recalculateTaskPriority does it (fix round 2):
--         base_priority (else the stored score) plus the real boosts on the new
--         status and date, clamped 0-100 (task_unblock_priority). Never by adding
--         to the stored score: that is already clamped. Nothing changed, not
--         touched;
--       - cascade (rule 5): this due-date write does NOT run the date cascade
--         (the cascade is planned by the task API, which isn't involved). Tasks
--         that wait on W keep waiting on it and get this rule when W is done;
--       - one task_status_transitions row (only when the status changed), one
--         source='system' comment naming NO titles (FamCal-safe on any task):
--         "Now unblocked: everything it waited on is done." plus what changed;
--       - tasks.unblocked_at := now(), and the task_unblocks row.
--    b. Leaves Done (rule 6, "reopen"): for each task W with an active link to
--       it (id order, W locked first as above), W's latest not-reverted unblock:
--       - within 7 days of the unblock: compare-and-set Undo, field by field,
--         like the cascade's Undo: the status goes back only while it is still
--         the status the unblock set; the due date only while it still carries
--         the change token (due_change_id) AND the date the unblock wrote (a
--         later save of the same date is another change and is kept); the
--         priority goes back to the stored one when everything was restored and
--         it is unchanged, else it is recalculated on the resulting status and
--         date. One transition row if the status went back, one system comment (no
--         titles). The row is marked reverted (and cleared, reason 'reopened');
--         the pill clears. What was left alone shows "Blocked by dependency"
--         again (the app computes that from the reopened link);
--       - older than 7 days: only the pill clears (reason 'reopened'), nothing
--         else changes and no comment is written;
--       - a closed task (Done, Parked, Missed): no status, due date or priority
--         change and no comment; only the row closes (and a leftover pill);
--       - the pill already cleared and the unblock changed nothing (pill-only):
--         the row is marked reverted, the task is not written, no comment.
--    c. Failure isolation (fix round 2): each waiting task is one sub-transaction
--       (task_unblock_process_waiter inside BEGIN ... EXCEPTION). If it fails
--       (lock_timeout 5s, a deadlock, the API role's statement_timeout, anything)
--       only that task's writes roll back; the Done or reopen still saves, the
--       other waiting tasks still go through, a WARNING is logged (SQLSTATE and
--       ids only) and a task_unblock_retries row records the work (see 7). After
--       one failure the rest of the run waits 100ms per task, not 5s, so one bad
--       run stays inside the 8s statement_timeout.
--
-- 4. task_unblock_pill() (trg_tasks_unblock_pill, BEFORE INSERT/UPDATE on
--    tasks): the pill clears "until I act" (Brent 10/30), on any write that is
--    not one of these functions': status to In Progress ('started'), Done
--    ('finished'), Parked ('parked'), Missed ('missed', closed like Done; only
--    the recurring generator sets it), Blocked/Waiting ('waiting', Brent re-holds
--    it); due_at changed ('redated', any write: the PATCH, MCP, FamCal, the
--    brief's Move/Pick a date); unblocked_at written NULL ('manual'). Backlog <->
--    Planned (Today's sync promoting/demoting) does NOT clear it, nor does any
--    other edit (title, tags, comments...). No time limit.
--
-- 5. task_unblock_on_link() (trg_task_dependencies_unblock_reblock, AFTER INSERT
--    or UPDATE of the link columns on task_dependencies): a new ACTIVE link from
--    a task showing the pill to an item that is not Done clears the pill
--    ('reblocked'). Fix round 2: it first takes FOR SHARE on the TARGET and reads
--    its status from that lock. The foreign key's FOR KEY SHARE doesn't conflict
--    with a status UPDATE, so before this a link and a reopen could each miss the
--    other and leave a false pill: the reopen enumerated its waiters without the
--    uncommitted link, the link read the old Done. Now whichever comes second
--    waits: a link behind a reopen reads the new status and clears the pill; a
--    reopen behind a link (held to commit even when the target is Done) sees the
--    link when its trigger enumerates. Then the waiting task (same protocol as 3).
--    A busy target past lock_timeout fails the link add (55P03: the add route's
--    503), never silently.
--
-- 6. clear_task_unblock(p_user_id, p_task_id, p_reason 'brief' | 'manual'):
--    clears a task's pill without touching anything else, for S3's brief row
--    ("Keep <date>" changes nothing on the task, so nothing else would clear it).
--    Returns { ok, cleared }. SECURITY INVOKER, a signed-in user may pass only
--    their own id, lock_timeout 5s, EXECUTE for authenticated and service_role.
--
-- 7. task_unblock_retries + task_unblock_run_retries(p_user_id, p_limit 10) (fix
--    round 2): the durable record of a waiting task 3c couldn't process, and the
--    idempotent retry. One small table, one function, one call site: the Vercel
--    cron /api/calendar/sync (every 15 minutes, service_role, after the sync,
--    src/lib/task-unblocks.ts runUnblockRetries); no new cron or env var. Each
--    record is one sub-transaction: blocker FOR SHARE, then the waiting task FOR
--    NO KEY UPDATE (the trigger's order), then a fresh read of the current state:
--    - the blocker gone or no longer in the state the event left it in (Done for
--      'unblock', not Done for 'reopen'): closed 'blocker_changed', nothing done;
--    - the task gone: closed 'task_gone';
--    - the link no longer active: closed 'task_changed';
--    - 'unblock' only: an edit that began after the failure changed the task's
--      status or due date: closed 'task_changed', nothing done. updated_at is
--      compared with failed_at because the edit that held the lock began before
--      the failure and must not count; the trigger would have seen it had its
--      wait been shorter. A 'reopen' has no such gate: field-by-field
--      compare-and-set already keeps later edits, and the pill must clear;
--    - 'unblock' only (fix round 3): a task_unblocks row of this task was opened
--      or cleared at or after the failure (COALESCE(cleared_at, unblocked_at) >=
--      failed_at): closed 'task_changed', nothing done. A normal unblock already
--      did this work, and a pill cleared since stays cleared, even when the task's
--      status and date are back where they were (clear_task_unblock, In Progress
--      and back, a new blocker whose link was then removed). The waiter's guards
--      only see OPEN rows, so they can't tell. A row closed before the failure
--      doesn't count: that Done is newer and still lands. Same "after" as the gate
--      above: the stamps are the writer's now(), so a clear that held the lock
--      began before the failure and doesn't count either;
--    - else the same task_unblock_process_waiter as the trigger: closed 'applied',
--      or 'nothing_to_do' when the rules say so today (a closed task, a pill
--      already showing, another open blocker).
--    A retry that fails counts an attempt and stays open. At 8 attempts (about two
--    hours) it gives up: closed_at stays NULL, so it stays visible. S3's count of
--    stuck work is `closed_at IS NULL AND attempts >= 8` (the owner can SELECT;
--    the function also returns it as gave_up). The landing day and unblocked_at
--    are the retry's. Records have no foreign keys (see the table), so a deleted
--    task's record closes on its next run.
--
-- 8. Remove from a signed-in session (fix round 3): 003 gave task_dependencies
--    SELECT, INSERT and DELETE policies but no UPDATE policy, and Remove (both
--    routes) is an UPDATE of is_resolved, so a browser session updated 0 rows and
--    answered 404 while the machine keys' service-role client worked. An owner-only
--    UPDATE policy ("Users can update own task_dependencies", USING and WITH CHECK
--    on auth.uid() = user_id, 003's style) fixes that. DROP POLICY IF EXISTS first,
--    so a same-named policy already on production is replaced, not an error.
--    authenticated already has UPDATE on the table (Supabase's default grants; 067
--    grants nothing here). The 061 loop guard and task_unblock_on_link run on these
--    updates as on any other: a Remove is neither a loop nor a new blocker, and it
--    is not an unblock trigger (see the top): a task whose last open link is
--    removed by hand stays as it is, pill or no pill.
--
-- Lock order: the blocker row (held by the UPDATE that set Done, or FOR SHARE from
-- a link or a retry), then each waiting task in id order. 061's loop guard takes
-- its advisory lock in a BEFORE trigger, before any of these, and takes no row
-- lock itself, so a link waits on the advisory lock holding nothing and a cascade
-- can't wait on it. No project lock is taken (a task UPDATE that changes neither
-- project_id nor user_id locks no project), so 062's protocol (advisory, projects,
-- tasks) can't wait on this, except a cascade that holds both the blocker and the
-- waiting task while the blocker is being finished; Postgres then aborts one of
-- them (40P01), which for this side is caught by 3c and retried.
--
-- The functions: SECURITY INVOKER (RLS applies; the machine keys' service-role
-- client bypasses it, every statement here is scoped by the row's user_id),
-- SET search_path = public, lock_timeout 5s.
--
-- Deploy order: 067 BEFORE the app (the app selects tasks.unblocked_at through
-- `*` and reads task_unblocks for the intelligence layer). Rollback:
-- supabase/rollbacks/067_task_unblocks.down.sql (app first).
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
-- Busy tables (ship script review, 10/30): supabase db push sets no lock timeout,
-- so a session holding a tasks write left this migration waiting as long as that
-- session lived, with every read of tasks queued behind it. So the transaction
-- starts with SET LOCAL lock_timeout = '10s': a table that stays busy makes it fail
-- cleanly (55P03), the whole transaction rolls back, nothing changes, and it can
-- simply be re-run. The setting ends at COMMIT and has no effect on the functions'
-- own SET lock_timeout clauses (5s, 1s), which they apply each time they run.

BEGIN;

-- Fail cleanly on a busy table instead of waiting (see the end of the header).
SET LOCAL lock_timeout = '10s';

-- ── 1. The pill marker ────────────────────────────────────────────────────

-- Nullable, no default: adding it rewrites nothing and changes no row.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS unblocked_at TIMESTAMPTZ;

COMMENT ON COLUMN tasks.unblocked_at IS
  'Now unblocked (067): when the task was unblocked by the last item it waited on becoming Done; NULL when it shows no pill. Written only by 067''s functions (trg_tasks_unblock_pill keeps any other write out); details in task_unblocks.';

-- ── 2. The unblock record ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_unblocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocker_type TEXT NOT NULL CHECK (blocker_type IN ('task', 'commitment')),
  blocker_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  blocker_commitment_id UUID REFERENCES commitments(id) ON DELETE SET NULL,
  waited_on_task_ids UUID[] NOT NULL DEFAULT '{}',
  waited_on_commitment_ids UUID[] NOT NULL DEFAULT '{}',
  unblocked_at TIMESTAMPTZ NOT NULL,
  landing_date DATE NOT NULL,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  prior_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  status_changed BOOLEAN NOT NULL DEFAULT false,
  prior_due_at TIMESTAMPTZ,
  new_due_at TIMESTAMPTZ,
  due_changed BOOLEAN NOT NULL DEFAULT false,
  new_due_change_id UUID,
  prior_priority_score INT,
  new_priority_score INT,
  comment_id UUID REFERENCES task_comments(id) ON DELETE SET NULL,
  cleared_at TIMESTAMPTZ,
  cleared_reason TEXT CHECK (
    cleared_reason IS NULL
    OR cleared_reason IN ('started', 'finished', 'parked', 'missed', 'waiting', 'redated', 'reblocked', 'reopened', 'brief', 'manual')
  ),
  reverted_at TIMESTAMPTZ,
  reverted_by_type TEXT CHECK (reverted_by_type IS NULL OR reverted_by_type IN ('task', 'commitment')),
  reverted_by_id UUID,
  revert_status_restored BOOLEAN,
  revert_due_restored BOOLEAN,
  revert_comment_id UUID REFERENCES task_comments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_unblocks_cleared_has_reason CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL)),
  CONSTRAINT task_unblocks_reverted_is_cleared CHECK (reverted_at IS NULL OR cleared_at IS NOT NULL)
);

-- At most one open (pill showing) row per task.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_unblocks_one_open
  ON task_unblocks(task_id)
  WHERE cleared_at IS NULL;
-- S3: "unblocked since the previous brief" (and the intelligence layer's 72 h window).
CREATE INDEX IF NOT EXISTS idx_task_unblocks_user_unblocked_at
  ON task_unblocks(user_id, unblocked_at DESC);
-- Reopen: a task's latest unblocks.
CREATE INDEX IF NOT EXISTS idx_task_unblocks_task_unblocked_at
  ON task_unblocks(task_id, unblocked_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_unblocks_blocker_task
  ON task_unblocks(blocker_task_id)
  WHERE blocker_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_unblocks_blocker_commitment
  ON task_unblocks(blocker_commitment_id)
  WHERE blocker_commitment_id IS NOT NULL;

COMMENT ON TABLE task_unblocks IS
  'Now unblocked (067): one row per unblock (the last item a task waited on became Done): before/after status, due date and priority, the pill (cleared_at/cleared_reason) and the reopen Undo (reverted_*). Written only by 067''s functions.';

-- Rows are never deleted by callers; they go with their task (ON DELETE CASCADE).
-- REVOKE ALL first: default privileges differ between stacks (a fresh local table
-- gets TRUNCATE, which ignores RLS, for the API roles).
REVOKE ALL ON task_unblocks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON task_unblocks TO authenticated, service_role;
ALTER TABLE task_unblocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own task_unblocks" ON task_unblocks;
CREATE POLICY "Users can view own task_unblocks"
  ON task_unblocks FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Unblock functions write own task_unblocks" ON task_unblocks;
CREATE POLICY "Unblock functions write own task_unblocks"
  ON task_unblocks FOR INSERT
  WITH CHECK (auth.uid() = user_id AND current_setting('mission_control.unblock_writer', true) = 'on');
DROP POLICY IF EXISTS "Unblock functions update own task_unblocks" ON task_unblocks;
CREATE POLICY "Unblock functions update own task_unblocks"
  ON task_unblocks FOR UPDATE
  USING (auth.uid() = user_id AND current_setting('mission_control.unblock_writer', true) = 'on')
  WITH CHECK (auth.uid() = user_id AND current_setting('mission_control.unblock_writer', true) = 'on');

-- ── 2b. Failed waiters, for the retry ─────────────────────────────────────

-- task_id and blocker_id have NO foreign keys on purpose: the failure is usually a
-- lock on the waiting task, and a key check would wait on that same lock.
CREATE TABLE IF NOT EXISTS task_unblock_retries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unblock', 'reopen')),
  task_id UUID NOT NULL,
  blocker_type TEXT NOT NULL CHECK (blocker_type IN ('task', 'commitment')),
  blocker_id UUID NOT NULL,
  task_status TEXT NOT NULL,
  task_due_at TIMESTAMPTZ,
  task_due_change_id UUID,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  error_code TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_reason TEXT CHECK (
    closed_reason IS NULL
    OR closed_reason IN ('applied', 'nothing_to_do', 'task_changed', 'blocker_changed', 'task_gone')
  ),
  CONSTRAINT task_unblock_retries_closed_has_reason CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_task_unblock_retries_open
  ON task_unblock_retries(user_id, failed_at)
  WHERE closed_at IS NULL;

COMMENT ON TABLE task_unblock_retries IS
  'Now unblocked (067): a waiting task the Done or reopen trigger could not process. task_unblock_run_retries works through open rows; a row with closed_at NULL and attempts at the cap gave up and stays as a count.';

-- The trigger runs as the caller, so it inserts as the caller; only the retry
-- (service_role) updates. Nobody deletes.
REVOKE ALL ON task_unblock_retries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON task_unblock_retries TO authenticated;
GRANT SELECT, INSERT, UPDATE ON task_unblock_retries TO service_role;
ALTER TABLE task_unblock_retries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own task_unblock_retries" ON task_unblock_retries;
CREATE POLICY "Users can view own task_unblock_retries"
  ON task_unblock_retries FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Unblock trigger records own task_unblock_retries" ON task_unblock_retries;
CREATE POLICY "Unblock trigger records own task_unblock_retries"
  ON task_unblock_retries FOR INSERT
  WITH CHECK (auth.uid() = user_id AND current_setting('mission_control.unblock_writer', true) = 'on');

-- ── Helpers (pure) ────────────────────────────────────────────────────────

-- The due-proximity boost of src/lib/priority.ts calculateDueProximityBoost
-- (<= 24 h, overdue included: +25; <= 48 h: +15; else or no date: 0).
CREATE OR REPLACE FUNCTION task_unblock_due_boost(p_due_at TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS INT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_due_at IS NULL THEN 0
    WHEN p_due_at - p_now <= INTERVAL '24 hours' THEN 25
    WHEN p_due_at - p_now <= INTERVAL '48 hours' THEN 15
    ELSE 0
  END;
$$;

-- The score of src/lib/priority.ts recalculateTaskPriority: clamp(base + boosts),
-- 0-100. Base: base_priority, else the stored score (the same fallback). Boosts: a
-- high-priority stakeholder mentioned +20 each, capped at 30; an urgency word in
-- the title +25; Blocked/Waiting -20; the due-proximity boost above. STABLE, not
-- pure: it reads the user's stakeholders, like the app does.
CREATE OR REPLACE FUNCTION task_unblock_priority(
  p_user_id UUID,
  p_base INT,
  p_score INT,
  p_title TEXT,
  p_mentions TEXT[],
  p_status TEXT,
  p_due_at TIMESTAMPTZ,
  p_now TIMESTAMPTZ
)
RETURNS INT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT GREATEST(0, LEAST(100,
    COALESCE(p_base, p_score)
    + LEAST(30, 20 * (
        SELECT count(*)::INT
          FROM public.stakeholders s
         WHERE s.user_id = p_user_id
           AND s.is_high_priority
           AND EXISTS (
             SELECT 1 FROM unnest(COALESCE(p_mentions, '{}')) m
              WHERE position(lower(s.name) IN lower(m)) > 0
           )
      ))
    + CASE WHEN EXISTS (
        SELECT 1
          FROM unnest(ARRAY['sla', 'urgent', 'asap', 'outage', 'production issue', 'critical', 'emergency']) k
         WHERE position(k IN lower(COALESCE(p_title, ''))) > 0
      ) THEN 25 ELSE 0 END
    + CASE WHEN p_status = 'Blocked/Waiting' THEN -20 ELSE 0 END
    + task_unblock_due_boost(p_due_at, p_now)
  ));
$$;

-- "Fri 10/30" (the comments' date format).
CREATE OR REPLACE FUNCTION task_unblock_day_label(p_day DATE)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT to_char(p_day, 'Dy FMMM/FMDD');
$$;

-- The landing day (rule 4): the ET day of p_now; for a work task a Saturday or
-- Sunday becomes the next Monday.
CREATE OR REPLACE FUNCTION task_unblock_landing_date(p_now TIMESTAMPTZ, p_is_personal BOOLEAN)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_is_personal THEN (p_now AT TIME ZONE 'America/New_York')::DATE
    WHEN EXTRACT(ISODOW FROM (p_now AT TIME ZONE 'America/New_York')::DATE) = 6 THEN (p_now AT TIME ZONE 'America/New_York')::DATE + 2
    WHEN EXTRACT(ISODOW FROM (p_now AT TIME ZONE 'America/New_York')::DATE) = 7 THEN (p_now AT TIME ZONE 'America/New_York')::DATE + 1
    ELSE (p_now AT TIME ZONE 'America/New_York')::DATE
  END;
$$;

-- The end of an ET day (23:59:59.999, DST-correct), as src/lib/recurrence.ts buildRecurringDueAt.
CREATE OR REPLACE FUNCTION task_unblock_end_of_day(p_day DATE)
RETURNS TIMESTAMPTZ
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT (p_day::TIMESTAMP + INTERVAL '23 hours 59 minutes 59.999 seconds') AT TIME ZONE 'America/New_York';
$$;

-- ── 3. Done in / Done out ─────────────────────────────────────────────────

-- One waiting task, in the caller's sub-transaction. Called by the trigger and by
-- the retry, so both follow the same rules on the same fresh read. The caller
-- holds the blocker's row and has set the writer setting, which no API request
-- can do, so a direct call through PostgREST is refused. The lock wait is the
-- caller's (5s in the trigger, 1s in the retry). Returns 'changed' or 'none'.
CREATE OR REPLACE FUNCTION task_unblock_process_waiter(
  p_type TEXT,
  p_target_id UUID,
  p_user_id UUID,
  p_waiting_id UUID,
  p_entered_done BOOLEAN,
  p_now TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_row task_unblocks%ROWTYPE;
  v_open_blockers INT;
  v_waited_tasks UUID[];
  v_waited_commitments UUID[];
  v_recurring BOOLEAN;
  v_personal BOOLEAN;
  v_landing DATE;
  v_new_status TEXT;
  v_new_due TIMESTAMPTZ;
  v_status_changed BOOLEAN;
  v_due_changed BOOLEAN;
  v_new_priority INT;
  v_new_token UUID;
  v_comment TEXT;
  v_comment_id UUID;
  v_status_back BOOLEAN;
  v_due_back BOOLEAN;
  v_restore_priority INT;
BEGIN
  IF current_setting('mission_control.unblock_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'only the unblock trigger and retry call this' USING ERRCODE = '42501';
  END IF;

  -- Lock the waiting task BEFORE reading its links again (see the header, 3a).
  SELECT * INTO v_task
    FROM public.tasks t
   WHERE t.id = p_waiting_id AND t.user_id = p_user_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF p_entered_done THEN
    -- ── a. Unblock ──
    IF v_task.status::TEXT NOT IN ('Backlog', 'Planned', 'In Progress', 'Blocked/Waiting') THEN
      RETURN 'none';
    END IF;
    IF v_task.unblocked_at IS NOT NULL THEN
      RETURN 'none';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.task_unblocks u WHERE u.task_id = v_task.id AND u.cleared_at IS NULL
    ) THEN
      RETURN 'none';
    END IF;

    -- Every active link must point at a Done item (a fresh read after the lock).
    SELECT count(*) INTO v_open_blockers
      FROM public.task_dependencies d
      LEFT JOIN public.tasks bt ON bt.id = d.depends_on_task_id
      LEFT JOIN public.commitments bc ON bc.id = d.depends_on_commitment_id
     WHERE d.task_id = v_task.id
       AND d.user_id = p_user_id
       AND d.is_resolved = false
       AND COALESCE(bt.status::TEXT, bc.status::TEXT, '') <> 'Done';
    IF v_open_blockers > 0 THEN
      RETURN 'none';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT d.depends_on_task_id) FILTER (WHERE d.depends_on_task_id IS NOT NULL), '{}'),
           COALESCE(array_agg(DISTINCT d.depends_on_commitment_id) FILTER (WHERE d.depends_on_commitment_id IS NOT NULL), '{}')
      INTO v_waited_tasks, v_waited_commitments
      FROM public.task_dependencies d
     WHERE d.task_id = v_task.id AND d.user_id = p_user_id AND d.is_resolved = false;

    v_recurring := COALESCE(v_task.is_recurring_template, false) OR v_task.recurring_template_id IS NOT NULL;
    v_personal := 'personal' = ANY (COALESCE(v_task.tags, '{}'))
      OR EXISTS (
        SELECT 1 FROM public.projects p
         WHERE p.id = v_task.project_id AND p.user_id = p_user_id AND 'personal' = ANY (COALESCE(p.tags, '{}'))
      );
    v_landing := task_unblock_landing_date(p_now, v_personal);

    v_new_status := v_task.status::TEXT;
    v_new_due := v_task.due_at;
    IF NOT v_recurring THEN
      IF v_task.status::TEXT = 'Blocked/Waiting'
         AND (NULLIF(btrim(COALESCE(v_task.waiting_on, '')), '') IS NULL
              OR v_task.blocked_reason::TEXT IS NOT DISTINCT FROM 'prerequisite') THEN
        v_new_status := 'Planned';
      END IF;
      IF v_task.due_at IS NULL
         OR (v_task.due_at AT TIME ZONE 'America/New_York')::DATE < v_landing THEN
        v_new_due := task_unblock_end_of_day(v_landing);
      END IF;
    END IF;
    v_status_changed := v_new_status IS DISTINCT FROM v_task.status::TEXT;
    v_due_changed := v_new_due IS DISTINCT FROM v_task.due_at;

    -- Recalculated from the base and the real boosts, never by adding to the
    -- stored (clamped) score. Nothing changed: the score isn't touched.
    v_new_priority := v_task.priority_score;
    IF v_status_changed OR v_due_changed THEN
      v_new_priority := task_unblock_priority(
        p_user_id, v_task.base_priority, v_task.priority_score, v_task.title,
        v_task.stakeholder_mentions, v_new_status, v_new_due, p_now
      );
    END IF;

    UPDATE public.tasks
       SET status = v_new_status::task_status,
           due_at = v_new_due,
           priority_score = v_new_priority,
           unblocked_at = p_now
     WHERE id = v_task.id
    RETURNING due_change_id INTO v_new_token;

    IF v_status_changed THEN
      INSERT INTO public.task_status_transitions (user_id, task_id, from_status, to_status, transitioned_at)
      VALUES (p_user_id, v_task.id, v_task.status::TEXT, v_new_status, p_now);
    END IF;

    -- No titles, ever (FamCal-safe): only this task's own status and dates.
    v_comment := 'Now unblocked: everything it waited on is done.';
    IF v_status_changed THEN
      v_comment := v_comment || ' Moved from Waiting to Planned.';
    ELSIF v_task.status::TEXT = 'Blocked/Waiting' AND NOT v_recurring THEN
      v_comment := v_comment || ' Still marked Waiting, since it also waits on something else.';
    END IF;
    IF v_due_changed THEN
      IF v_task.due_at IS NULL THEN
        v_comment := v_comment || ' Due date set to ' || task_unblock_day_label(v_landing) || '.';
      ELSE
        v_comment := v_comment || ' Due date moved from '
          || task_unblock_day_label((v_task.due_at AT TIME ZONE 'America/New_York')::DATE)
          || ' to ' || task_unblock_day_label(v_landing) || '.';
      END IF;
    END IF;
    IF v_status_changed OR v_due_changed THEN
      v_comment := v_comment || ' Reopening what it waited on within 7 days puts this back.';
    END IF;

    INSERT INTO public.task_comments (user_id, task_id, content, source)
    VALUES (p_user_id, v_task.id, v_comment, 'system')
    RETURNING id INTO v_comment_id;

    INSERT INTO public.task_unblocks (
      user_id, task_id, blocker_type, blocker_task_id, blocker_commitment_id,
      waited_on_task_ids, waited_on_commitment_ids, unblocked_at, landing_date, is_recurring,
      prior_status, new_status, status_changed, prior_due_at, new_due_at, due_changed,
      new_due_change_id, prior_priority_score, new_priority_score, comment_id
    ) VALUES (
      p_user_id, v_task.id, p_type,
      CASE WHEN p_type = 'task' THEN p_target_id END,
      CASE WHEN p_type = 'commitment' THEN p_target_id END,
      v_waited_tasks, v_waited_commitments, p_now, v_landing, v_recurring,
      v_task.status::TEXT, v_new_status, v_status_changed, v_task.due_at, v_new_due, v_due_changed,
      CASE WHEN v_due_changed THEN v_new_token END, v_task.priority_score, v_new_priority, v_comment_id
    );

  ELSE
    -- ── b. Reopen ──
    -- (Every writer of a task's unblock rows holds the task's row lock, taken above.)
    SELECT * INTO v_row
      FROM public.task_unblocks u
     WHERE u.task_id = v_task.id AND u.user_id = p_user_id AND u.reverted_at IS NULL
     ORDER BY u.unblocked_at DESC, u.created_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN 'none';
    END IF;

    IF v_row.unblocked_at <= p_now - INTERVAL '7 days' THEN
      -- Too old to undo: only the pill goes (it would contradict "Blocked by dependency").
      IF v_row.cleared_at IS NULL THEN
        UPDATE public.task_unblocks SET cleared_at = p_now, cleared_reason = 'reopened' WHERE id = v_row.id;
        UPDATE public.tasks SET unblocked_at = NULL WHERE id = v_task.id AND unblocked_at IS NOT NULL;
        RETURN 'changed';
      END IF;
      RETURN 'none';
    END IF;

    -- A closed task (Done, Parked, Missed) is Brent's: nothing on it changes and
    -- no comment lands on it. Only the bookkeeping closes (the row, and a pill
    -- if one is somehow left, so unblocked_at and the open row stay in step).
    IF v_task.status::TEXT NOT IN ('Backlog', 'Planned', 'In Progress', 'Blocked/Waiting') THEN
      UPDATE public.task_unblocks
         SET reverted_at = p_now, reverted_by_type = p_type, reverted_by_id = p_target_id,
             revert_status_restored = false, revert_due_restored = false,
             cleared_at = COALESCE(cleared_at, p_now),
             cleared_reason = COALESCE(cleared_reason, 'reopened')
       WHERE id = v_row.id;
      UPDATE public.tasks SET unblocked_at = NULL WHERE id = v_task.id AND unblocked_at IS NOT NULL;
      RETURN 'changed';
    END IF;

    -- Pill already gone (Brent acted) and the unblock changed nothing: just
    -- record the revert, no task write and no comment.
    IF v_row.cleared_at IS NOT NULL AND NOT v_row.status_changed AND NOT v_row.due_changed THEN
      UPDATE public.task_unblocks
         SET reverted_at = p_now, reverted_by_type = p_type, reverted_by_id = p_target_id,
             revert_status_restored = false, revert_due_restored = false
       WHERE id = v_row.id;
      RETURN 'changed';
    END IF;

    -- Compare-and-set, field by field (like the cascade's Undo).
    v_status_back := v_row.status_changed AND v_task.status::TEXT = v_row.new_status;
    v_due_back := v_row.due_changed
      AND v_task.due_change_id IS NOT DISTINCT FROM v_row.new_due_change_id
      AND v_task.due_at IS NOT DISTINCT FROM v_row.new_due_at;

    v_restore_priority := v_task.priority_score;
    IF (v_status_back OR v_due_back) THEN
      IF v_status_back = v_row.status_changed AND v_due_back = v_row.due_changed
         AND v_task.priority_score IS NOT DISTINCT FROM v_row.new_priority_score THEN
        v_restore_priority := COALESCE(v_row.prior_priority_score, v_task.priority_score);
      ELSE
        v_restore_priority := task_unblock_priority(
          p_user_id, v_task.base_priority, v_task.priority_score, v_task.title, v_task.stakeholder_mentions,
          CASE WHEN v_status_back THEN v_row.prior_status ELSE v_task.status::TEXT END,
          CASE WHEN v_due_back THEN v_row.prior_due_at ELSE v_task.due_at END,
          p_now
        );
      END IF;
    END IF;

    UPDATE public.tasks
       SET status = CASE WHEN v_status_back THEN v_row.prior_status::task_status ELSE status END,
           due_at = CASE WHEN v_due_back THEN v_row.prior_due_at ELSE due_at END,
           priority_score = v_restore_priority,
           unblocked_at = NULL
     WHERE id = v_task.id;

    IF v_status_back THEN
      INSERT INTO public.task_status_transitions (user_id, task_id, from_status, to_status, transitioned_at)
      VALUES (p_user_id, v_task.id, v_row.new_status, v_row.prior_status, p_now);
    END IF;

    v_comment := CASE WHEN v_row.cleared_at IS NULL
      THEN 'Something it waited on was reopened, so it is no longer marked Now unblocked.'
      ELSE 'Something it waited on was reopened.' END;
    IF v_status_back THEN
      v_comment := v_comment || ' Back to Waiting.';
    END IF;
    IF v_due_back THEN
      IF v_row.prior_due_at IS NULL THEN
        v_comment := v_comment || ' Due date cleared again.';
      ELSE
        v_comment := v_comment || ' Due date back to '
          || task_unblock_day_label((v_row.prior_due_at AT TIME ZONE 'America/New_York')::DATE) || '.';
      END IF;
    END IF;
    IF (v_row.status_changed AND NOT v_status_back) OR (v_row.due_changed AND NOT v_due_back) THEN
      v_comment := v_comment || ' Its status or due date changed since, so that was left as it is.';
    END IF;

    INSERT INTO public.task_comments (user_id, task_id, content, source)
    VALUES (p_user_id, v_task.id, v_comment, 'system')
    RETURNING id INTO v_comment_id;

    UPDATE public.task_unblocks
       SET reverted_at = p_now,
           reverted_by_type = p_type,
           reverted_by_id = p_target_id,
           revert_status_restored = v_status_back,
           revert_due_restored = v_due_back,
           revert_comment_id = v_comment_id,
           cleared_at = COALESCE(cleared_at, p_now),
           cleared_reason = COALESCE(cleared_reason, 'reopened')
     WHERE id = v_row.id;
  END IF;

  RETURN 'changed';
END;
$$;

CREATE OR REPLACE FUNCTION task_unblock_on_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_type TEXT := CASE WHEN TG_TABLE_NAME = 'commitments' THEN 'commitment' ELSE 'task' END;
  v_user_id UUID := NEW.user_id;
  v_target_id UUID := NEW.id;
  v_entered_done BOOLEAN := NEW.status::TEXT = 'Done' AND OLD.status::TEXT IS DISTINCT FROM 'Done';
  v_left_done BOOLEAN := OLD.status::TEXT = 'Done' AND NEW.status::TEXT IS DISTINCT FROM 'Done';
  v_now TIMESTAMPTZ := now();
  v_prev_writer TEXT;
  v_waiting_id UUID;
  v_code TEXT;
BEGIN
  IF NOT v_entered_done AND NOT v_left_done THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_prev_writer := current_setting('mission_control.unblock_writer', true);
    PERFORM set_config('mission_control.unblock_writer', 'on', true);

    FOR v_waiting_id IN
      SELECT DISTINCT d.task_id
        FROM public.task_dependencies d
       WHERE d.user_id = v_user_id
         AND d.is_resolved = false
         AND (
           (v_type = 'task' AND d.depends_on_task_id = v_target_id)
           OR (v_type = 'commitment' AND d.depends_on_commitment_id = v_target_id)
         )
       ORDER BY d.task_id
    LOOP
      -- Each waiting task in its own sub-transaction (header, 3c). QUERY_CANCELED
      -- is named because OTHERS doesn't include it: the API role's 8s
      -- statement_timeout must not undo the Done either.
      BEGIN
        PERFORM task_unblock_process_waiter(v_type, v_target_id, v_user_id, v_waiting_id, v_entered_done, v_now);
      EXCEPTION WHEN query_canceled OR others THEN
        v_code := SQLSTATE;
        RAISE WARNING 'task_unblock_on_status_change: % on % %, waiting task % queued for retry', v_code, v_type, v_target_id, v_waiting_id;
        -- The rest of this run doesn't wait: the Done has already spent its wait.
        PERFORM set_config('lock_timeout', '100ms', true);
        BEGIN
          -- A plain read (it never waits) of what the task looked like; no foreign
          -- key, because a key check would wait on the very lock that failed.
          INSERT INTO public.task_unblock_retries (
            user_id, kind, task_id, blocker_type, blocker_id,
            task_status, task_due_at, task_due_change_id, error_code
          )
          SELECT v_user_id, CASE WHEN v_entered_done THEN 'unblock' ELSE 'reopen' END, t.id, v_type, v_target_id,
                 t.status::TEXT, t.due_at, t.due_change_id, v_code
            FROM public.tasks t
           WHERE t.id = v_waiting_id AND t.user_id = v_user_id;
        EXCEPTION WHEN query_canceled OR others THEN
          RAISE WARNING 'task_unblock_on_status_change: % recording the retry for waiting task %', SQLSTATE, v_waiting_id;
        END;
      END;
    END LOOP;

    PERFORM set_config('mission_control.unblock_writer', COALESCE(v_prev_writer, ''), true);
  EXCEPTION WHEN query_canceled OR others THEN
    -- Only reading the links can land here; the Done itself still saves.
    RAISE WARNING 'task_unblock_on_status_change: % on % %, skipped', SQLSTATE, v_type, v_target_id;
  END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_unblock_dependents ON tasks;
CREATE TRIGGER trg_tasks_unblock_dependents
  AFTER UPDATE OF status ON tasks
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'Done' OR NEW.status = 'Done'))
  EXECUTE FUNCTION task_unblock_on_status_change();

DROP TRIGGER IF EXISTS trg_commitments_unblock_dependents ON commitments;
CREATE TRIGGER trg_commitments_unblock_dependents
  AFTER UPDATE OF status ON commitments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'Done' OR NEW.status = 'Done'))
  EXECUTE FUNCTION task_unblock_on_status_change();

-- ── 4. The pill clears "until I act" ──────────────────────────────────────

CREATE OR REPLACE FUNCTION task_unblock_pill()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_reason TEXT;
  v_prev_writer TEXT;
BEGIN
  IF current_setting('mission_control.unblock_writer', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A new (or copied) task is never "now unblocked".
    NEW.unblocked_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.unblocked_at IS NULL THEN
    -- Only the unblock sets it.
    NEW.unblocked_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.unblocked_at IS NULL THEN
    v_reason := 'manual';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::TEXT = 'In Progress' THEN
    v_reason := 'started';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::TEXT = 'Done' THEN
    v_reason := 'finished';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::TEXT = 'Parked' THEN
    v_reason := 'parked';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::TEXT = 'Missed' THEN
    v_reason := 'missed';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::TEXT = 'Blocked/Waiting' THEN
    v_reason := 'waiting';
  ELSIF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    v_reason := 'redated';
  ELSE
    -- Any other write keeps the pill (and can't move its time).
    NEW.unblocked_at := OLD.unblocked_at;
    RETURN NEW;
  END IF;

  NEW.unblocked_at := NULL;
  v_prev_writer := current_setting('mission_control.unblock_writer', true);
  PERFORM set_config('mission_control.unblock_writer', 'on', true);
  UPDATE public.task_unblocks
     SET cleared_at = now(), cleared_reason = v_reason
   WHERE task_id = NEW.id AND user_id = NEW.user_id AND cleared_at IS NULL;
  PERFORM set_config('mission_control.unblock_writer', COALESCE(v_prev_writer, ''), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_unblock_pill ON tasks;
CREATE TRIGGER trg_tasks_unblock_pill
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  WHEN (OLD.unblocked_at IS NOT NULL OR NEW.unblocked_at IS NOT NULL)
  EXECUTE FUNCTION task_unblock_pill();

DROP TRIGGER IF EXISTS trg_tasks_unblock_pill_insert ON tasks;
CREATE TRIGGER trg_tasks_unblock_pill_insert
  BEFORE INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.unblocked_at IS NOT NULL)
  EXECUTE FUNCTION task_unblock_pill();

-- ── 5. A new blocker clears the pill ──────────────────────────────────────

CREATE OR REPLACE FUNCTION task_unblock_on_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_target_done BOOLEAN;
  v_prev_writer TEXT;
BEGIN
  IF NEW.is_resolved THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NOT OLD.is_resolved
     AND OLD.task_id = NEW.task_id
     AND OLD.depends_on_task_id IS NOT DISTINCT FROM NEW.depends_on_task_id
     AND OLD.depends_on_commitment_id IS NOT DISTINCT FROM NEW.depends_on_commitment_id THEN
    RETURN NULL;
  END IF;

  -- FOR SHARE, kept to commit, conflicts with a status UPDATE of the target (the
  -- foreign key's FOR KEY SHARE doesn't), so a link and a reopen can't miss each
  -- other. The locking read returns the newest committed status (header, 5).
  IF NEW.depends_on_task_id IS NOT NULL THEN
    SELECT t.status::TEXT = 'Done' INTO v_target_done FROM public.tasks t WHERE t.id = NEW.depends_on_task_id FOR SHARE;
  ELSE
    SELECT c.status::TEXT = 'Done' INTO v_target_done FROM public.commitments c WHERE c.id = NEW.depends_on_commitment_id FOR SHARE;
  END IF;
  IF COALESCE(v_target_done, false) THEN
    RETURN NULL;
  END IF;

  -- Then the waiting task (header, 3a), then its pill.
  PERFORM 1 FROM public.tasks t WHERE t.id = NEW.task_id AND t.user_id = NEW.user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_prev_writer := current_setting('mission_control.unblock_writer', true);
  PERFORM set_config('mission_control.unblock_writer', 'on', true);
  UPDATE public.task_unblocks
     SET cleared_at = now(), cleared_reason = 'reblocked'
   WHERE task_id = NEW.task_id AND user_id = NEW.user_id AND cleared_at IS NULL;
  UPDATE public.tasks
     SET unblocked_at = NULL
   WHERE id = NEW.task_id AND user_id = NEW.user_id AND unblocked_at IS NOT NULL;
  PERFORM set_config('mission_control.unblock_writer', COALESCE(v_prev_writer, ''), true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_dependencies_unblock_reblock ON task_dependencies;
CREATE TRIGGER trg_task_dependencies_unblock_reblock
  AFTER INSERT OR UPDATE OF is_resolved, task_id, depends_on_task_id, depends_on_commitment_id ON task_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION task_unblock_on_link();

-- ── 6. Clear from a brief row (S3) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION clear_task_unblock(
  p_user_id UUID,
  p_task_id UUID,
  p_reason TEXT DEFAULT 'brief'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cleared INT;
  v_prev_writer TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'task belongs to another user' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('brief', 'manual') THEN
    RAISE EXCEPTION 'p_reason must be brief or manual' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.tasks t WHERE t.id = p_task_id AND t.user_id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_prev_writer := current_setting('mission_control.unblock_writer', true);
  PERFORM set_config('mission_control.unblock_writer', 'on', true);
  UPDATE public.task_unblocks
     SET cleared_at = now(), cleared_reason = p_reason
   WHERE task_id = p_task_id AND user_id = p_user_id AND cleared_at IS NULL;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;
  UPDATE public.tasks
     SET unblocked_at = NULL
   WHERE id = p_task_id AND user_id = p_user_id AND unblocked_at IS NOT NULL;
  PERFORM set_config('mission_control.unblock_writer', COALESCE(v_prev_writer, ''), true);

  RETURN jsonb_build_object('ok', true, 'cleared', v_cleared > 0);
END;
$$;

-- ── 7. The retry ──────────────────────────────────────────────────────────

-- Works through the oldest open records (header, 7). Each record is one
-- sub-transaction: a failure counts an attempt and moves on. The cron must not
-- hang on a busy task, so the lock wait is 1s and a run takes at most p_limit
-- records. SKIP LOCKED: two runs at once take different records.
CREATE OR REPLACE FUNCTION task_unblock_run_retries(
  p_user_id UUID,
  p_limit INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
SET lock_timeout = '1s'
AS $$
DECLARE
  c_max_attempts CONSTANT INT := 8;
  v_ids UUID[];
  v_id UUID;
  v_rec task_unblock_retries%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_blocker TEXT;
  v_reason TEXT;
  v_prev_writer TEXT;
  v_now TIMESTAMPTZ := now();
  v_applied INT := 0;
  v_skipped INT := 0;
  v_failed INT := 0;
  v_gave_up INT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(s.id ORDER BY s.failed_at, s.id), '{}') INTO v_ids
    FROM (
      SELECT r.id, r.failed_at
        FROM public.task_unblock_retries r
       WHERE r.user_id = p_user_id AND r.closed_at IS NULL AND r.attempts < c_max_attempts
       ORDER BY r.failed_at, r.id
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
         FOR UPDATE SKIP LOCKED
    ) s;

  v_prev_writer := current_setting('mission_control.unblock_writer', true);
  PERFORM set_config('mission_control.unblock_writer', 'on', true);

  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_rec FROM public.task_unblock_retries r WHERE r.id = v_id;
    BEGIN
      -- The same order as the trigger: the blocker, then the waiting task. FOR
      -- SHARE holds off a status change of the blocker until this commits.
      IF v_rec.blocker_type = 'task' THEN
        SELECT b.status::TEXT INTO v_blocker
          FROM public.tasks b WHERE b.id = v_rec.blocker_id AND b.user_id = p_user_id FOR SHARE;
      ELSE
        SELECT b.status::TEXT INTO v_blocker
          FROM public.commitments b WHERE b.id = v_rec.blocker_id AND b.user_id = p_user_id FOR SHARE;
      END IF;

      IF v_blocker IS NULL OR (v_rec.kind = 'unblock') <> (v_blocker = 'Done') THEN
        v_reason := 'blocker_changed';
      ELSE
        SELECT * INTO v_task
          FROM public.tasks t WHERE t.id = v_rec.task_id AND t.user_id = p_user_id FOR NO KEY UPDATE;
        IF NOT FOUND THEN
          v_reason := 'task_gone';
        ELSIF NOT EXISTS (
          SELECT 1 FROM public.task_dependencies d
           WHERE d.task_id = v_rec.task_id
             AND d.user_id = p_user_id
             AND d.is_resolved = false
             AND ((v_rec.blocker_type = 'task' AND d.depends_on_task_id = v_rec.blocker_id)
               OR (v_rec.blocker_type = 'commitment' AND d.depends_on_commitment_id = v_rec.blocker_id))
        ) THEN
          v_reason := 'task_changed';
        -- A reopen is compare-and-set field by field and must always clear the
        -- pill, so only an unblock is refused on a later edit. "Later" = an edit
        -- that began after the failure: the one that held the lock began before
        -- it, and the trigger would have seen that edit had the wait been shorter.
        ELSIF v_rec.kind = 'unblock'
          AND v_task.updated_at > v_rec.failed_at
          AND (v_task.status::TEXT IS DISTINCT FROM v_rec.task_status
            OR v_task.due_at IS DISTINCT FROM v_rec.task_due_at
            OR v_task.due_change_id IS DISTINCT FROM v_rec.task_due_change_id) THEN
          v_reason := 'task_changed';
        -- A pill put on or cleared since the failure: a normal unblock did this
        -- work, and a clear stands (header, 7). The waiter only sees open rows.
        ELSIF v_rec.kind = 'unblock' AND EXISTS (
          SELECT 1 FROM public.task_unblocks u
           WHERE u.task_id = v_rec.task_id
             AND u.user_id = p_user_id
             AND COALESCE(u.cleared_at, u.unblocked_at) >= v_rec.failed_at
        ) THEN
          v_reason := 'task_changed';
        ELSIF task_unblock_process_waiter(
          v_rec.blocker_type, v_rec.blocker_id, p_user_id, v_rec.task_id, v_rec.kind = 'unblock', v_now
        ) = 'changed' THEN
          v_reason := 'applied';
        ELSE
          v_reason := 'nothing_to_do';
        END IF;
      END IF;

      UPDATE public.task_unblock_retries
         SET attempts = attempts + 1, last_attempt_at = clock_timestamp(),
             closed_at = clock_timestamp(), closed_reason = v_reason
       WHERE id = v_id;
      IF v_reason = 'applied' THEN
        v_applied := v_applied + 1;
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION WHEN query_canceled OR others THEN
      UPDATE public.task_unblock_retries
         SET attempts = attempts + 1, last_attempt_at = clock_timestamp(), error_code = SQLSTATE
       WHERE id = v_id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  PERFORM set_config('mission_control.unblock_writer', COALESCE(v_prev_writer, ''), true);

  SELECT count(*) INTO v_gave_up
    FROM public.task_unblock_retries r
   WHERE r.user_id = p_user_id AND r.closed_at IS NULL AND r.attempts >= c_max_attempts;

  RETURN jsonb_build_object(
    'ok', true, 'applied', v_applied, 'skipped', v_skipped, 'failed', v_failed, 'gave_up', v_gave_up
  );
END;
$$;

-- ── 8. Remove from a signed-in session ─────────────────────────────────────

DROP POLICY IF EXISTS "Users can update own task_dependencies" ON task_dependencies;
CREATE POLICY "Users can update own task_dependencies"
  ON task_dependencies FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger functions run for whoever writes the row; the helpers they call must
-- stay executable by those roles. The waiter function refuses a call without the
-- writer setting. The RPCs are restricted.
REVOKE ALL ON FUNCTION task_unblock_process_waiter(TEXT, UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION task_unblock_process_waiter(TEXT, UUID, UUID, UUID, BOOLEAN, TIMESTAMPTZ) TO authenticated, service_role;
REVOKE ALL ON FUNCTION clear_task_unblock(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_task_unblock(UUID, UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION task_unblock_run_retries(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION task_unblock_run_retries(UUID, INT) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
