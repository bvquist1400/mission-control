-- Craft S1C: "Set up craft screen" for any project, and "Remove from craft screen".
-- Additive: three functions, no table or column changes. Also takes away the table
-- rights the API roles never use on the nine craft tables (follow-up 3afd802e).
--
-- craft_setup_project writes a plan the app computed from a fresh read. Under the
-- project, section, task and checklist locks it rebuilds the fingerprint of the rows
-- the plan was made from and refuses (MC072) when anything changed, so nothing can
-- move between the check and the writes. Lock order: project FOR SHARE, its sections
-- FOR SHARE, its tasks FOR NO KEY UPDATE in id order (059's work_sessions_lock_tasks),
-- then their checklist rows FOR NO KEY UPDATE in id order (059's session writes take
-- tasks before rows too).
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Must build exactly the text of craftSetupFingerprintText() in src/lib/craft/setup-fingerprint.ts.
CREATE FUNCTION craft_setup_fingerprint(p_user_id UUID, p_project_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH t AS (
    SELECT id, section_id, created_at, is_sample, title FROM tasks
    WHERE project_id = p_project_id AND user_id = p_user_id
  )
  SELECT encode(sha256(convert_to(concat_ws(E'\n',
    'craft-setup-v1|' || p_project_id::text,
    COALESCE((SELECT string_agg(format('s|%s|%s|%s', s.id, s.sort_order, floor(extract(epoch FROM s.created_at) * 1000)::bigint), E'\n' ORDER BY s.id)
      FROM project_sections s WHERE s.project_id = p_project_id AND s.user_id = p_user_id), ''),
    COALESCE((SELECT string_agg(format('t|%s|%s|%s|%s|%s', t.id, COALESCE(t.section_id::text, ''), floor(extract(epoch FROM t.created_at) * 1000)::bigint,
        CASE WHEN t.is_sample THEN 1 ELSE 0 END, encode(sha256(convert_to(t.title, 'UTF8')), 'hex')), E'\n' ORDER BY t.id) FROM t), ''),
    COALESCE((SELECT string_agg(format('i|%s|%s|%s|%s|%s|%s|%s', i.id, i.task_id, i.sort_order, CASE WHEN i.is_done THEN 1 ELSE 0 END,
        COALESCE(trim_scale(i.unit_count)::text, ''), COALESCE(i.craft_part_id::text, ''), encode(sha256(convert_to(i.text, 'UTF8')), 'hex')), E'\n' ORDER BY i.id)
      FROM task_checklist_items i WHERE i.user_id = p_user_id AND i.task_id IN (SELECT id FROM t)), '')
  ), 'UTF8')), 'hex');
$$;

-- Locks for both writers. Returns false when the project is not the caller's.
CREATE FUNCTION craft_setup_lock(p_user_id UUID, p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM project_sections WHERE project_id = p_project_id AND user_id = p_user_id ORDER BY id FOR SHARE;
  PERFORM work_sessions_lock_tasks(p_user_id,
    (SELECT COALESCE(array_agg(id), '{}'::uuid[]) FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id));
  PERFORM 1 FROM task_checklist_items
    WHERE user_id = p_user_id AND task_id IN (SELECT id FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id)
    ORDER BY id FOR NO KEY UPDATE;
  RETURN true;
END;
$$;

-- p_plan: { craft, active_part_index, parts: [{ name, row_word, total_rows, stitch_count, sort_order,
--   segments: [{ task_id, name, from_row, to_row, sort_order }], rows: [{ item_id, row }] }] }
CREATE FUNCTION craft_setup_project(p_user_id UUID, p_project_id UUID, p_plan JSONB, p_fingerprint TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_part JSONB;
  v_seg JSONB;
  v_part_id UUID;
  v_part_ids UUID[] := '{}';
  v_count INTEGER;
  v_rows INTEGER := 0;
  v_segments INTEGER := 0;
  v_active INTEGER;
  v_name TEXT;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'project id and fingerprint are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_plan) k WHERE k NOT IN ('craft', 'active_part_index', 'parts'))
     OR p_plan->>'craft' IS NULL OR p_plan->>'craft' NOT IN ('knit', 'crochet', 'other')
     OR jsonb_typeof(p_plan->'parts') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_plan->'parts') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'craft setup plan is not valid' USING ERRCODE = '22023';
  END IF;
  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_EXISTS: this project is already on the craft screen' USING ERRCODE = '23505';
  END IF;
  IF craft_setup_fingerprint(p_user_id, p_project_id) IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed since the preview' USING ERRCODE = 'MC072';
  END IF;

  INSERT INTO craft_projects (project_id, user_id, craft) VALUES (p_project_id, p_user_id, p_plan->>'craft');

  FOR v_part IN SELECT value FROM jsonb_array_elements(p_plan->'parts') LOOP
    v_name := btrim(v_part->>'name');
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_part) k WHERE k NOT IN ('name', 'row_word', 'total_rows', 'stitch_count', 'sort_order', 'segments', 'rows'))
       OR v_name IS NULL OR v_name = '' OR char_length(v_name) > 80
       OR v_part->>'row_word' IS NULL OR v_part->>'row_word' NOT IN ('row', 'round')
       OR jsonb_typeof(v_part->'total_rows') IS DISTINCT FROM 'number' OR (v_part->>'total_rows')::numeric NOT BETWEEN 1 AND 2000
       OR (v_part->'stitch_count' IS NOT NULL AND jsonb_typeof(v_part->'stitch_count') NOT IN ('number', 'null'))
       OR jsonb_typeof(v_part->'segments') IS DISTINCT FROM 'array' OR jsonb_array_length(v_part->'segments') < 1
       OR jsonb_typeof(v_part->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(v_part->'rows') < 1 THEN
      RAISE EXCEPTION 'craft setup part is not valid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO craft_parts (user_id, project_id, name, sort_order, total_rows, row_word, stitch_count)
    VALUES (p_user_id, p_project_id, v_name, COALESCE((v_part->>'sort_order')::int, cardinality(v_part_ids)),
      (v_part->>'total_rows')::int, v_part->>'row_word', NULLIF(v_part->>'stitch_count', '')::int)
    RETURNING id INTO v_part_id;
    v_part_ids := v_part_ids || v_part_id;

    FOR v_seg IN SELECT value FROM jsonb_array_elements(v_part->'segments') LOOP
      IF NOT EXISTS (SELECT 1 FROM tasks WHERE id = (v_seg->>'task_id')::uuid AND project_id = p_project_id AND user_id = p_user_id)
         OR (v_seg->>'from_row')::int < 1 OR (v_seg->>'to_row')::int > (v_part->>'total_rows')::int THEN
        RAISE EXCEPTION 'craft setup segment is not valid' USING ERRCODE = '22023';
      END IF;
      INSERT INTO craft_segments (user_id, part_id, task_id, name, from_row, to_row, sort_order)
      VALUES (p_user_id, v_part_id, (v_seg->>'task_id')::uuid, btrim(v_seg->>'name'), (v_seg->>'from_row')::int,
        (v_seg->>'to_row')::int, COALESCE((v_seg->>'sort_order')::int, v_segments));
      v_segments := v_segments + 1;
    END LOOP;

    -- Every row is an unlinked item on one of this part's segment tasks, inside that segment's range,
    -- whose text starts with that number ("Rnd 15 (est.) · knit" is round 15).
    WITH r AS (
      SELECT (x->>'item_id')::uuid AS item_id, (x->>'row')::int AS row_number FROM jsonb_array_elements(v_part->'rows') x
    )
    UPDATE task_checklist_items i SET craft_part_id = v_part_id, craft_row = r.row_number
    FROM r
    WHERE i.id = r.item_id AND i.user_id = p_user_id AND i.craft_part_id IS NULL
      AND r.row_number BETWEEN 1 AND (v_part->>'total_rows')::int
      AND ltrim(substring(i.text FROM '^(?:Row|Rnd|Round)\s+(\d+)'), '0') = r.row_number::text
      AND EXISTS (SELECT 1 FROM craft_segments s WHERE s.part_id = v_part_id AND s.task_id = i.task_id
                  AND r.row_number BETWEEN s.from_row AND s.to_row);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> jsonb_array_length(v_part->'rows') THEN
      RAISE EXCEPTION 'craft setup rows are not valid' USING ERRCODE = '22023';
    END IF;
    v_rows := v_rows + v_count;
  END LOOP;

  IF p_plan->'active_part_index' IS NOT NULL AND jsonb_typeof(p_plan->'active_part_index') <> 'null' THEN
    v_active := (p_plan->>'active_part_index')::int;
    IF v_active < 0 OR v_active >= cardinality(v_part_ids) THEN
      RAISE EXCEPTION 'craft setup active part is not valid' USING ERRCODE = '22023';
    END IF;
    UPDATE craft_projects SET active_part_id = v_part_ids[v_active + 1] WHERE project_id = p_project_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('project_id', p_project_id, 'parts', cardinality(v_part_ids), 'segments', v_segments,
    'rows_linked', v_rows, 'active_part_id', CASE WHEN v_active IS NULL THEN NULL ELSE v_part_ids[v_active + 1] END);
END;
$$;

-- Unlinks the project's rows first (both columns, nothing else on the row), then removes
-- the craft rows that hang off the project. Ticks, units, sittings and minutes stay;
-- sitting details stay with their part cleared (SET NULL).
CREATE FUNCTION craft_remove_project(p_user_id UUID, p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_items INTEGER;
  v_parts INTEGER;
  v_segments INTEGER;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'project id is required' USING ERRCODE = '22023';
  END IF;
  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRAFT_NOT_ON_SCREEN' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*) INTO v_segments FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id
    WHERE p.project_id = p_project_id AND p.user_id = p_user_id;

  UPDATE task_checklist_items SET craft_part_id = NULL, craft_row = NULL
    WHERE user_id = p_user_id AND craft_part_id IN (SELECT id FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id);
  GET DIAGNOSTICS v_items = ROW_COUNT;

  DELETE FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id;
  DELETE FROM craft_timers WHERE project_id = p_project_id AND user_id = p_user_id;
  DELETE FROM craft_links WHERE project_id = p_project_id AND user_id = p_user_id;
  DELETE FROM craft_notes WHERE project_id = p_project_id AND user_id = p_user_id;
  DELETE FROM craft_yarns WHERE project_id = p_project_id AND user_id = p_user_id;
  DELETE FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_parts = ROW_COUNT;

  RETURN jsonb_build_object('project_id', p_project_id, 'items_unlinked', v_items, 'parts_removed', v_parts, 'segments_removed', v_segments);
END;
$$;

REVOKE ALL ON FUNCTION craft_setup_fingerprint(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_setup_lock(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_setup_project(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_remove_project(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_setup_fingerprint(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_setup_lock(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_setup_project(UUID, UUID, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_remove_project(UUID, UUID) TO authenticated, service_role;

-- Follow-up 3afd802e: the API roles keep SELECT, INSERT, UPDATE, DELETE only.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON craft_projects, craft_parts, craft_segments, craft_timers, craft_sitting_details,
  craft_notes, craft_links, craft_instructions, craft_yarns FROM authenticated, service_role;
-- MAINTAIN exists from Postgres 17; on an older server there is nothing to take away.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON craft_projects, craft_parts, craft_segments, craft_timers, craft_sitting_details, '
      'craft_notes, craft_links, craft_instructions, craft_yarns FROM authenticated, service_role';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';
