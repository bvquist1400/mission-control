-- 060: atomic comment insert for the FamCal key (Baseline task 87c256c0, S0 fix round 2).
--
-- The FamCal machine key (MISSION_CONTROL_FAMCAL_API_KEY, src/lib/famcal-api-key.ts)
-- may comment only on tasks that carry the `personal` tag themselves. Checking the
-- tag in one request and inserting in another leaves a window where the tag can be
-- removed in between, and a cleanup DELETE after the fact can fail or be seen
-- by readers. This function does the check and the insert in ONE transaction:
--
--   1. lock the task row FOR SHARE: a concurrent UPDATE of the task (e.g. removing
--      `personal`) waits until this transaction ends; if such an UPDATE committed
--      first, the locking read re-checks the WHERE against the new row version;
--   2. require the caller's user id and the exact lowercase `personal` tag under
--      that lock (no row: missing, someone else's or not personal -> returns no
--      rows, the API answers 404, nothing is written);
--   3. insert the comment and return it.
--
-- A SQL error inside the function rolls the whole call back, so that kind of 500
-- leaves no comment behind. (If the reply is lost after the function committed,
-- the caller sees an error although the comment exists; a retry then adds a
-- second one. There is no idempotency token yet.) SECURITY INVOKER: the service-role caller (the machine key)
-- is scoped by p_user_id; a signed-in user may only pass their own id (and RLS
-- applies to them as usual).
--
-- No table, column or policy changes. Rollback: supabase/rollbacks/060_famcal_personal_task_comment.down.sql.

CREATE OR REPLACE FUNCTION famcal_add_personal_task_comment(
  p_user_id UUID,
  p_task_id UUID,
  p_content TEXT,
  p_source TEXT DEFAULT 'manual'
)
RETURNS SETOF task_comments
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_content TEXT := btrim(COALESCE(p_content, ''));
  v_task_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_task_id IS NULL THEN
    RAISE EXCEPTION 'user id and task id are required' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'cannot comment as another user' USING ERRCODE = '42501';
  END IF;
  IF v_content = '' OR char_length(v_content) > 5000 THEN
    RAISE EXCEPTION 'content must be 1 to 5000 characters' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('manual', 'system', 'llm') THEN
    RAISE EXCEPTION 'source must be manual, system or llm' USING ERRCODE = '22023';
  END IF;

  SELECT t.id
    INTO v_task_id
    FROM tasks t
   WHERE t.id = p_task_id
     AND t.user_id = p_user_id
     AND t.tags @> ARRAY['personal']::TEXT[]
     FOR SHARE;

  IF v_task_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    INSERT INTO task_comments (task_id, user_id, content, source)
    VALUES (v_task_id, p_user_id, v_content, p_source)
    RETURNING *;
END;
$$;

COMMENT ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) IS
  'FamCal key comment POST: locks the task, requires user + personal tag, inserts, all in one transaction (060).';

-- Only the API's service role calls it (the FamCal key runs on the admin client).
REVOKE ALL ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
