-- 060: FamCal key eligibility + atomic comment insert (Baseline task 87c256c0, S0 fix rounds 2 and 4).
--
-- The FamCal machine key (MISSION_CONTROL_FAMCAL_API_KEY, src/lib/famcal-api-key.ts)
-- reaches only "personal to-dos". Brent, 10/16: "Leave it out of the brief": a task
-- filed under anything that isn't clearly personal is not handed to FamCal at all.
--
-- famcal_eligible(tasks) is the one definition, used by every FamCal read and write
-- (PostgREST computed field `famcal_eligible`, and the comment function below).
-- A task is eligible only when ALL of these hold:
--   * its own tags contain the exact lowercase `personal`;
--   * it has no sprint (sprints carry no tags, so none is clearly personal);
--   * EITHER it has no project, no application and no section (a standalone to-do),
--     OR its project belongs to the same user and that project's own tags contain
--     `personal` (its application and section then come from that personal project).
-- Anything else (a work project, or no project but an application) is ineligible and
-- looks exactly like "not found" to the FamCal key.
--
-- famcal_add_personal_task_comment does the eligibility check and the insert in ONE
-- transaction:
--   1. lock the task row FOR SHARE, but only a row that is already eligible in the
--      statement's snapshot (famcal_eligible(t) is in the locking read's WHERE): an
--      ineligible task is skipped without ever waiting on its row lock, so a busy
--      work task answers exactly like a missing id (404, at once). For an eligible
--      task a concurrent UPDATE (e.g. removing `personal` or moving it to another
--      project) waits; one that committed first is re-checked by the locking read;
--   2. if the task is in a project, lock that project row FOR SHARE too and require
--      the user and `personal` on it (a concurrent project re-tag waits the same way);
--   3. insert the comment and return it. No row at step 1 or 2 -> no rows returned,
--      the API answers 404, nothing is written.
-- A SQL error inside the function rolls the whole call back, so that kind of 500
-- leaves no comment behind. (If the reply is lost after the function committed, the
-- caller sees an error although the comment exists; a retry then adds a second one.
-- There is no idempotency token yet.) Waits are bounded: lock_timeout is 5s inside
-- the function; a timeout (55P03) can only happen on an eligible task and the API
-- answers 503 "busy, try again".
--
-- SECURITY INVOKER: the service-role caller (the machine key) is scoped by p_user_id;
-- a signed-in user may only pass their own id (and RLS applies as usual). Only
-- service_role may execute either function.
--
-- No table, column or policy changes. Rollback: supabase/rollbacks/060_famcal_personal_task_comment.down.sql.

CREATE OR REPLACE FUNCTION famcal_eligible(t tasks)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[]
     AND t.sprint_id IS NULL
     AND (
       (t.project_id IS NULL AND t.implementation_id IS NULL AND t.section_id IS NULL)
       OR EXISTS (
         SELECT 1
           FROM public.projects p
          WHERE p.id = t.project_id
            AND p.user_id = t.user_id
            AND COALESCE(p.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[]
       )
     );
$$;

COMMENT ON FUNCTION famcal_eligible(tasks) IS
  'FamCal key eligibility (060): personal tag, no sprint, and standalone or in a personal project. Computed field for PostgREST.';

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
SET lock_timeout = '5s'
AS $$
DECLARE
  v_content TEXT := btrim(COALESCE(p_content, ''));
  v_task public.tasks%ROWTYPE;
  v_project_id UUID;
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

  -- 1. The task, locked: own tag, no sprint, standalone or in a project, and
  --    eligible (project included) BEFORE any lock is taken, so an ineligible row
  --    is never waited on.
  SELECT t.*
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
     AND t.user_id = p_user_id
     AND COALESCE(t.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[]
     AND t.sprint_id IS NULL
     AND (t.project_id IS NOT NULL OR (t.implementation_id IS NULL AND t.section_id IS NULL))
     AND public.famcal_eligible(t)
     FOR SHARE OF t;

  IF v_task.id IS NULL THEN
    RETURN;
  END IF;

  -- 2. Its project, locked: same user and tagged personal.
  IF v_task.project_id IS NOT NULL THEN
    SELECT p.id
      INTO v_project_id
      FROM public.projects p
     WHERE p.id = v_task.project_id
       AND p.user_id = p_user_id
       AND COALESCE(p.tags, '{}'::TEXT[]) @> ARRAY['personal']::TEXT[]
       FOR SHARE;

    IF v_project_id IS NULL THEN
      RETURN;
    END IF;
  END IF;

  -- 3. Insert.
  RETURN QUERY
    INSERT INTO public.task_comments (task_id, user_id, content, source)
    VALUES (v_task.id, p_user_id, v_content, p_source)
    RETURNING *;
END;
$$;

COMMENT ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) IS
  'FamCal key comment POST: locks the task (and its project), requires FamCal eligibility, inserts, all in one transaction (060).';

-- Only the API's service role calls them (the FamCal key runs on the admin client).
REVOKE ALL ON FUNCTION famcal_eligible(tasks) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION famcal_eligible(tasks) TO service_role;
REVOKE ALL ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION famcal_add_personal_task_comment(UUID, UUID, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
