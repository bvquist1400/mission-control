-- Removes only 073: its eight functions and craft_timers.paused_at, and puts back 072's
-- craft_setup_plan, craft_setup_project and craft_remove_blockers exactly as 072 wrote them
-- (CREATE OR REPLACE keeps their 072 grants). Roll the app back first: the S2 screen calls
-- the 073 functions. Sittings, ticks, notes and sitting details written by S2 stay; a
-- running or paused timer stays, without its pause time.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION craft_set_total(UUID, UUID, INTEGER, INTEGER);
DROP FUNCTION craft_log_sitting(UUID, UUID, BOOLEAN, INTEGER, INTEGER, DATE, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT);
DROP FUNCTION craft_timer(UUID, TEXT, UUID, UUID, INTEGER, INTEGER, BOOLEAN);
DROP FUNCTION craft_timer_state(UUID, TIMESTAMPTZ);
DROP FUNCTION craft_rows(UUID, UUID, INTEGER, INTEGER, TEXT, UUID);
DROP FUNCTION craft_band_check(UUID, UUID);
DROP FUNCTION craft_part_lock(UUID, UUID);
DROP FUNCTION craft_current_row(UUID, UUID, INTEGER);
DROP FUNCTION craft_timer_elapsed(INTEGER, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION craft_setup_plan(p_user_id UUID, p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  -- JavaScript's \s (and String.prototype.trim), written out so both sides use one class.
  c_ws CONSTANT TEXT := '[\t\n\v\f\r    -     　﻿]';
  c_label CONSTANT TEXT := '^((Row|Rnd|Round)[ \t]+([0-9]+))(?![0-9A-Za-z_])';
  v_range TEXT;
  t RECORD;
  v_stops TEXT[] := '{}';
  v_parts JSONB := '[]';
  v_cur JSONB;
  v_section UUID;
  v_units NUMERIC[];
  v_nulls BOOLEAN;
  v_undone BOOLEAN;
  v_active INTEGER;
  v_word TEXT;
  v_unit NUMERIC;
BEGIN
  v_range := '^(?:' || c_ws || '*(?:[-‐‑‒–—―−~/&,+]|(?:to|through|thru|and)(?![0-9A-Za-z_]))' || c_ws || '*[0-9]|\.[0-9])';
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN v_stops := v_stops || 'on_craft_screen'::text; END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND i.craft_part_id IS NOT NULL) THEN
    v_stops := v_stops || 'linked'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
               CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND NOT k.is_sample AND r.m IS NOT NULL
               AND ((r.m)[3]::numeric = 0 OR (r.m)[3]::numeric > 1000000 OR substr(i.text, char_length((r.m)[1]) + 1) ~* v_range)) THEN
    v_stops := v_stops || 'bad_number'::text;
  END IF;

  FOR t IN
    WITH sec AS (
      SELECT id, row_number() OVER (ORDER BY sort_order, created_at NULLS FIRST, id) AS rank
      FROM project_sections WHERE project_id = p_project_id AND user_id = p_user_id
    ), tk AS (
      SELECT k.id, k.section_id, s.rank, floor(extract(epoch FROM k.created_at) * 1000) AS ms
      FROM tasks k LEFT JOIN sec s ON s.id = k.section_id
      WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample
    ), it AS (
      SELECT i.task_id, i.id, i.is_done, i.unit_count, (r.m)[2] AS word, (r.m)[3]::numeric AS num
      FROM task_checklist_items i CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
      WHERE i.user_id = p_user_id AND i.task_id IN (SELECT id FROM tk) AND r.m IS NOT NULL
        AND (r.m)[3]::numeric BETWEEN 1 AND 1000000 AND substr(i.text, char_length((r.m)[1]) + 1) !~* v_range
    )
    SELECT tk.id, tk.section_id, count(DISTINCT (it.word = 'Row')) AS words, bool_and(it.word = 'Row') AS is_row,
      min(it.num) AS lo, max(it.num) AS hi, count(*) AS n, count(DISTINCT it.num) AS n_distinct,
      bool_or(NOT it.is_done) AS undone, array_agg(it.unit_count ORDER BY it.num, it.id) AS units,
      jsonb_agg(jsonb_build_object('item_id', it.id, 'row', it.num) ORDER BY it.num, it.id) AS rows
    FROM tk JOIN it ON it.task_id = tk.id
    GROUP BY tk.id, tk.section_id, tk.rank, tk.ms
    ORDER BY tk.rank IS NULL, tk.rank, tk.ms, tk.id
  LOOP
    IF t.words > 1 THEN v_stops := v_stops || 'mixed_words'::text; CONTINUE; END IF;
    IF t.n <> t.n_distinct THEN v_stops := v_stops || 'repeat'::text; END IF;
    v_word := CASE WHEN t.is_row THEN 'row' ELSE 'round' END;
    IF v_cur IS NOT NULL AND v_section IS NOT DISTINCT FROM t.section_id AND v_cur->>'row_word' = v_word
       AND t.lo = (v_cur->>'total_rows')::numeric + 1 THEN
      v_cur := jsonb_set(jsonb_set(jsonb_set(v_cur,
        '{segments}', (v_cur->'segments') || jsonb_build_object('task_id', t.id, 'from_row', t.lo, 'to_row', t.hi)),
        '{rows}', (v_cur->'rows') || t.rows),
        '{total_rows}', to_jsonb(GREATEST((v_cur->>'total_rows')::numeric, t.hi)));
      v_units := v_units || t.units;
      v_undone := v_undone OR t.undone;
    ELSE
      IF v_cur IS NOT NULL THEN
        v_nulls := array_position(v_units, NULL) IS NOT NULL;
        SELECT CASE WHEN count(DISTINCT u) = 1 THEN min(u) END INTO v_unit FROM unnest(v_units) u;
        v_parts := v_parts || jsonb_set(v_cur, '{stitch_count}', CASE WHEN NOT v_nulls AND v_unit IS NOT NULL AND v_unit > 0 AND v_unit <= 2147483647
          AND v_unit = trunc(v_unit) THEN to_jsonb(v_unit::int) ELSE 'null'::jsonb END);
        IF v_undone AND v_active IS NULL THEN v_active := jsonb_array_length(v_parts) - 1; END IF;
      END IF;
      v_cur := jsonb_build_object('row_word', v_word, 'total_rows', t.hi, 'stitch_count', NULL,
        'segments', jsonb_build_array(jsonb_build_object('task_id', t.id, 'from_row', t.lo, 'to_row', t.hi)), 'rows', t.rows);
      v_section := t.section_id;
      v_units := t.units;
      v_undone := t.undone;
    END IF;
  END LOOP;
  IF v_cur IS NOT NULL THEN
    v_nulls := array_position(v_units, NULL) IS NOT NULL;
    SELECT CASE WHEN count(DISTINCT u) = 1 THEN min(u) END INTO v_unit FROM unnest(v_units) u;
    v_parts := v_parts || jsonb_set(v_cur, '{stitch_count}', CASE WHEN NOT v_nulls AND v_unit IS NOT NULL AND v_unit > 0 AND v_unit <= 2147483647
      AND v_unit = trunc(v_unit) THEN to_jsonb(v_unit::int) ELSE 'null'::jsonb END);
    IF v_undone AND v_active IS NULL THEN v_active := jsonb_array_length(v_parts) - 1; END IF;
  END IF;
  IF jsonb_array_length(v_parts) = 0 THEN v_stops := v_stops || 'no_rows'::text; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_parts) p WHERE (p->>'total_rows')::numeric > 2000) THEN v_stops := v_stops || 'too_many_rows'::text; END IF;
  RETURN jsonb_build_object('stops', to_jsonb(v_stops), 'active_part_index', to_jsonb(v_active), 'parts', v_parts);
END;
$$;

CREATE OR REPLACE FUNCTION craft_setup_project(p_user_id UUID, p_project_id UUID, p_plan JSONB, p_fingerprint TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_trim CONSTANT TEXT := E'\t\n\x0b\f\r                  　﻿';
  c_label CONSTANT TEXT := '^(Row|Rnd|Round)[ \t]+[0-9]+(?![0-9A-Za-z_])';
  v_part JSONB;
  v_names TEXT[] := '{}';
  v_name TEXT;
  v_plan JSONB;
  v_given JSONB;
  v_tasks UUID[];
  v_part_id UUID;
  v_part_ids UUID[] := '{}';
  v_index INTEGER := 0;
  v_count INTEGER;
  v_rows INTEGER := 0;
  v_segments INTEGER := 0;
  v_active INTEGER;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_project_id IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'project id and fingerprint are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_plan) k WHERE k NOT IN ('craft', 'active_part_index', 'parts'))
     OR jsonb_typeof(p_plan->'craft') IS DISTINCT FROM 'string' OR p_plan->>'craft' NOT IN ('knit', 'crochet', 'other')
     OR jsonb_typeof(p_plan->'parts') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_plan->'parts') NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'craft setup plan is not valid' USING ERRCODE = '22023';
  END IF;
  FOR v_part IN SELECT value FROM jsonb_array_elements(p_plan->'parts') LOOP
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_part) k WHERE k NOT IN ('name', 'row_word', 'total_rows', 'stitch_count', 'sort_order', 'segments', 'rows'))
       OR jsonb_typeof(v_part->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_part->'segments') IS DISTINCT FROM 'array' OR jsonb_typeof(v_part->'rows') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'segments') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_part->'rows') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object') THEN
      RAISE EXCEPTION 'craft setup part is not valid' USING ERRCODE = '22023';
    END IF;
    v_name := btrim(v_part->>'name', c_trim);
    IF v_name = '' OR char_length(v_name) > 80 OR v_name ~ '[\x01-\x1f\x7f]' THEN
      RAISE EXCEPTION 'craft setup part name is not valid' USING ERRCODE = '22023';
    END IF;
    v_names := v_names || v_name;
  END LOOP;

  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_EXISTS: this project is already on the craft screen' USING ERRCODE = '23505';
  END IF;
  IF craft_setup_fingerprint(p_user_id, p_project_id) IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed since the preview' USING ERRCODE = 'MC072';
  END IF;

  v_plan := craft_setup_plan(p_user_id, p_project_id);
  IF jsonb_array_length(v_plan->'stops') > 0 THEN
    RAISE EXCEPTION 'CRAFT_SETUP_STOP: %', v_plan->>'stops' USING ERRCODE = '22023';
  END IF;
  v_given := jsonb_build_object(
    'active_part_index', COALESCE(p_plan->'active_part_index', 'null'::jsonb),
    'parts', (SELECT jsonb_agg(jsonb_build_object(
        'row_word', COALESCE(p.value->'row_word', 'null'::jsonb), 'total_rows', COALESCE(p.value->'total_rows', 'null'::jsonb),
        'stitch_count', COALESCE(p.value->'stitch_count', 'null'::jsonb),
        'segments', COALESCE((SELECT jsonb_agg(jsonb_build_object('task_id', COALESCE(s.value->'task_id', 'null'::jsonb), 'from_row', COALESCE(s.value->'from_row', 'null'::jsonb),
            'to_row', COALESCE(s.value->'to_row', 'null'::jsonb)) ORDER BY s.ordinality) FROM jsonb_array_elements(p.value->'segments') WITH ORDINALITY s), '[]'::jsonb),
        'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('item_id', COALESCE(r.value->'item_id', 'null'::jsonb), 'row', COALESCE(r.value->'row', 'null'::jsonb))
            ORDER BY r.ordinality) FROM jsonb_array_elements(p.value->'rows') WITH ORDINALITY r), '[]'::jsonb)
      ) ORDER BY p.ordinality) FROM jsonb_array_elements(p_plan->'parts') WITH ORDINALITY p));
  IF v_given IS DISTINCT FROM jsonb_build_object('active_part_index', v_plan->'active_part_index', 'parts', v_plan->'parts') THEN
    RAISE EXCEPTION 'CRAFT_SETUP_PLAN: the plan does not match the project' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO v_tasks FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id;

  INSERT INTO craft_projects (project_id, user_id, craft) VALUES (p_project_id, p_user_id, p_plan->>'craft');
  FOR v_part IN SELECT value FROM jsonb_array_elements(v_plan->'parts') LOOP
    v_index := v_index + 1;
    INSERT INTO craft_parts (user_id, project_id, name, sort_order, total_rows, row_word, stitch_count)
    VALUES (p_user_id, p_project_id, v_names[v_index], v_index - 1, (v_part->>'total_rows')::int, v_part->>'row_word', (v_part->>'stitch_count')::int)
    RETURNING id INTO v_part_id;
    v_part_ids := v_part_ids || v_part_id;
    INSERT INTO craft_segments (user_id, part_id, task_id, name, from_row, to_row, sort_order)
    SELECT p_user_id, v_part_id, k.id, rtrim(left(btrim(k.title, c_trim), 80), c_trim), (s.value->>'from_row')::int, (s.value->>'to_row')::int, s.ordinality - 1
    FROM jsonb_array_elements(v_part->'segments') WITH ORDINALITY s JOIN tasks k ON k.id = (s.value->>'task_id')::uuid;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_segments := v_segments + v_count;
    UPDATE task_checklist_items i SET craft_part_id = v_part_id, craft_row = (r.value->>'row')::int
    FROM jsonb_array_elements(v_part->'rows') r
    WHERE i.id = (r.value->>'item_id')::uuid AND i.user_id = p_user_id AND i.craft_part_id IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> jsonb_array_length(v_part->'rows') THEN
      RAISE EXCEPTION 'craft setup rows are not valid' USING ERRCODE = '22023';
    END IF;
    v_rows := v_rows + v_count;
  END LOOP;
  IF jsonb_typeof(v_plan->'active_part_index') = 'number' THEN
    v_active := (v_plan->>'active_part_index')::int;
    UPDATE craft_projects SET active_part_id = v_part_ids[v_active + 1] WHERE project_id = p_project_id AND user_id = p_user_id;
  END IF;

  -- Belt and braces after the writes: the same tasks, and no numbered item of a non-swatch task left unlinked.
  IF (SELECT array_agg(id ORDER BY id) FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id) IS DISTINCT FROM v_tasks
     OR EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
                WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample AND i.craft_part_id IS NULL AND i.text ~ c_label) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed while setting up' USING ERRCODE = 'MC072';
  END IF;

  RETURN jsonb_build_object('project_id', p_project_id, 'parts', cardinality(v_part_ids), 'segments', v_segments,
    'rows_linked', v_rows, 'active_part_id', CASE WHEN v_active IS NULL THEN NULL ELSE v_part_ids[v_active + 1] END);
END;
$$;

CREATE OR REPLACE FUNCTION craft_remove_blockers(p_user_id UUID, p_project_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM craft_links WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'links' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_instructions c JOIN craft_parts p ON p.id = c.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND c.user_id = p_user_id) THEN 'instructions' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_notes WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'notes' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_yarns WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'yarn' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_timers WHERE project_id = p_project_id AND user_id = p_user_id) THEN 'timer' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id AND NULLIF(btrim(gear), '') IS NOT NULL) THEN 'gear' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id
                      AND (quarters OR quarter <> 0 OR quarter_row IS NOT NULL)) THEN 'quarters' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id AND ridges) THEN 'ridges' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND s.close_check) THEN 'close_checks' END
  ]::text[], NULL);
$$;

ALTER TABLE craft_timers DROP COLUMN paused_at;
COMMIT;
NOTIFY pgrst, 'reload schema';
