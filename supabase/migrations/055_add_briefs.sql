-- Stored brief pages: one row per brief (content as data) and one row per
-- actionable item, keyed by a stable item_key so states survive reruns.
-- Accepting a proposed_task creates a task whose external source identity is
-- ('eod_proposal', item_key); the migration 054 unique index makes that
-- idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  edition TEXT NOT NULL CHECK (edition ~ '^[a-z][a-z0-9_]{1,31}$'),
  brief_date DATE NOT NULL,
  code TEXT NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9]{1,15}-[0-9]{4}([0-9]{4})?$'),
  content JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content) = 'object'),
  covered_meeting_ids TEXT[] NOT NULL DEFAULT '{}',
  -- The one "brief ready" notice (Telegram). notified_at is the claim (set by
  -- the first save only, so reruns never notify twice); notify_sent_at is set
  -- only once delivery succeeded; notify_error says why it didn't.
  notified_at TIMESTAMPTZ,
  notify_sent_at TIMESTAMPTZ,
  notify_error TEXT CHECK (char_length(notify_error) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT briefs_user_edition_date_key UNIQUE (user_id, edition, brief_date),
  CONSTRAINT briefs_user_code_key UNIQUE (user_id, code),
  -- Target for brief_items' composite FK, so an item can never point at
  -- another user's brief.
  CONSTRAINT briefs_id_user_key UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS brief_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_id UUID NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  item_key TEXT NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('proposed_task', 'carry_over', 'carry_group', 'choice')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  task_ids UUID[] NOT NULL DEFAULT '{}',
  source JSONB NOT NULL DEFAULT '{"meetings": []}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (
    state IN ('open', 'accepted', 'dismissed', 'done', 'deferred', 'parked', 'decided', 'expired')
  ),
  dismissed_reason TEXT CHECK (dismissed_reason IN ('already_tracked', 'not_mine', 'not_worth_it')),
  dismissed_note TEXT CHECK (char_length(dismissed_note) <= 500),
  choice TEXT CHECK (char_length(choice) BETWEEN 1 AND 64),
  created_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT brief_items_brief_user_fkey
    FOREIGN KEY (brief_id, user_id) REFERENCES briefs(id, user_id) ON DELETE CASCADE,
  CONSTRAINT brief_items_brief_n_key UNIQUE (brief_id, n),
  CONSTRAINT brief_items_user_item_key_key UNIQUE (user_id, item_key),
  CONSTRAINT brief_items_dismiss_needs_reason CHECK (
    state <> 'dismissed'
    OR dismissed_reason IS NOT NULL
    OR NULLIF(BTRIM(dismissed_note), '') IS NOT NULL
  ),
  CONSTRAINT brief_items_decided_needs_choice CHECK (state <> 'decided' OR choice IS NOT NULL),
  -- A created task only ever belongs to an accepted item: a dismissed (or any
  -- other) item can never end up pointing at a real task.
  CONSTRAINT brief_items_task_only_when_accepted CHECK (created_task_id IS NULL OR state = 'accepted')
);

CREATE INDEX IF NOT EXISTS idx_briefs_user_date ON briefs(user_id, brief_date DESC);
CREATE INDEX IF NOT EXISTS idx_brief_items_brief ON brief_items(brief_id, n);
CREATE INDEX IF NOT EXISTS idx_brief_items_user_state ON brief_items(user_id, state);

-- Every task an item references (task_ids, created_task_id) must belong to the
-- item's owner. Enforced here as well as in the service, because the service
-- runs with the service-role client on API-key and MCP paths.
CREATE OR REPLACE FUNCTION brief_items_check_task_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  foreign_count INTEGER;
BEGIN
  SELECT count(*) INTO foreign_count
  FROM (
    SELECT DISTINCT referenced.task_id
    FROM unnest(NEW.task_ids || CASE WHEN NEW.created_task_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[NEW.created_task_id] END)
      AS referenced(task_id)
  ) ids
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks t WHERE t.id = ids.task_id AND t.user_id = NEW.user_id
  );

  IF foreign_count > 0 THEN
    RAISE EXCEPTION 'brief item references % task(s) not owned by the user', foreign_count
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_brief_items_task_ownership ON brief_items;
CREATE TRIGGER trg_brief_items_task_ownership
  BEFORE INSERT OR UPDATE OF task_ids, created_task_id, user_id ON brief_items
  FOR EACH ROW EXECUTE FUNCTION brief_items_check_task_ownership();

-- The one way an item changes state. Locks the row, and applies the change
-- only if the item is still in the state the caller validated against (a
-- compare-and-set); otherwise returns the current state as a conflict and
-- changes nothing. Every side effect commits in the same transaction as the
-- state, or not at all:
--   - Accept (p_task) creates its task (idempotent on the 054 index), so a
--     racing Dismiss can never leave a dismissed item beside a real task.
--   - Done/Tomorrow/Park (p_task_updates) write every one of the item's tasks;
--     any failure rolls back the claim too, so no caller can ever observe a
--     carry item in its new state before its tasks are durably updated.
-- SECURITY INVOKER: RLS applies to user clients; service-role callers are
-- scoped by p_user_id.
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

    INSERT INTO tasks (
      user_id, title, description, status, task_type, base_priority, priority_score,
      estimated_minutes, estimate_source, needs_review, blocker, stakeholder_mentions,
      tags, source_type, source_url, external_source_system, external_source_id
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
      v_item.item_key
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

DROP TRIGGER IF EXISTS trg_briefs_updated ON briefs;
CREATE TRIGGER trg_briefs_updated
  BEFORE UPDATE ON briefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_brief_items_updated ON brief_items;
CREATE TRIGGER trg_brief_items_updated
  BEFORE UPDATE ON brief_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Explicit, because newer Supabase projects no longer auto-grant new public
-- tables to the API roles. RLS below still scopes every row to its owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON briefs, brief_items TO authenticated, service_role;

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE brief_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own briefs"
  ON briefs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own briefs"
  ON briefs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own briefs"
  ON briefs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own briefs"
  ON briefs FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own brief_items"
  ON brief_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own brief_items"
  ON brief_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own brief_items"
  ON brief_items FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own brief_items"
  ON brief_items FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
