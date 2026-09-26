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
  -- The one "brief ready" notice (Telegram): when it was attempted and, if it
  -- failed, why. Set by the first save only, so reruns never notify twice.
  notified_at TIMESTAMPTZ,
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
  CONSTRAINT brief_items_decided_needs_choice CHECK (state <> 'decided' OR choice IS NOT NULL)
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
