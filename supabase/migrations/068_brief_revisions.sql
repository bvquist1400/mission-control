-- 068: brief refresh (Baseline task e8f1449d, plan baseline-plans/brief-refresh).
--
-- A brief can now be rebuilt in place when something arrives after it was
-- built (the work digest filed at 8:06 for a 7:57 brief, a late meeting):
-- save_brief / save_eod_brief with mode "refresh". Its items are never touched
-- (numbers, states, choices, created tasks, payloads stay byte for byte), new
-- items are appended, and the content is rewritten. So that the old and new can
-- be compared and the rewrite undone, the content a refresh replaces is kept:
--
--   - brief_revisions (new): one row per refresh, with the brief's content and
--     covered_meeting_ids exactly as they were before it, `saved_at` (when that
--     content had last been saved: the brief's updated_at), `replaced_at` (when
--     the refresh replaced it) and the refresh's one-line `reason`. Owner rows
--     only (the usual four policies). Deleting a brief deletes its revisions.
--   - brief_refresh_content(...): the one write path. Under a row lock on the
--     brief it inserts the revision from the row as locked (so two refreshes at
--     once each keep the content they replaced, and none is lost), then writes
--     the new content with the server's own fields merged in from the locked
--     row: work_digest_note_ids is the union (what the brief had first, at most
--     4, as the app caps it), refreshes gets the new entry appended (the last 20
--     kept; every refresh stays in brief_revisions), covered_meeting_ids is the
--     union. notified_at / notify_* are never touched: a refresh never notifies.
--
-- No change to briefs, brief_items or brief_item_transition. SECURITY INVOKER:
-- RLS applies to user clients; service-role callers are scoped by p_user_id.
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- Rollback: supabase/rollbacks/068_brief_revisions.down.sql (app first: this
-- app calls the function on every refresh).

BEGIN;

CREATE TABLE IF NOT EXISTS brief_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_id UUID NOT NULL,
  -- The brief's content and coverage as they were before this refresh.
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  covered_meeting_ids TEXT[] NOT NULL DEFAULT '{}',
  -- The refresh's one-line reason ("AM digest added"); null when none was given.
  reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  -- When the replaced content had last been saved (the brief's updated_at then).
  saved_at TIMESTAMPTZ NOT NULL,
  -- When the refresh replaced it.
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT brief_revisions_brief_user_fkey
    FOREIGN KEY (brief_id, user_id) REFERENCES briefs(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_brief_revisions_brief ON brief_revisions(brief_id, replaced_at DESC);

CREATE OR REPLACE FUNCTION brief_refresh_content(
  p_user_id UUID,
  p_brief_id UUID,
  p_content JSONB,
  p_covered_meeting_ids TEXT[],
  p_refresh JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_brief briefs%ROWTYPE;
  v_revision_id UUID;
  v_reason TEXT;
  v_notes JSONB;
  v_refreshes JSONB;
  v_covered TEXT[];
  v_content JSONB;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'brief belongs to another user' USING ERRCODE = '42501';
  END IF;
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' THEN
    RAISE EXCEPTION 'p_content must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_refresh IS NULL OR jsonb_typeof(p_refresh) <> 'object' OR jsonb_typeof(p_refresh->'at') <> 'string' THEN
    RAISE EXCEPTION 'p_refresh must be an object with "at"' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_brief
  FROM briefs
  WHERE id = p_brief_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_reason := NULLIF(BTRIM(p_refresh->>'reason'), '');

  INSERT INTO brief_revisions (user_id, brief_id, content, covered_meeting_ids, reason, saved_at, replaced_at)
  VALUES (p_user_id, p_brief_id, v_brief.content, v_brief.covered_meeting_ids, v_reason, v_brief.updated_at, now())
  RETURNING id INTO v_revision_id;

  -- Notes read: what the brief had first, then the new ones, no repeats, at most 4.
  SELECT COALESCE(jsonb_agg(note ORDER BY first_seen), '[]'::jsonb) INTO v_notes
  FROM (
    SELECT note, min(seen) AS first_seen
    FROM (
      SELECT value AS note, ordinality AS seen
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_brief.content->'work_digest_note_ids') = 'array' THEN v_brief.content->'work_digest_note_ids' ELSE '[]'::jsonb END
      ) WITH ORDINALITY
      UNION ALL
      SELECT value, 1000 + ordinality
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_content->'work_digest_note_ids') = 'array' THEN p_content->'work_digest_note_ids' ELSE '[]'::jsonb END
      ) WITH ORDINALITY
    ) both_lists
    WHERE jsonb_typeof(note) = 'string'
    GROUP BY note
    ORDER BY first_seen
    LIMIT 4
  ) kept;

  -- Refresh records: the brief's, plus this one; the last 20 (all of them are rows above).
  SELECT COALESCE(jsonb_agg(entry ORDER BY seen), '[]'::jsonb) INTO v_refreshes
  FROM (
    SELECT entry, seen
    FROM (
      SELECT value AS entry, ordinality AS seen
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_brief.content->'refreshes') = 'array' THEN v_brief.content->'refreshes' ELSE '[]'::jsonb END
      ) WITH ORDINALITY
      UNION ALL
      SELECT jsonb_strip_nulls(jsonb_build_object('at', p_refresh->'at', 'reason', to_jsonb(v_reason))), 1000000
    ) all_entries
    ORDER BY seen DESC
    LIMIT 20
  ) last_ones;

  SELECT COALESCE(array_agg(id ORDER BY first_seen), '{}') INTO v_covered
  FROM (
    SELECT id, min(seen) AS first_seen
    FROM (
      SELECT id, ordinality AS seen FROM unnest(v_brief.covered_meeting_ids) WITH ORDINALITY AS old_ids(id, ordinality)
      UNION ALL
      SELECT id, 1000000 + ordinality FROM unnest(COALESCE(p_covered_meeting_ids, '{}')) WITH ORDINALITY AS new_ids(id, ordinality)
    ) both_lists
    WHERE id IS NOT NULL
    GROUP BY id
  ) kept;

  v_content := (p_content - 'refreshes' - 'work_digest_note_ids') || jsonb_build_object('refreshes', v_refreshes);
  IF jsonb_array_length(v_notes) > 0 THEN
    v_content := v_content || jsonb_build_object('work_digest_note_ids', v_notes);
  END IF;

  UPDATE briefs
  SET content = v_content,
      covered_meeting_ids = v_covered
  WHERE id = p_brief_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'revision_id', v_revision_id,
    'content', v_content,
    'covered_meeting_ids', to_jsonb(v_covered)
  );
END;
$$;

REVOKE ALL ON FUNCTION brief_refresh_content(UUID, UUID, JSONB, TEXT[], JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION brief_refresh_content(UUID, UUID, JSONB, TEXT[], JSONB) TO authenticated, service_role;

-- Explicit, because newer Supabase projects no longer auto-grant new public
-- tables to the API roles. RLS below still scopes every row to its owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON brief_revisions TO authenticated, service_role;

ALTER TABLE brief_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own brief_revisions" ON brief_revisions;
CREATE POLICY "Users can view own brief_revisions"
  ON brief_revisions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own brief_revisions" ON brief_revisions;
CREATE POLICY "Users can insert own brief_revisions"
  ON brief_revisions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own brief_revisions" ON brief_revisions;
CREATE POLICY "Users can update own brief_revisions"
  ON brief_revisions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own brief_revisions" ON brief_revisions;
CREATE POLICY "Users can delete own brief_revisions"
  ON brief_revisions FOR DELETE
  USING (auth.uid() = user_id);

COMMIT;
