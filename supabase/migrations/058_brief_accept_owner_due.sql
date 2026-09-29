-- Accept on a brief proposal now hands the task to Brent with a due date.
--
-- brief_item_transition (055) inserted the accepted task with the column
-- defaults, so since 056 it landed as owner 'agent' with no due date and never
-- showed in Brent's "Assigned to you". This replaces the function with the
-- same signature, locking, compare-and-set, security settings and grants; the
-- only change is the task INSERT:
--   - owner = 'brent' (Brent accepted it, so it's his to act on);
--   - due_at from the optional p_task->>'due_at'. Absent or JSON null = no due
--     date. Anything else must be an ISO 8601 timestamp with an explicit
--     offset, e.g. 2026-09-30T03:59:59.999Z; special values ('now',
--     'infinity', ...), non-strings and impossible dates are refused with
--     22023 and the whole call, the item's claim included, rolls back.
-- An Accept that finds its task already there (ON CONFLICT) still changes
-- nothing on that task, so a repeat Accept never moves a due date.
-- Existing rows are untouched. Idempotent (CREATE OR REPLACE); rollback in
-- supabase/rollbacks/058_brief_accept_owner_due.down.sql restores 055's body.

BEGIN;

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
