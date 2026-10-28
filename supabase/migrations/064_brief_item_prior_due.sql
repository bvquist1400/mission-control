-- 064: pick-a-date on brief cards (Baseline task 57224ad9) -- exact Undo for a
-- deferral.
--
-- Tomorrow (and the new "Move to a picked date") rewrites each carry task's
-- due_at. Undo has to put back what was there, including "no due date", so the
-- previous dates are saved by the same transaction that moves them:
--   - brief_items.prior_due (new, nullable JSONB array): one entry per task,
--     { id, due_at (the date before the move, null = none), applied_due_at (the
--     date the move set) }. Written by brief_item_transition when a deferral
--     applies; cleared when the item reopens. Items deferred before this
--     migration have none, so they get no Undo (the page and the API say so).
--   - brief_item_transition (same signature, locking, compare-and-set, security
--     settings and grants as 058): on any task update that sets due_at it reads
--     the task's current date under FOR NO KEY UPDATE (the lock the UPDATE takes
--     anyway) and saves it. An update may carry expect_due_at (Undo sends the
--     applied date); if the task's date is anything else the call is refused with
--     SQLSTATE MC064 and everything rolls back, so Undo never overwrites a date
--     someone set after the move.
-- Unchanged: Accept's task insert (058), Done/Park, every other transition. No
-- cascade is involved: the brief's write path has never run the date cascade.
-- Parked items get no Undo (a park changes status, which Undo would have to
-- reverse with its transition side effects; out of scope).
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE). Rollback:
-- supabase/rollbacks/064_brief_item_prior_due.down.sql.

BEGIN;

ALTER TABLE brief_items
  ADD COLUMN IF NOT EXISTS prior_due JSONB;

ALTER TABLE brief_items
  DROP CONSTRAINT IF EXISTS brief_items_prior_due_is_array;
ALTER TABLE brief_items
  ADD CONSTRAINT brief_items_prior_due_is_array
  CHECK (prior_due IS NULL OR jsonb_typeof(prior_due) = 'array');

COMMENT ON COLUMN brief_items.prior_due IS
  'Deferral snapshot (064): [{id, due_at, applied_due_at}] per task, written by brief_item_transition; Undo restores due_at.';

CREATE OR REPLACE FUNCTION brief_item_transition(
  p_user_id UUID,
  p_item_id UUID,
  p_expected_state TEXT,
  p_state TEXT,
  p_fields JSONB DEFAULT '{}'::jsonb,
  p_task JSONB DEFAULT NULL,
  p_task_updates JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item brief_items%ROWTYPE;
  v_task_id UUID;
  v_inserted BOOLEAN := false;
  v_update JSONB;
  v_update_id UUID;
  v_updated UUID[] := '{}';
  v_due_at TIMESTAMPTZ;
  v_old_due TIMESTAMPTZ;
  v_snapshot JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'brief item belongs to another user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_item
  FROM brief_items
  WHERE id = p_item_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_item.state <> p_expected_state THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'conflict',
      'state', v_item.state,
      'created_task_id', v_item.created_task_id,
      'choice', v_item.choice
    );
  END IF;

  IF p_task IS NOT NULL THEN
    IF v_item.kind <> 'proposed_task' OR p_state <> 'accepted' THEN
      RAISE EXCEPTION 'only accepting a proposed_task creates a task' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_task->'due_at') IS NOT NULL AND jsonb_typeof(p_task->'due_at') <> 'null' THEN
      IF jsonb_typeof(p_task->'due_at') <> 'string'
        OR (p_task->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' THEN
        RAISE EXCEPTION 'p_task.due_at must be an ISO 8601 timestamp with an offset' USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_due_at := (p_task->>'due_at')::timestamptz;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR invalid_time_zone_displacement_value THEN
        RAISE EXCEPTION 'p_task.due_at must be a valid timestamp' USING ERRCODE = '22023';
      END;
    END IF;

    INSERT INTO tasks (
      user_id, title, description, status, task_type, base_priority, priority_score,
      estimated_minutes, estimate_source, needs_review, blocker, stakeholder_mentions,
      tags, source_type, source_url, external_source_system, external_source_id,
      owner, due_at
    )
    VALUES (
      p_user_id,
      p_task->>'title',
      p_task->>'description',
      'Backlog',
      'Task',
      COALESCE(ROUND((p_task->>'base_priority')::numeric)::int, 50),
      COALESCE(ROUND((p_task->>'priority_score')::numeric)::int, 50),
      30,
      'default',
      false,
      false,
      '{}',
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_task->'tags', '[]'::jsonb))),
      COALESCE(p_task->>'source_type', 'Meeting'),
      p_task->>'source_url',
      'eod_proposal',
      v_item.item_key,
      'brent',
      v_due_at
    )
    ON CONFLICT (user_id, external_source_system, external_source_id)
      WHERE external_source_id IS NOT NULL
      DO NOTHING
    RETURNING id INTO v_task_id;

    IF v_task_id IS NULL THEN
      SELECT id INTO v_task_id
      FROM tasks
      WHERE user_id = p_user_id
        AND external_source_system = 'eod_proposal'
        AND external_source_id = v_item.item_key;
    ELSE
      v_inserted := true;
    END IF;
  END IF;

  IF p_task_updates IS NOT NULL THEN
    IF v_item.kind NOT IN ('carry_over', 'carry_group') THEN
      RAISE EXCEPTION 'only carry items update tasks' USING ERRCODE = '22023';
    END IF;

    FOR v_update IN SELECT * FROM jsonb_array_elements(p_task_updates) LOOP
      v_update_id := (v_update->>'id')::uuid;
      IF NOT (v_update_id = ANY (v_item.task_ids)) THEN
        RAISE EXCEPTION 'task % is not part of this item', v_update_id USING ERRCODE = '22023';
      END IF;

      -- A due-date write (Tomorrow, Move, or Undo) first reads the date it is about
      -- to replace, under the row lock the UPDATE below would take anyway.
      --   - the old date goes into the snapshot saved with the item (below), so
      --     Undo can put it back exactly, including "no due date";
      --   - an update carrying expect_due_at (Undo) is refused, and the whole call
      --     rolls back, if the task's date is no longer the one the move set.
      IF (v_update ? 'due_at') THEN
        SELECT due_at INTO v_old_due
        FROM tasks
        WHERE id = v_update_id AND user_id = p_user_id
        FOR NO KEY UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'task % no longer exists', v_update_id USING ERRCODE = 'P0002';
        END IF;

        IF (v_update ? 'expect_due_at')
          AND v_old_due IS DISTINCT FROM (v_update->>'expect_due_at')::timestamptz THEN
          RAISE EXCEPTION 'task % has a different due date than the move set; refusing to overwrite it', v_update_id
            USING ERRCODE = 'MC064';
        END IF;

        v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
          'id', v_update_id,
          'due_at', v_old_due,
          'applied_due_at', (v_update->>'due_at')::timestamptz
        ));
      END IF;

      UPDATE tasks SET
        status = CASE WHEN v_update ? 'status' THEN (v_update->>'status')::task_status ELSE status END,
        due_at = CASE WHEN v_update ? 'due_at' THEN (v_update->>'due_at')::timestamptz ELSE due_at END,
        priority_score = CASE
          WHEN v_update ? 'priority_score' THEN ROUND((v_update->>'priority_score')::numeric)::int
          ELSE priority_score
        END
      WHERE id = v_update_id AND user_id = p_user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'task % no longer exists', v_update_id USING ERRCODE = 'P0002';
      END IF;
      v_updated := array_append(v_updated, v_update_id);
    END LOOP;

    -- All of the item's tasks, or none: a partial list is a caller bug.
    IF EXISTS (SELECT 1 FROM unnest(v_item.task_ids) AS t(id) WHERE NOT (t.id = ANY (v_updated))) THEN
      RAISE EXCEPTION 'every task of the item must be updated together' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE brief_items SET
    state = p_state,
    acted_at = CASE WHEN p_fields ? 'acted_at' THEN (p_fields->>'acted_at')::timestamptz ELSE acted_at END,
    dismissed_reason = CASE WHEN p_fields ? 'dismissed_reason' THEN p_fields->>'dismissed_reason' ELSE dismissed_reason END,
    dismissed_note = CASE WHEN p_fields ? 'dismissed_note' THEN p_fields->>'dismissed_note' ELSE dismissed_note END,
    choice = CASE WHEN p_fields ? 'choice' THEN p_fields->>'choice' ELSE choice END,
    -- Saved with the move itself (same transaction); cleared when the item reopens.
    prior_due = CASE
      WHEN p_state = 'open' THEN NULL
      WHEN p_state = 'deferred' AND jsonb_array_length(v_snapshot) > 0 THEN v_snapshot
      ELSE prior_due
    END,
    created_task_id = COALESCE(v_task_id, created_task_id)
  WHERE id = p_item_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'state', p_state,
    'created_task_id', COALESCE(v_task_id, v_item.created_task_id),
    'task_inserted', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION brief_item_transition(UUID, UUID, TEXT, TEXT, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brief_item_transition(UUID, UUID, TEXT, TEXT, JSONB, JSONB, JSONB) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
