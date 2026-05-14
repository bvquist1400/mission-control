-- Atomic project template instantiation RPC.

BEGIN;

CREATE OR REPLACE FUNCTION instantiate_project_template(
  p_user_id UUID,
  p_template_id UUID,
  p_kickoff_date DATE,
  p_project_name TEXT DEFAULT NULL,
  p_implementation_id UUID DEFAULT NULL
)
RETURNS TABLE (
  project_id UUID,
  created_sections INT,
  created_tasks INT,
  created_checklist_items INT
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_template project_templates%ROWTYPE;
  v_new_project_id UUID;
  v_next_rank INT;
  v_section_map JSONB := '{}'::jsonb;
  v_new_section_id UUID;
  v_new_task_id UUID;
  v_section_count INT := 0;
  v_task_count INT := 0;
  v_checklist_count INT := 0;
  v_resolved_project_name TEXT;
  v_resolved_due_at TIMESTAMPTZ;
  v_target_section_id UUID;
  v_checklist_text TEXT;
  i INT;
  section_row RECORD;
  task_row RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'p_template_id is required';
  END IF;

  IF p_kickoff_date IS NULL THEN
    RAISE EXCEPTION 'kickoff_date is required';
  END IF;

  SELECT *
  INTO v_template
  FROM project_templates
  WHERE id = p_template_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project template not found';
  END IF;

  IF p_implementation_id IS NOT NULL THEN
    PERFORM 1
    FROM implementations
    WHERE id = p_implementation_id
      AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Implementation not found';
    END IF;
  END IF;

  v_resolved_project_name := NULLIF(BTRIM(p_project_name), '');
  IF v_resolved_project_name IS NULL THEN
    v_resolved_project_name := v_template.name;
  END IF;

  IF char_length(v_resolved_project_name) > 200 THEN
    RAISE EXCEPTION 'project_name must be 200 characters or fewer';
  END IF;

  SELECT COALESCE(MAX(portfolio_rank), 0) + 1
  INTO v_next_rank
  FROM projects
  WHERE user_id = p_user_id
    AND (
      (p_implementation_id IS NULL AND implementation_id IS NULL)
      OR implementation_id = p_implementation_id
    );

  INSERT INTO projects (
    user_id,
    implementation_id,
    name,
    description,
    stage,
    rag,
    status_summary,
    portfolio_rank
  ) VALUES (
    p_user_id,
    p_implementation_id,
    v_resolved_project_name,
    v_template.description,
    v_template.default_stage,
    v_template.default_rag,
    v_template.default_status_summary,
    v_next_rank
  )
  RETURNING id INTO v_new_project_id;

  FOR section_row IN
    SELECT id, name, sort_order, created_at
    FROM project_template_sections
    WHERE user_id = p_user_id
      AND template_id = p_template_id
    ORDER BY sort_order ASC, created_at ASC
  LOOP
    INSERT INTO project_sections (
      user_id,
      project_id,
      name,
      sort_order
    ) VALUES (
      p_user_id,
      v_new_project_id,
      section_row.name,
      section_row.sort_order
    )
    RETURNING id INTO v_new_section_id;

    v_section_map := v_section_map || jsonb_build_object(section_row.id::text, v_new_section_id::text);
    v_section_count := v_section_count + 1;
  END LOOP;

  FOR task_row IN
    SELECT
      t.id,
      t.template_section_id,
      t.title,
      t.description,
      t.task_type,
      t.priority_score,
      t.status,
      t.relative_due_days,
      t.needs_review,
      t.blocker,
      t.waiting_on,
      t.sort_order,
      t.checklist_items,
      t.created_at,
      s.sort_order AS template_section_sort_order
    FROM project_template_tasks t
    LEFT JOIN project_template_sections s ON s.id = t.template_section_id
    WHERE t.user_id = p_user_id
      AND t.template_id = p_template_id
    ORDER BY
      CASE WHEN t.template_section_id IS NULL THEN 1 ELSE 0 END,
      COALESCE(s.sort_order, 2147483647),
      t.sort_order,
      t.created_at
  LOOP
    v_target_section_id := NULL;
    IF task_row.template_section_id IS NOT NULL
       AND v_section_map ? task_row.template_section_id::text THEN
      v_target_section_id := (v_section_map ->> task_row.template_section_id::text)::uuid;
    END IF;

    v_resolved_due_at := CASE
      WHEN task_row.relative_due_days IS NULL THEN NULL
      ELSE ((p_kickoff_date + task_row.relative_due_days)::text || 'T00:00:00Z')::timestamptz
    END;

    INSERT INTO tasks (
      user_id,
      title,
      description,
      implementation_id,
      project_id,
      section_id,
      status,
      task_type,
      priority_score,
      due_at,
      needs_review,
      blocker,
      waiting_on,
      source_type
    ) VALUES (
      p_user_id,
      task_row.title,
      task_row.description,
      p_implementation_id,
      v_new_project_id,
      v_target_section_id,
      COALESCE(task_row.status, 'Backlog'::task_status),
      task_row.task_type,
      task_row.priority_score,
      v_resolved_due_at,
      task_row.needs_review,
      task_row.blocker,
      task_row.waiting_on,
      'Manual'
    )
    RETURNING id INTO v_new_task_id;

    v_task_count := v_task_count + 1;

    IF task_row.checklist_items IS NOT NULL
       AND array_length(task_row.checklist_items, 1) IS NOT NULL THEN
      FOR i IN 1..array_length(task_row.checklist_items, 1)
      LOOP
        v_checklist_text := NULLIF(BTRIM(task_row.checklist_items[i]), '');
        IF v_checklist_text IS NULL THEN
          CONTINUE;
        END IF;

        INSERT INTO task_checklist_items (
          user_id,
          task_id,
          text,
          is_done,
          sort_order
        ) VALUES (
          p_user_id,
          v_new_task_id,
          v_checklist_text,
          false,
          i - 1
        );

        v_checklist_count := v_checklist_count + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT v_new_project_id, v_section_count, v_task_count, v_checklist_count;
END;
$$;

COMMIT;
