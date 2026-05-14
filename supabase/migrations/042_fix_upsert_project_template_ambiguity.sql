-- Fix ambiguous column reference in template update path.

BEGIN;

CREATE OR REPLACE FUNCTION upsert_project_template(
  p_user_id UUID,
  p_template_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_default_stage project_stage DEFAULT 'Planned',
  p_default_rag rag_status DEFAULT 'Green',
  p_default_status_summary TEXT DEFAULT '',
  p_is_active BOOLEAN DEFAULT true,
  p_sections JSONB DEFAULT '[]'::jsonb,
  p_tasks JSONB DEFAULT '[]'::jsonb
)
RETURNS TABLE (
  template_id UUID,
  section_count INT,
  task_count INT,
  checklist_item_count INT
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_template_id UUID;
  v_template_name TEXT;
  v_section_map JSONB := '{}'::jsonb;
  v_section_count INT := 0;
  v_task_count INT := 0;
  v_checklist_item_count INT := 0;
  section_entry JSONB;
  task_entry JSONB;
  checklist_entry JSONB;
  v_section_key TEXT;
  v_section_name TEXT;
  v_new_section_id UUID;
  v_new_task_id UUID;
  v_task_title TEXT;
  v_task_description TEXT;
  v_task_type task_type;
  v_task_status task_status;
  v_priority_score INT;
  v_relative_due_days INT;
  v_needs_review BOOLEAN;
  v_blocker BOOLEAN;
  v_waiting_on TEXT;
  v_task_sort_order INT;
  v_target_section_id UUID;
  v_checklist_text TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  v_template_name := NULLIF(BTRIM(COALESCE(p_name, '')), '');
  IF v_template_name IS NULL THEN
    RAISE EXCEPTION 'Template name is required';
  END IF;

  IF char_length(v_template_name) > 200 THEN
    RAISE EXCEPTION 'Template name must be 200 characters or fewer';
  END IF;

  IF p_template_id IS NULL THEN
    INSERT INTO project_templates (
      user_id,
      name,
      description,
      default_stage,
      default_rag,
      default_status_summary,
      is_active
    ) VALUES (
      p_user_id,
      v_template_name,
      NULLIF(BTRIM(COALESCE(p_description, '')), ''),
      COALESCE(p_default_stage, 'Planned'::project_stage),
      COALESCE(p_default_rag, 'Green'::rag_status),
      COALESCE(p_default_status_summary, ''),
      COALESCE(p_is_active, true)
    )
    RETURNING id INTO v_template_id;
  ELSE
    SELECT pt.id
    INTO v_template_id
    FROM project_templates AS pt
    WHERE pt.id = p_template_id
      AND pt.user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Project template not found';
    END IF;

    UPDATE project_templates AS pt
    SET
      name = v_template_name,
      description = NULLIF(BTRIM(COALESCE(p_description, '')), ''),
      default_stage = COALESCE(p_default_stage, pt.default_stage),
      default_rag = COALESCE(p_default_rag, pt.default_rag),
      default_status_summary = COALESCE(p_default_status_summary, ''),
      is_active = COALESCE(p_is_active, pt.is_active)
    WHERE pt.id = v_template_id
      AND pt.user_id = p_user_id;

    DELETE FROM project_template_tasks AS ptt
    WHERE ptt.template_id = v_template_id
      AND ptt.user_id = p_user_id;

    DELETE FROM project_template_sections AS pts
    WHERE pts.template_id = v_template_id
      AND pts.user_id = p_user_id;
  END IF;

  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' THEN
    p_sections := '[]'::jsonb;
  END IF;

  IF p_tasks IS NULL OR jsonb_typeof(p_tasks) <> 'array' THEN
    p_tasks := '[]'::jsonb;
  END IF;

  FOR section_entry IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    v_section_name := NULLIF(BTRIM(COALESCE(section_entry->>'name', '')), '');
    IF v_section_name IS NULL THEN
      CONTINUE;
    END IF;

    v_section_key := COALESCE(
      NULLIF(BTRIM(COALESCE(section_entry->>'client_key', '')), ''),
      NULLIF(BTRIM(COALESCE(section_entry->>'id', '')), ''),
      gen_random_uuid()::text
    );

    INSERT INTO project_template_sections (
      user_id,
      template_id,
      name,
      sort_order
    ) VALUES (
      p_user_id,
      v_template_id,
      v_section_name,
      COALESCE((section_entry->>'sort_order')::int, 1000)
    )
    RETURNING id INTO v_new_section_id;

    v_section_map := v_section_map || jsonb_build_object(v_section_key, v_new_section_id::text);
    v_section_count := v_section_count + 1;
  END LOOP;

  FOR task_entry IN SELECT * FROM jsonb_array_elements(p_tasks)
  LOOP
    v_task_title := NULLIF(BTRIM(COALESCE(task_entry->>'title', '')), '');
    IF v_task_title IS NULL THEN
      CONTINUE;
    END IF;

    BEGIN
      v_task_type := COALESCE((task_entry->>'task_type')::task_type, 'Task'::task_type);
    EXCEPTION WHEN others THEN
      v_task_type := 'Task'::task_type;
    END;

    BEGIN
      v_task_status := COALESCE((task_entry->>'status')::task_status, 'Backlog'::task_status);
    EXCEPTION WHEN others THEN
      v_task_status := 'Backlog'::task_status;
    END;

    v_priority_score := COALESCE((task_entry->>'priority_score')::int, 50);
    v_priority_score := LEAST(100, GREATEST(0, v_priority_score));

    v_relative_due_days := NULL;
    IF NULLIF(BTRIM(COALESCE(task_entry->>'relative_due_days', '')), '') IS NOT NULL THEN
      v_relative_due_days := (task_entry->>'relative_due_days')::int;
    END IF;

    v_needs_review := COALESCE((task_entry->>'needs_review')::boolean, false);
    v_blocker := COALESCE((task_entry->>'blocker')::boolean, false);
    v_waiting_on := NULLIF(BTRIM(COALESCE(task_entry->>'waiting_on', '')), '');
    v_task_sort_order := COALESCE((task_entry->>'sort_order')::int, 1000);

    v_target_section_id := NULL;
    v_section_key := NULLIF(BTRIM(COALESCE(task_entry->>'section_key', '')), '');
    IF v_section_key IS NULL THEN
      v_section_key := NULLIF(BTRIM(COALESCE(task_entry->>'template_section_id', '')), '');
    END IF;

    IF v_section_key IS NOT NULL AND (v_section_map ? v_section_key) THEN
      v_target_section_id := (v_section_map ->> v_section_key)::uuid;
    END IF;

    v_task_description := NULLIF(BTRIM(COALESCE(task_entry->>'description', '')), '');

    INSERT INTO project_template_tasks (
      user_id,
      template_id,
      template_section_id,
      title,
      description,
      task_type,
      priority_score,
      status,
      relative_due_days,
      needs_review,
      blocker,
      waiting_on,
      sort_order,
      checklist_items
    ) VALUES (
      p_user_id,
      v_template_id,
      v_target_section_id,
      v_task_title,
      v_task_description,
      v_task_type,
      v_priority_score,
      v_task_status,
      v_relative_due_days,
      v_needs_review,
      v_blocker,
      v_waiting_on,
      v_task_sort_order,
      '{}'::text[]
    )
    RETURNING id INTO v_new_task_id;

    v_task_count := v_task_count + 1;

    IF task_entry ? 'checklist_items' AND jsonb_typeof(task_entry->'checklist_items') = 'array' THEN
      FOR checklist_entry IN SELECT * FROM jsonb_array_elements(task_entry->'checklist_items')
      LOOP
        IF jsonb_typeof(checklist_entry) <> 'string' THEN
          CONTINUE;
        END IF;

        v_checklist_text := NULLIF(BTRIM(trim(both '"' from checklist_entry::text)), '');
        IF v_checklist_text IS NULL THEN
          CONTINUE;
        END IF;

        UPDATE project_template_tasks AS ptt
        SET checklist_items = ptt.checklist_items || v_checklist_text
        WHERE ptt.id = v_new_task_id
          AND ptt.user_id = p_user_id;

        v_checklist_item_count := v_checklist_item_count + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT v_template_id, v_section_count, v_task_count, v_checklist_item_count;
END;
$$;

COMMIT;
