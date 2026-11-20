-- Craft S4 (Baseline 690e174c, Brent 11/19 "approve it as written"): Reset craft screen, self-healing
-- parts, one part per section, stitch counts at set-up, and the guards the MCP row editing needs.
--
-- Additive: no table or column changes. Twelve new functions and one trigger; three 072/073
-- functions replaced (075's rollback puts their bodies back).
--  * craft_setup_fingerprint (072, replaced): v2 also hashes the task's unit_count and work_type
--    and the item's work_type (the stitch-count step reads them). Same text as
--    craftSetupFingerprintText() in src/lib/craft/setup-fingerprint.ts.
--  * craft_plan_core (new) / craft_setup_plan (073, replaced): the S4 grouping of planCraftSetup()
--    in src/lib/craft/setup.ts. One part per section (and per run of one row word in it), never
--    across a section; inside a section the tasks go by their first row number when the numbers
--    run on (every label distinct, each task starting after the one before ends), else by
--    creation (then id); a part whose labels run on keeps them as row numbers, a part whose
--    labels restart is counted straight through (task order, then checklist order). The old
--    'repeat' STOP is gone: a repeated label is a restart.
--  * craft_apply_units (new): the stitch-count step's writes. Only items of the project's
--    non-swatch tasks that are a numbered row or a "Cast on N" item and have no unit_count;
--    whole numbers 1..2147483647; a work type only on an item that has none; and every task it
--    touches that has its own unit_count must add up to it exactly. The text reading
--    ("→ N", holders) is the app's (planStitchCounts); this re-checks the rules it rests on.
--  * craft_setup_project (073, replaced): takes 'units' in the plan and writes them after the
--    fingerprint check and before re-planning (so the stitch count it compares is the one the
--    preview showed).
--  * Reset (craft_reset_preview, craft_reset_project): unlink and set up again in ONE
--    transaction. Ticks stay on the items. Sitting details, notes, rip-backs (craft_frogs),
--    instructions, the timer, links and yarn are re-pointed to the same rows: by item id
--    first (the item that held the old part + row), then by task + row number (the old
--    segment's task, the item whose label is that number). Anything that can't be re-pointed is
--    listed by the preview: sitting details, notes, the timer, links and yarn lose their part
--    (kept, unlinked); rip-backs and instructions go with the old part. Reset refuses (MC75K)
--    a project with quarter rows, ridge counts or band checks (Set up can't make them again).
--  * craft_checklist_heal (new trigger, AFTER DELETE ON task_checklist_items, per statement):
--    a part left with no rows is deleted, unless it has sittings, rip-backs, notes,
--    instructions, links, yarn or the timer (then it stays, hidden as empty; only Reset clears
--    it); a craft project left with no parts and nothing Remove would refuse is removed too, so
--    Set up is offered again.
--  * delete_task_checked (new): DELETE /api/tasks/[id] and MCP delete_task. Refuses a task with
--    ticked craft rows or sittings unless p_force.
--  * checklist_insert_items (new): insert rows after an item (or at the start / end), shifting
--    the rows after them, in one transaction.
--
-- Lock order everywhere (072): the advisory lock on the project, the project, its sections,
-- its tasks in id order, their checklist rows in id order, the craft project, the parts in id
-- order, then segments. The heal trigger runs after the delete already holds its task and item
-- locks, so it takes the craft project and parts NOWAIT (55P03 "busy, retry"), never waiting
-- the other way round.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── v2 fingerprint ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION craft_setup_fingerprint(p_user_id UUID, p_project_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH t AS (
    SELECT id, section_id, created_at, is_sample, title, unit_count, work_type FROM tasks
    WHERE project_id = p_project_id AND user_id = p_user_id
  )
  SELECT encode(sha256(convert_to(concat_ws(E'\n',
    'craft-setup-v2|' || p_project_id::text,
    COALESCE((SELECT string_agg(format('s|%s|%s|%s', s.id, s.sort_order, floor(extract(epoch FROM s.created_at) * 1000)::bigint), E'\n' ORDER BY s.id)
      FROM project_sections s WHERE s.project_id = p_project_id AND s.user_id = p_user_id), ''),
    COALESCE((SELECT string_agg(format('t|%s|%s|%s|%s|%s|%s|%s', t.id, COALESCE(t.section_id::text, ''), floor(extract(epoch FROM t.created_at) * 1000)::bigint,
        CASE WHEN t.is_sample THEN 1 ELSE 0 END, COALESCE(trim_scale(t.unit_count)::text, ''), COALESCE(t.work_type, ''),
        encode(sha256(convert_to(t.title, 'UTF8')), 'hex')), E'\n' ORDER BY t.id) FROM t), ''),
    COALESCE((SELECT string_agg(format('i|%s|%s|%s|%s|%s|%s|%s|%s', i.id, i.task_id, i.sort_order, CASE WHEN i.is_done THEN 1 ELSE 0 END,
        COALESCE(trim_scale(i.unit_count)::text, ''), COALESCE(i.work_type, ''), COALESCE(i.craft_part_id::text, ''),
        encode(sha256(convert_to(i.text, 'UTF8')), 'hex')), E'\n' ORDER BY i.id)
      FROM task_checklist_items i WHERE i.user_id = p_user_id AND i.task_id IN (SELECT id FROM t)), '')
  ), 'UTF8')), 'hex');
$$;

-- ── The S4 plan (planCraftSetup in SQL) ─────────────────────────────────────
-- p_reset: Reset plans the project as if it had no craft screen (the existing links and the
-- craft_projects row are not STOPs). Returns { stops, active_part_index, parts: [{ row_word,
-- total_rows, stitch_count, segments: [{ task_id, from_row, to_row }], rows: [{ item_id, row }] }] }.
CREATE FUNCTION craft_plan_core(p_user_id UUID, p_project_id UUID, p_reset BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  c_ws CONSTANT TEXT := '[\t\n\v\f\r    -     　﻿]';
  c_label CONSTANT TEXT := '^((Row|Rnd|Round)[ \t]+([0-9]+))(?![0-9A-Za-z_])';
  v_range TEXT;
  v_stops TEXT[] := '{}';
  v_parts JSONB;
  v_undone BOOLEAN[];
BEGIN
  v_range := '^(?:' || c_ws || '*(?:[-‐‑‒–—―−~/&,+]|(?:to|through|thru|and)(?![0-9A-Za-z_]))' || c_ws || '*[0-9]|\.[0-9])';
  IF NOT p_reset AND EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN v_stops := v_stops || 'on_craft_screen'::text; END IF;
  IF NOT p_reset AND EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND i.craft_part_id IS NOT NULL) THEN
    v_stops := v_stops || 'linked'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
               CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND NOT k.is_sample AND r.m IS NOT NULL
               AND ((r.m)[3]::numeric = 0 OR (r.m)[3]::numeric > 1000000 OR substr(i.text, char_length((r.m)[1]) + 1) ~* v_range)) THEN
    v_stops := v_stops || 'bad_number'::text;
  END IF;

  WITH sec AS (
    SELECT id, row_number() OVER (ORDER BY sort_order, floor(extract(epoch FROM created_at) * 1000) NULLS FIRST, id) AS rank
    FROM project_sections WHERE project_id = p_project_id AND user_id = p_user_id
  ), tk AS (
    SELECT k.id, s.id AS grp, s.rank, floor(extract(epoch FROM k.created_at) * 1000) AS ms
    FROM tasks k LEFT JOIN sec s ON s.id = k.section_id
    WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample
  ), it AS (
    SELECT i.task_id, i.id, i.is_done, i.unit_count, i.sort_order, (r.m)[2] AS word, (r.m)[3]::numeric AS num
    FROM task_checklist_items i CROSS JOIN LATERAL regexp_match(i.text, c_label) AS r(m)
    WHERE i.user_id = p_user_id AND i.task_id IN (SELECT id FROM tk) AND r.m IS NOT NULL
      AND (r.m)[3]::numeric BETWEEN 1 AND 1000000 AND substr(i.text, char_length((r.m)[1]) + 1) !~* v_range
  ), tw AS (
    SELECT task_id, count(DISTINCT (word = 'Row')) AS words, bool_and(word = 'Row') AS is_row,
      min(num) AS lo, max(num) AS hi, count(*) AS n, count(DISTINCT num) AS nd
    FROM it GROUP BY task_id
  ), te AS (
    SELECT tk.id, tk.grp, tk.rank, tk.ms, tw.is_row, tw.lo, tw.hi, tw.n, tw.nd,
      lag(tw.hi) OVER (PARTITION BY tk.grp ORDER BY tw.lo, tk.ms, tk.id) AS prev_hi_by_label
    FROM tk JOIN tw ON tw.task_id = tk.id WHERE tw.words = 1
  ), te2 AS (
    SELECT te.*, bool_and(te.n = te.nd AND (te.prev_hi_by_label IS NULL OR te.lo > te.prev_hi_by_label)) OVER (PARTITION BY te.grp) AS run_on
    FROM te
  ), te3 AS (
    SELECT te2.*, row_number() OVER (PARTITION BY te2.grp ORDER BY CASE WHEN te2.run_on THEN te2.lo ELSE 0 END, te2.ms, te2.id) AS ord
    FROM te2
  ), te4 AS (
    SELECT te3.*, CASE WHEN lag(te3.is_row) OVER (PARTITION BY te3.grp ORDER BY te3.ord) IS DISTINCT FROM te3.is_row THEN 1 ELSE 0 END AS brk
    FROM te3
  ), te5 AS (
    SELECT te4.*, sum(te4.brk) OVER (PARTITION BY te4.grp ORDER BY te4.ord) AS run_no FROM te4
  ), te6 AS (
    SELECT te5.*, lag(te5.hi) OVER (PARTITION BY te5.grp, te5.run_no ORDER BY te5.ord) AS prev_hi FROM te5
  ), prow AS (
    SELECT te6.grp, te6.rank, te6.run_no, te6.ord, te6.id AS task_id, te6.is_row, te6.lo, te6.prev_hi,
      it.id AS item_id, it.num, it.sort_order, it.is_done, it.unit_count
    FROM te6 JOIN it ON it.task_id = te6.id
  ), modes AS (
    SELECT grp, run_no, bool_and(prev_hi IS NULL OR lo > prev_hi) AND count(*) = count(DISTINCT num) AS labels
    FROM prow GROUP BY grp, run_no
  ), numbered AS (
    SELECT p.*, CASE WHEN m.labels THEN p.num::int
      ELSE (row_number() OVER (PARTITION BY p.grp, p.run_no ORDER BY p.ord, p.sort_order, p.item_id))::int END AS row
    FROM prow p JOIN modes m ON m.grp IS NOT DISTINCT FROM p.grp AND m.run_no = p.run_no
  ), seg AS (
    SELECT grp, run_no, ord, task_id, min(row) AS fr, max(row) AS tr FROM numbered GROUP BY grp, run_no, ord, task_id
  ), parts AS (
    SELECT x.grp, x.rank, x.run_no, bool_or(NOT x.is_done) AS undone,
      jsonb_build_object(
        'row_word', CASE WHEN bool_and(x.is_row) THEN 'row' ELSE 'round' END,
        'total_rows', max(x.row),
        'stitch_count', CASE WHEN count(x.unit_count) = count(*) AND count(DISTINCT x.unit_count) = 1 AND min(x.unit_count) > 0
            AND min(x.unit_count) <= 2147483647 AND min(x.unit_count) = trunc(min(x.unit_count)) THEN to_jsonb(min(x.unit_count)::int) ELSE 'null'::jsonb END,
        'segments', (SELECT jsonb_agg(jsonb_build_object('task_id', s.task_id, 'from_row', s.fr, 'to_row', s.tr) ORDER BY s.ord)
                     FROM seg s WHERE s.grp IS NOT DISTINCT FROM x.grp AND s.run_no = x.run_no),
        'rows', jsonb_agg(jsonb_build_object('item_id', x.item_id, 'row', x.row) ORDER BY x.row)) AS part
    FROM numbered x GROUP BY x.grp, x.rank, x.run_no
  )
  SELECT COALESCE(jsonb_agg(part ORDER BY rank NULLS LAST, run_no), '[]'::jsonb), array_agg(undone ORDER BY rank NULLS LAST, run_no)
  INTO v_parts, v_undone FROM parts;

  IF EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
             WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND i.user_id = p_user_id AND NOT k.is_sample
               AND i.text ~ c_label GROUP BY k.id HAVING count(DISTINCT (substring(i.text FROM '^(Row|Rnd|Round)') = 'Row')) > 1) THEN
    v_stops := v_stops || 'mixed_words'::text;
  END IF;
  IF jsonb_array_length(v_parts) = 0 THEN v_stops := v_stops || 'no_rows'::text; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_parts) p WHERE (p->>'total_rows')::numeric > 2000) THEN v_stops := v_stops || 'too_many_rows'::text; END IF;
  RETURN jsonb_build_object('stops', to_jsonb(v_stops),
    'active_part_index', to_jsonb(array_position(v_undone, true) - 1), 'parts', v_parts);
END;
$$;

CREATE OR REPLACE FUNCTION craft_setup_plan(p_user_id UUID, p_project_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$ SELECT craft_plan_core(p_user_id, p_project_id, false); $$;

-- ── The stitch-count step's writes (S4 H) ───────────────────────────────────
-- Called under craft_setup_lock (the project's tasks and items are locked). Returns how many
-- items it wrote; refuses (22023) anything that breaks a rule, nothing written.
CREATE FUNCTION craft_apply_units(p_user_id UUID, p_project_id UUID, p_units JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_label CONSTANT TEXT := '^(Row|Rnd|Round)[ \t]+[0-9]+(?![0-9A-Za-z_])';
  c_cast_on CONSTANT TEXT := '^[ \t]*cast[ \t]+on[ \t]+[0-9]{1,9}(?![0-9])';
  v_count INTEGER;
  v_len INTEGER;
BEGIN
  IF p_units IS NULL OR p_units = 'null'::jsonb THEN RETURN 0; END IF;
  IF jsonb_typeof(p_units) IS DISTINCT FROM 'array' OR jsonb_array_length(p_units) > 20000
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_units) u WHERE jsonb_typeof(u) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(u) k WHERE k NOT IN ('item_id', 'unit_count', 'work_type'))
       OR jsonb_typeof(u->'item_id') IS DISTINCT FROM 'string' OR (u->>'item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(u->'unit_count') IS DISTINCT FROM 'number' OR (u->>'unit_count')::numeric NOT BETWEEN 1 AND 2147483647
       OR (u->>'unit_count')::numeric <> trunc((u->>'unit_count')::numeric)
       OR (u ? 'work_type' AND jsonb_typeof(u->'work_type') <> 'null'
           AND (jsonb_typeof(u->'work_type') <> 'string' OR (u->>'work_type') !~ '^[a-z0-9][a-z0-9-]{0,39}$'))) THEN
    RAISE EXCEPTION 'stitch counts are not valid' USING ERRCODE = '22023';
  END IF;
  v_len := jsonb_array_length(p_units);
  IF v_len = 0 THEN RETURN 0; END IF;
  IF (SELECT count(DISTINCT lower(u->>'item_id')) FROM jsonb_array_elements(p_units) u) <> v_len THEN
    RAISE EXCEPTION 'stitch counts list an item twice' USING ERRCODE = '22023';
  END IF;
  UPDATE task_checklist_items i
  SET unit_count = (u.value->>'unit_count')::numeric,
      work_type = CASE WHEN jsonb_typeof(u.value->'work_type') = 'string' THEN u.value->>'work_type' ELSE i.work_type END
  FROM jsonb_array_elements(p_units) u, tasks k
  WHERE i.id = (u.value->>'item_id')::uuid AND i.user_id = p_user_id AND k.id = i.task_id AND k.user_id = p_user_id
    AND k.project_id = p_project_id AND NOT k.is_sample AND i.unit_count IS NULL
    AND (i.text ~ c_label OR i.text ~* c_cast_on)
    AND (jsonb_typeof(u.value->'work_type') IS DISTINCT FROM 'string' OR i.work_type IS NULL);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> v_len THEN
    RAISE EXCEPTION 'stitch counts only go on empty rows and cast-ons of this project' USING ERRCODE = '22023';
  END IF;
  -- Every task it wrote to that carries its own unit_count must add up to it exactly.
  IF EXISTS (SELECT 1 FROM tasks k
             WHERE k.user_id = p_user_id AND k.project_id = p_project_id AND k.unit_count IS NOT NULL
               AND k.id IN (SELECT i.task_id FROM task_checklist_items i JOIN jsonb_array_elements(p_units) u ON i.id = (u.value->>'item_id')::uuid)
               AND k.unit_count IS DISTINCT FROM (SELECT sum(i.unit_count) FROM task_checklist_items i WHERE i.task_id = k.id AND i.user_id = p_user_id)) THEN
    RAISE EXCEPTION 'stitch counts do not add up to the task''s count' USING ERRCODE = '22023';
  END IF;
  RETURN v_count;
END;
$$;

-- ── Set up (073's body + the stitch-count step) ─────────────────────────────
CREATE OR REPLACE FUNCTION craft_setup_project(p_user_id UUID, p_project_id UUID, p_plan JSONB, p_fingerprint TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_written JSONB;
  v_units INTEGER;
  v_plan JSONB;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  PERFORM craft_setup_check_payload(p_plan, p_fingerprint, p_project_id, true);
  -- 073: the advisory lock, then the project FOR UPDATE, before any task lock (no later upgrade).
  PERFORM pg_advisory_xact_lock(hashtextextended('craft_setup|' || p_project_id::text, 0));
  PERFORM 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_EXISTS: this project is already on the craft screen' USING ERRCODE = '23505';
  END IF;
  IF craft_setup_fingerprint(p_user_id, p_project_id) IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed since the preview' USING ERRCODE = 'MC072';
  END IF;
  v_units := craft_apply_units(p_user_id, p_project_id, p_plan->'units');
  v_plan := craft_plan_core(p_user_id, p_project_id, false);
  INSERT INTO craft_projects (project_id, user_id, craft) VALUES (p_project_id, p_user_id, p_plan->>'craft');
  v_written := craft_setup_write(p_user_id, p_project_id, p_plan, v_plan);
  RETURN v_written || jsonb_build_object('units_filled', v_units);
END;
$$;

-- Shape checks shared by Set up and Reset (before any lock). Reset ignores 'craft' (it keeps the kind).
CREATE FUNCTION craft_setup_check_payload(p_plan JSONB, p_fingerprint TEXT, p_project_id UUID, p_need_craft BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  c_trim CONSTANT TEXT := E'\t\n\x0b\f\r                  　﻿';
  v_part JSONB;
  v_name TEXT;
BEGIN
  IF p_project_id IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'project id and fingerprint are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_plan) k WHERE k NOT IN ('craft', 'active_part_index', 'parts', 'units'))
     OR (p_need_craft AND (jsonb_typeof(p_plan->'craft') IS DISTINCT FROM 'string' OR p_plan->>'craft' NOT IN ('knit', 'crochet', 'other')))
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
  END LOOP;
END;
$$;

-- The writes shared by Set up and Reset, under their locks, after the craft_projects row exists:
-- compares the caller's plan with the one rebuilt from the locked rows (only names may differ),
-- then makes the parts and segments and links the rows. Returns the counts and the new part ids.
CREATE FUNCTION craft_setup_write(p_user_id UUID, p_project_id UUID, p_plan JSONB, v_plan JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  c_trim CONSTANT TEXT := E'\t\n\x0b\f\r                  　﻿';
  c_label CONSTANT TEXT := '^(Row|Rnd|Round)[ \t]+[0-9]+(?![0-9A-Za-z_])';
  v_part JSONB;
  v_names TEXT[] := '{}';
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
  IF jsonb_array_length(v_plan->'stops') > 0 THEN
    RAISE EXCEPTION 'CRAFT_SETUP_STOP: %', v_plan->>'stops' USING ERRCODE = '22023';
  END IF;
  FOR v_part IN SELECT value FROM jsonb_array_elements(p_plan->'parts') LOOP
    v_names := v_names || btrim(v_part->>'name', c_trim);
  END LOOP;
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
  ELSE
    UPDATE craft_projects SET active_part_id = NULL WHERE project_id = p_project_id AND user_id = p_user_id AND active_part_id IS NOT NULL;
  END IF;

  -- Belt and braces after the writes: the same tasks, and no numbered item of a non-swatch task left unlinked.
  IF (SELECT array_agg(id ORDER BY id) FROM tasks WHERE project_id = p_project_id AND user_id = p_user_id) IS DISTINCT FROM v_tasks
     OR EXISTS (SELECT 1 FROM task_checklist_items i JOIN tasks k ON k.id = i.task_id
                WHERE k.project_id = p_project_id AND k.user_id = p_user_id AND NOT k.is_sample AND i.craft_part_id IS NULL AND i.text ~ c_label) THEN
    RAISE EXCEPTION 'CRAFT_SETUP_CHANGED: something changed while setting up' USING ERRCODE = 'MC072';
  END IF;

  RETURN jsonb_build_object('project_id', p_project_id, 'parts', cardinality(v_part_ids), 'segments', v_segments,
    'rows_linked', v_rows, 'active_part_id', CASE WHEN v_active IS NULL THEN NULL ELSE v_part_ids[v_active + 1] END,
    'part_ids', to_jsonb(v_part_ids));
END;
$$;

-- ── Reset ──────────────────────────────────────────────────────────────────
-- What Reset can't make again (refused, MC75K): quarter rows, ridge counts, band checks.
CREATE FUNCTION craft_reset_blockers(p_user_id UUID, p_project_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id
                      AND (quarters OR quarter <> 0 OR quarter_row IS NOT NULL)) THEN 'quarters' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id AND ridges) THEN 'ridges' END,
    CASE WHEN EXISTS (SELECT 1 FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id
                      WHERE p.project_id = p_project_id AND p.user_id = p_user_id AND s.close_check) THEN 'close_checks' END
  ]::text[], NULL);
$$;

-- Everything Reset re-points, as text (hashed into Reset's fingerprint): the craft project, parts,
-- segments, row links, sitting details, notes, rip-backs, instructions, the timer, links and yarn.
CREATE FUNCTION craft_reset_state_text(p_user_id UUID, p_project_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH p AS (SELECT * FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id)
  SELECT concat_ws(E'\n',
    'craft-reset-v1|' || p_project_id::text,
    COALESCE((SELECT format('c|%s|%s', c.craft, COALESCE(c.active_part_id::text, '')) FROM craft_projects c WHERE c.project_id = p_project_id AND c.user_id = p_user_id), ''),
    COALESCE((SELECT string_agg(format('p|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', p.id, p.sort_order, p.total_rows, p.row_word, p.quarters, p.quarter,
        COALESCE(p.quarter_row::text, ''), p.ridges, COALESCE(p.stitch_count::text, ''), encode(sha256(convert_to(p.name, 'UTF8')), 'hex')), E'\n' ORDER BY p.id) FROM p), ''),
    COALESCE((SELECT string_agg(format('g|%s|%s|%s|%s|%s|%s|%s', s.id, s.part_id, COALESCE(s.task_id::text, ''), s.from_row, s.to_row, s.close_check, s.sort_order), E'\n' ORDER BY s.id)
      FROM craft_segments s WHERE s.part_id IN (SELECT id FROM p)), ''),
    COALESCE((SELECT string_agg(format('r|%s|%s|%s', i.id, i.craft_part_id, i.craft_row), E'\n' ORDER BY i.id)
      FROM task_checklist_items i WHERE i.user_id = p_user_id AND i.craft_part_id IN (SELECT id FROM p)), ''),
    COALESCE((SELECT string_agg(format('d|%s|%s|%s|%s|%s', d.session_id, d.part_id, d.from_row, d.to_row, COALESCE(d.in_progress_row::text, '')), E'\n' ORDER BY d.session_id)
      FROM craft_sitting_details d WHERE d.user_id = p_user_id AND d.part_id IN (SELECT id FROM p)), ''),
    COALESCE((SELECT string_agg(format('n|%s|%s|%s', n.id, COALESCE(n.part_id::text, ''), COALESCE(n.row::text, '')), E'\n' ORDER BY n.id)
      FROM craft_notes n WHERE n.user_id = p_user_id AND n.project_id = p_project_id), ''),
    COALESCE((SELECT string_agg(format('f|%s|%s|%s|%s', f.id, f.part_id, f.from_row, f.to_row), E'\n' ORDER BY f.id)
      FROM craft_frogs f WHERE f.user_id = p_user_id AND f.part_id IN (SELECT id FROM p)), ''),
    COALESCE((SELECT string_agg(format('x|%s|%s|%s|%s', x.id, x.part_id, x.from_row, x.to_row), E'\n' ORDER BY x.id)
      FROM craft_instructions x WHERE x.user_id = p_user_id AND x.part_id IN (SELECT id FROM p)), ''),
    COALESCE((SELECT format('m|%s|%s|%s', COALESCE(t.part_id::text, ''), t.start_row, t.version)
      FROM craft_timers t WHERE t.user_id = p_user_id AND t.project_id = p_project_id), ''),
    COALESCE((SELECT string_agg(format('l|%s|%s|%s', l.id, COALESCE(l.part_id::text, ''), COALESCE(l.segment_id::text, '')), E'\n' ORDER BY l.id)
      FROM craft_links l WHERE l.user_id = p_user_id AND l.project_id = p_project_id), ''),
    COALESCE((SELECT string_agg(format('y|%s|%s', y.id, COALESCE(y.part_id::text, '')), E'\n' ORDER BY y.id)
      FROM craft_yarns y WHERE y.user_id = p_user_id AND y.project_id = p_project_id), '')
  );
$$;

-- Where each piece of the old parts' history lands in a plan (p_plan = craft_plan_core(.., true)).
-- new_part is the plan's part index (0-based), NULL = can't be re-pointed. A row (P, r) maps by the
-- item that holds it now, else by the old segment's task: the one item there labelled r. Row 0
-- (a sitting that ended before the part's first row) is "just before" the row that 1 maps to.
-- Part-level things (a note with no row, links, yarn) go to the new part that holds most of the
-- old part's rows.
CREATE FUNCTION craft_reset_decisions(p_user_id UUID, p_project_id UUID, p_plan JSONB)
RETURNS TABLE (kind TEXT, ref UUID, old_part_id UUID, new_part INTEGER, from_row INTEGER, to_row INTEGER, at_row INTEGER)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH np AS (
    SELECT (p.ordinality - 1)::int AS part_index, (r.value->>'item_id')::uuid AS item_id, (r.value->>'row')::int AS row
    FROM jsonb_array_elements(COALESCE(p_plan->'parts', '[]'::jsonb)) WITH ORDINALITY p
    CROSS JOIN LATERAL jsonb_array_elements(p.value->'rows') r
  ), op AS (
    SELECT id FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id
  ), by_item AS (
    SELECT i.craft_part_id AS part_id, i.craft_row AS r, np.part_index AS np_, np.row AS nr
    FROM task_checklist_items i JOIN np ON np.item_id = i.id
    WHERE i.user_id = p_user_id AND i.craft_part_id IN (SELECT id FROM op)
  ), refs AS (
    SELECT d.part_id, x.r FROM craft_sitting_details d CROSS JOIN LATERAL (VALUES (d.from_row), (d.to_row), (d.in_progress_row), (1)) x(r)
      WHERE d.user_id = p_user_id AND d.part_id IN (SELECT id FROM op) AND x.r >= 1
    UNION SELECT n.part_id, n.row FROM craft_notes n WHERE n.user_id = p_user_id AND n.part_id IN (SELECT id FROM op) AND n.row IS NOT NULL
    UNION SELECT f.part_id, x.r FROM craft_frogs f CROSS JOIN LATERAL (VALUES (f.from_row), (f.to_row)) x(r) WHERE f.user_id = p_user_id AND f.part_id IN (SELECT id FROM op)
    UNION SELECT c.part_id, x.r FROM craft_instructions c CROSS JOIN LATERAL (VALUES (c.from_row), (c.to_row)) x(r) WHERE c.user_id = p_user_id AND c.part_id IN (SELECT id FROM op)
    UNION SELECT t.part_id, t.start_row FROM craft_timers t WHERE t.user_id = p_user_id AND t.project_id = p_project_id AND t.part_id IN (SELECT id FROM op)
  ), by_task AS (
    SELECT w.part_id, w.r, min(np.part_index) AS np_, min(np.row) AS nr
    FROM refs w
    JOIN craft_segments s ON s.part_id = w.part_id AND w.r BETWEEN s.from_row AND s.to_row AND s.task_id IS NOT NULL
      -- FR1 P2: a label is that part's row number only while the task's rows still on the part are all numbered by
      -- their labels (an S1C part, or a part whose numbers ran on). On a part counted straight through "Row 6" is not
      -- row 6, so nothing there is matched by label and the preview lists it.
      AND EXISTS (SELECT 1 FROM task_checklist_items k WHERE k.task_id = s.task_id AND k.craft_part_id = w.part_id AND k.user_id = p_user_id)
      AND NOT EXISTS (SELECT 1 FROM task_checklist_items k WHERE k.task_id = s.task_id AND k.craft_part_id = w.part_id AND k.user_id = p_user_id
        AND substring(k.text FROM '^(?:Row|Rnd|Round)[ \t]+([0-9]+)(?![0-9A-Za-z_])')::numeric IS DISTINCT FROM k.craft_row)
    JOIN task_checklist_items i ON i.task_id = s.task_id AND i.user_id = p_user_id
      AND substring(i.text FROM '^(?:Row|Rnd|Round)[ \t]+([0-9]+)(?![0-9A-Za-z_])')::numeric = w.r
    JOIN np ON np.item_id = i.id
    WHERE NOT EXISTS (SELECT 1 FROM by_item b WHERE b.part_id = w.part_id AND b.r = w.r)
    GROUP BY w.part_id, w.r HAVING count(DISTINCT i.id) = 1
  ), m AS (
    SELECT part_id, r, np_, nr FROM by_item UNION ALL SELECT part_id, r, np_, nr FROM by_task
  ), dom AS (
    SELECT DISTINCT ON (part_id) part_id, np_ FROM (SELECT part_id, np_, count(*) AS c FROM by_item GROUP BY part_id, np_) z ORDER BY part_id, c DESC, np_
  )
  SELECT 'sitting', d.session_id, d.part_id,
    CASE WHEN t.np_ IS NOT NULL AND f.np_ = t.np_ AND f.nr <= t.nr AND (d.in_progress_row IS NULL OR ip.np_ = t.np_) THEN t.np_ END,
    f.nr, t.nr, ip.nr
  FROM craft_sitting_details d
  LEFT JOIN LATERAL (SELECT m.np_, CASE WHEN d.to_row = 0 THEN m.nr - 1 ELSE m.nr END AS nr FROM m WHERE m.part_id = d.part_id AND m.r = GREATEST(d.to_row, 1)) t ON true
  LEFT JOIN LATERAL (SELECT m.np_, CASE WHEN d.from_row = 0 THEN m.nr - 1 ELSE m.nr END AS nr FROM m WHERE m.part_id = d.part_id AND m.r = GREATEST(d.from_row, 1)) f ON true
  LEFT JOIN LATERAL (SELECT m.np_, m.nr FROM m WHERE m.part_id = d.part_id AND m.r = d.in_progress_row) ip ON true
  WHERE d.user_id = p_user_id AND d.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'note', n.id, n.part_id, CASE WHEN n.row IS NULL THEN dm.np_ ELSE x.np_ END, NULL, NULL, x.nr
  FROM craft_notes n
  LEFT JOIN m x ON x.part_id = n.part_id AND x.r = n.row
  LEFT JOIN dom dm ON dm.part_id = n.part_id
  WHERE n.user_id = p_user_id AND n.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'frog', f.id, f.part_id, CASE WHEN a.np_ = b.np_ AND a.nr <= b.nr THEN a.np_ END, a.nr, b.nr, NULL
  FROM craft_frogs f LEFT JOIN m a ON a.part_id = f.part_id AND a.r = f.from_row LEFT JOIN m b ON b.part_id = f.part_id AND b.r = f.to_row
  WHERE f.user_id = p_user_id AND f.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'instruction', c.id, c.part_id, CASE WHEN a.np_ = b.np_ AND a.nr <= b.nr THEN a.np_ END, a.nr, b.nr, NULL
  FROM craft_instructions c LEFT JOIN m a ON a.part_id = c.part_id AND a.r = c.from_row LEFT JOIN m b ON b.part_id = c.part_id AND b.r = c.to_row
  WHERE c.user_id = p_user_id AND c.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'timer', NULL::uuid, t.part_id, x.np_, NULL, NULL, x.nr
  FROM craft_timers t LEFT JOIN m x ON x.part_id = t.part_id AND x.r = t.start_row
  WHERE t.user_id = p_user_id AND t.project_id = p_project_id AND t.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'link', l.id, l.part_id, dm.np_, NULL, NULL, NULL
  FROM craft_links l LEFT JOIN dom dm ON dm.part_id = l.part_id
  WHERE l.user_id = p_user_id AND l.project_id = p_project_id AND l.part_id IN (SELECT id FROM op)
  UNION ALL
  SELECT 'yarn', y.id, y.part_id, dm.np_, NULL, NULL, NULL
  FROM craft_yarns y LEFT JOIN dom dm ON dm.part_id = y.part_id
  WHERE y.user_id = p_user_id AND y.project_id = p_project_id AND y.part_id IN (SELECT id FROM op);
$$;

-- The Reset preview, read in one statement: the fingerprints Reset will compare, what it refuses,
-- the old parts and what carries over (counts, and every piece that can't, in plain fields).
CREATE FUNCTION craft_reset_preview(p_user_id UUID, p_project_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_plan JSONB := craft_plan_core(p_user_id, p_project_id, true);
  v_setup TEXT := craft_setup_fingerprint(p_user_id, p_project_id);
  v_state TEXT := encode(sha256(convert_to(craft_reset_state_text(p_user_id, p_project_id), 'UTF8')), 'hex');
BEGIN
  RETURN jsonb_build_object(
    'on_craft_screen', EXISTS (SELECT 1 FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id),
    'setup_fingerprint', v_setup, 'state_fingerprint', v_state,
    'fingerprint', encode(sha256(convert_to(v_setup || '|' || v_state, 'UTF8')), 'hex'),
    'blockers', to_jsonb(craft_reset_blockers(p_user_id, p_project_id)),
    'old_parts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'row_word', p.row_word, 'total_rows', p.total_rows,
        'row_count', (SELECT count(*) FROM task_checklist_items i WHERE i.craft_part_id = p.id AND i.user_id = p_user_id))
        ORDER BY p.sort_order, p.id) FROM craft_parts p WHERE p.project_id = p_project_id AND p.user_id = p_user_id), '[]'::jsonb),
    'carry', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.ref, 'old_part_id', d.old_part_id, 'new_part', d.new_part,
        'from_row', d.from_row, 'to_row', d.to_row, 'at_row', d.at_row,
        'date', (SELECT s.session_date FROM work_sessions s WHERE s.id = d.ref AND d.kind = 'sitting'),
        'old_from_row', (SELECT x.from_row FROM craft_sitting_details x WHERE x.session_id = d.ref AND d.kind = 'sitting'),
        'old_to_row', COALESCE((SELECT x.to_row FROM craft_sitting_details x WHERE x.session_id = d.ref AND d.kind = 'sitting'),
                               (SELECT f.to_row FROM craft_frogs f WHERE f.id = d.ref AND d.kind = 'frog'),
                               (SELECT c.to_row FROM craft_instructions c WHERE c.id = d.ref AND d.kind = 'instruction')),
        'text', left(COALESCE((SELECT n.text FROM craft_notes n WHERE n.id = d.ref AND d.kind = 'note'),
                              (SELECT c.text FROM craft_instructions c WHERE c.id = d.ref AND d.kind = 'instruction'),
                              (SELECT l.title FROM craft_links l WHERE l.id = d.ref AND d.kind = 'link'),
                              (SELECT y.name FROM craft_yarns y WHERE y.id = d.ref AND d.kind = 'yarn')), 120))
        ORDER BY d.kind, d.ref) FROM craft_reset_decisions(p_user_id, p_project_id, v_plan) d), '[]'::jsonb));
END;
$$;

-- Reset: one transaction. Takes Set up's locks (advisory, project, sections, tasks, items), then the
-- craft project, its parts and segments FOR UPDATE; refuses MC75K (blockers, details = the keys),
-- MC072 (the fingerprint changed), P0002 (not on the craft screen); writes the stitch counts,
-- re-plans and compares like Set up, makes the new parts, re-points the history, moves the row
-- links, then deletes the old parts (taking with them only rip-backs and instructions that
-- couldn't be re-pointed).
CREATE FUNCTION craft_reset_project(p_user_id UUID, p_project_id UUID, p_plan JSONB, p_fingerprint TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_blockers TEXT[];
  v_setup TEXT;
  v_state TEXT;
  v_units INTEGER;
  v_plan JSONB;
  v_decisions JSONB;
  v_old UUID[];
  v_written JSONB;
  v_new UUID[];
  v_carried JSONB;
  v_lost JSONB;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  PERFORM craft_setup_check_payload(p_plan, p_fingerprint, p_project_id, false);
  PERFORM pg_advisory_xact_lock(hashtextextended('craft_setup|' || p_project_id::text, 0));
  PERFORM 1 FROM projects WHERE id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF NOT craft_setup_lock(p_user_id, p_project_id) THEN
    RAISE EXCEPTION 'CRAFT_RESET_NO_PROJECT' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM craft_projects WHERE project_id = p_project_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRAFT_RESET_NOT_ON_SCREEN' USING ERRCODE = 'P0002'; END IF;
  SELECT array_agg(id ORDER BY id) INTO v_old FROM (SELECT id FROM craft_parts WHERE project_id = p_project_id AND user_id = p_user_id ORDER BY id FOR UPDATE) p;
  v_old := COALESCE(v_old, '{}');
  PERFORM 1 FROM craft_segments WHERE part_id = ANY (v_old) ORDER BY id FOR UPDATE;

  v_blockers := craft_reset_blockers(p_user_id, p_project_id);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION 'CRAFT_RESET_KEEPS' USING ERRCODE = 'MC75K', DETAIL = array_to_string(v_blockers, ',');
  END IF;
  v_setup := craft_setup_fingerprint(p_user_id, p_project_id);
  v_state := encode(sha256(convert_to(craft_reset_state_text(p_user_id, p_project_id), 'UTF8')), 'hex');
  IF encode(sha256(convert_to(v_setup || '|' || v_state, 'UTF8')), 'hex') IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'CRAFT_RESET_CHANGED: something changed since the preview' USING ERRCODE = 'MC072';
  END IF;

  v_units := craft_apply_units(p_user_id, p_project_id, p_plan->'units');
  v_plan := craft_plan_core(p_user_id, p_project_id, true);
  -- Where everything lands, read while the old links still stand.
  SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_decisions FROM craft_reset_decisions(p_user_id, p_project_id, v_plan) d;

  -- Unlink first (the same items move to the new parts); ticks, units and sittings stay on the items.
  UPDATE task_checklist_items SET craft_part_id = NULL, craft_row = NULL WHERE user_id = p_user_id AND craft_part_id = ANY (v_old);
  v_written := craft_setup_write(p_user_id, p_project_id, p_plan, v_plan);
  SELECT array_agg(value::uuid ORDER BY ordinality) INTO v_new FROM jsonb_array_elements_text(v_written->'part_ids') WITH ORDINALITY;

  -- Re-point, by the decisions (new_part NULL = can't: the part link is cleared, or the row goes with the old part).
  UPDATE craft_sitting_details d SET part_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE v_new[x.new_part + 1] END,
    from_row = CASE WHEN x.new_part IS NULL THEN d.from_row ELSE x.from_row END,
    to_row = CASE WHEN x.new_part IS NULL THEN d.to_row ELSE x.to_row END,
    in_progress_row = CASE WHEN x.new_part IS NULL THEN d.in_progress_row ELSE x.at_row END
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER, from_row INTEGER, to_row INTEGER, at_row INTEGER)
  WHERE x.kind = 'sitting' AND d.session_id = x.ref AND d.user_id = p_user_id;
  UPDATE craft_notes n SET part_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE v_new[x.new_part + 1] END,
    row = CASE WHEN x.new_part IS NULL THEN NULL ELSE x.at_row END
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER, at_row INTEGER)
  WHERE x.kind = 'note' AND n.id = x.ref AND n.user_id = p_user_id;
  UPDATE craft_frogs f SET part_id = v_new[x.new_part + 1], from_row = x.from_row, to_row = x.to_row
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER, from_row INTEGER, to_row INTEGER)
  WHERE x.kind = 'frog' AND x.new_part IS NOT NULL AND f.id = x.ref AND f.user_id = p_user_id;
  UPDATE craft_instructions c SET part_id = v_new[x.new_part + 1], from_row = x.from_row, to_row = x.to_row
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER, from_row INTEGER, to_row INTEGER)
  WHERE x.kind = 'instruction' AND x.new_part IS NOT NULL AND c.id = x.ref AND c.user_id = p_user_id;
  UPDATE craft_timers t SET part_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE v_new[x.new_part + 1] END,
    start_row = COALESCE(CASE WHEN x.new_part IS NULL THEN NULL ELSE x.at_row END, t.start_row), version = t.version + 1
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, new_part INTEGER, at_row INTEGER)
  WHERE x.kind = 'timer' AND t.user_id = p_user_id AND t.project_id = p_project_id;
  UPDATE craft_links l SET part_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE v_new[x.new_part + 1] END,
    segment_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE (SELECT ns.id FROM craft_segments os JOIN craft_segments ns ON ns.task_id = os.task_id
      WHERE os.id = l.segment_id AND ns.part_id = v_new[x.new_part + 1] ORDER BY ns.sort_order LIMIT 1) END
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER)
  WHERE x.kind = 'link' AND l.id = x.ref AND l.user_id = p_user_id;
  UPDATE craft_yarns y SET part_id = CASE WHEN x.new_part IS NULL THEN NULL ELSE v_new[x.new_part + 1] END
  FROM jsonb_to_recordset(v_decisions) x(kind TEXT, ref UUID, new_part INTEGER)
  WHERE x.kind = 'yarn' AND y.id = x.ref AND y.user_id = p_user_id;

  DELETE FROM craft_parts WHERE id = ANY (v_old) AND user_id = p_user_id;

  SELECT COALESCE(jsonb_object_agg(k, c), '{}'::jsonb) INTO v_carried FROM (SELECT x->>'kind' AS k, count(*) AS c FROM jsonb_array_elements(v_decisions) x WHERE x->'new_part' <> 'null'::jsonb GROUP BY 1) z;
  SELECT COALESCE(jsonb_object_agg(k, c), '{}'::jsonb) INTO v_lost FROM (SELECT x->>'kind' AS k, count(*) AS c FROM jsonb_array_elements(v_decisions) x WHERE x->'new_part' = 'null'::jsonb GROUP BY 1) z;
  RETURN (v_written - 'part_ids') || jsonb_build_object('units_filled', v_units, 'old_parts', cardinality(v_old), 'carried', v_carried, 'lost', v_lost);
END;
$$;

-- ── Self-heal (S4 A) ───────────────────────────────────────────────────────
-- A part keeps its row: anything that would be lost with it.
CREATE FUNCTION craft_part_keeps(p_part_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM craft_sitting_details WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_frogs WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_notes WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_instructions WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_links WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_yarns WHERE part_id = p_part_id)
      OR EXISTS (SELECT 1 FROM craft_timers WHERE part_id = p_part_id);
$$;

CREATE FUNCTION craft_checklist_heal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_project RECORD;
  v_part UUID;
BEGIN
  FOR v_project IN
    SELECT DISTINCT p.project_id, p.user_id FROM old_rows o JOIN craft_parts p ON p.id = o.craft_part_id ORDER BY p.project_id
  LOOP
    -- The delete already holds its task and item locks: never wait here (072's order is craft project, then parts).
    PERFORM 1 FROM craft_projects WHERE project_id = v_project.project_id FOR NO KEY UPDATE NOWAIT;
    PERFORM 1 FROM craft_parts WHERE project_id = v_project.project_id AND id IN (SELECT craft_part_id FROM old_rows) ORDER BY id FOR UPDATE NOWAIT;
    FOR v_part IN
      SELECT p.id FROM craft_parts p
      WHERE p.project_id = v_project.project_id AND p.id IN (SELECT craft_part_id FROM old_rows)
        AND NOT EXISTS (SELECT 1 FROM task_checklist_items i WHERE i.craft_part_id = p.id)
      ORDER BY p.id
    LOOP
      -- Pick 3: a part with sittings, rip-backs or notes (or anything else hung on it) stays, hidden as empty.
      IF NOT craft_part_keeps(v_part) THEN DELETE FROM craft_parts WHERE id = v_part; END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM craft_parts WHERE project_id = v_project.project_id)
       AND cardinality(craft_remove_blockers(v_project.user_id, v_project.project_id)) = 0 THEN
      DELETE FROM craft_projects WHERE project_id = v_project.project_id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_checklist_craft_heal AFTER DELETE ON task_checklist_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION craft_checklist_heal();

-- ── Delete guard (S4 A) ────────────────────────────────────────────────────
CREATE FUNCTION delete_task_checked(p_user_id UUID, p_task_id UUID, p_force BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_ticked INTEGER;
  v_sittings INTEGER;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF p_task_id IS NULL THEN RAISE EXCEPTION 'task id is required' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM tasks WHERE id = p_task_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT count(*) INTO v_ticked FROM task_checklist_items WHERE task_id = p_task_id AND user_id = p_user_id AND craft_part_id IS NOT NULL AND is_done;
  SELECT count(*) INTO v_sittings FROM work_sessions s WHERE s.user_id = p_user_id AND (s.task_id = p_task_id
    OR EXISTS (SELECT 1 FROM work_session_items w JOIN task_checklist_items i ON i.id = w.checklist_item_id WHERE w.session_id = s.id AND i.task_id = p_task_id));
  IF (v_ticked > 0 OR v_sittings > 0) AND NOT COALESCE(p_force, false) THEN
    RETURN jsonb_build_object('status', 'refused', 'ticked_craft_rows', v_ticked, 'sittings', v_sittings);
  END IF;
  DELETE FROM tasks WHERE id = p_task_id AND user_id = p_user_id;
  RETURN jsonb_build_object('status', 'deleted', 'ticked_craft_rows', v_ticked, 'sittings', v_sittings);
END;
$$;

-- ── Insert rows (S4 E) ─────────────────────────────────────────────────────
-- p_items: [{ text, unit_count?, work_type?, is_done? }] (1..500). After p_after_item_id (an item of
-- the task), else at the start when p_at_start, else at the end; the rows after them move down.
CREATE FUNCTION checklist_insert_items(p_user_id UUID, p_task_id UUID, p_items JSONB, p_after_item_id UUID DEFAULT NULL, p_at_start BOOLEAN DEFAULT false)
RETURNS SETOF task_checklist_items
LANGUAGE plpgsql
SET search_path = public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_n INTEGER;
  v_at INTEGER;
BEGIN
  PERFORM work_sessions_assert_caller(p_user_id);
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 500
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN ('text', 'unit_count', 'work_type', 'is_done'))
       OR jsonb_typeof(x->'text') IS DISTINCT FROM 'string' OR btrim(x->>'text') = ''
       OR (x ? 'unit_count' AND jsonb_typeof(x->'unit_count') <> 'null' AND (jsonb_typeof(x->'unit_count') <> 'number' OR (x->>'unit_count')::numeric < 0))
       OR (x ? 'work_type' AND jsonb_typeof(x->'work_type') <> 'null' AND (jsonb_typeof(x->'work_type') <> 'string' OR (x->>'work_type') !~ '^[a-z0-9][a-z0-9-]{0,39}$'))
       OR (x ? 'is_done' AND jsonb_typeof(x->'is_done') <> 'boolean')) THEN
    RAISE EXCEPTION 'checklist items are not valid' USING ERRCODE = '22023';
  END IF;
  -- 059's order: the task first, then its rows.
  PERFORM 1 FROM tasks WHERE id = p_task_id AND user_id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM task_checklist_items WHERE task_id = p_task_id AND user_id = p_user_id ORDER BY id FOR NO KEY UPDATE;
  v_n := jsonb_array_length(p_items);
  IF p_after_item_id IS NOT NULL THEN
    SELECT sort_order + 1 INTO v_at FROM task_checklist_items WHERE id = p_after_item_id AND task_id = p_task_id AND user_id = p_user_id;
    IF v_at IS NULL THEN RAISE EXCEPTION 'that item is not on this task' USING ERRCODE = 'P0002'; END IF;
    UPDATE task_checklist_items SET sort_order = sort_order + v_n WHERE task_id = p_task_id AND user_id = p_user_id AND sort_order >= v_at AND id <> p_after_item_id;
  ELSIF p_at_start THEN
    SELECT COALESCE(min(sort_order), 0) INTO v_at FROM task_checklist_items WHERE task_id = p_task_id AND user_id = p_user_id;
    UPDATE task_checklist_items SET sort_order = sort_order + v_n WHERE task_id = p_task_id AND user_id = p_user_id;
  ELSE
    SELECT COALESCE(max(sort_order), -1) + 1 INTO v_at FROM task_checklist_items WHERE task_id = p_task_id AND user_id = p_user_id;
  END IF;
  RETURN QUERY
  WITH ins AS (
  INSERT INTO task_checklist_items (user_id, task_id, text, is_done, sort_order, unit_count, work_type)
  SELECT p_user_id, p_task_id, btrim(x.value->>'text'), COALESCE((x.value->>'is_done')::boolean, false), v_at + (x.ordinality - 1)::int,
    CASE WHEN jsonb_typeof(x.value->'unit_count') = 'number' THEN (x.value->>'unit_count')::numeric END,
    CASE WHEN jsonb_typeof(x.value->'work_type') = 'string' THEN x.value->>'work_type' END
  FROM jsonb_array_elements(p_items) WITH ORDINALITY x
  RETURNING *)
  SELECT * FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION craft_plan_core(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_apply_units(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_setup_check_payload(JSONB, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_setup_write(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_reset_blockers(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_reset_state_text(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_reset_decisions(UUID, UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_reset_preview(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_reset_project(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_part_keeps(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION craft_checklist_heal() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION delete_task_checked(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION checklist_insert_items(UUID, UUID, JSONB, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION craft_plan_core(UUID, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_apply_units(UUID, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_setup_check_payload(JSONB, TEXT, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_setup_write(UUID, UUID, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_reset_blockers(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_reset_state_text(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_reset_decisions(UUID, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_reset_preview(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_reset_project(UUID, UUID, JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_part_keeps(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION craft_checklist_heal() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_task_checked(UUID, UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION checklist_insert_items(UUID, UUID, JSONB, UUID, BOOLEAN) TO authenticated, service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
