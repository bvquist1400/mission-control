-- Craft S1: additive facts only. No counters, timer operations, RPCs or backfill.
-- Nullable part/segment links survive deletion; required part children cascade.
-- Rollback loses craft metadata only: ticks, sessions and minutes are preserved.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE craft_projects (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  craft TEXT NOT NULL CHECK (craft IN ('knit', 'crochet', 'other')),
  gear TEXT CHECK (char_length(gear) <= 500),
  active_part_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) <= 80),
  sort_order INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL CHECK (total_rows > 0),
  row_word TEXT NOT NULL DEFAULT 'row' CHECK (row_word IN ('row', 'round')),
  quarters BOOLEAN NOT NULL DEFAULT false,
  quarter INTEGER NOT NULL DEFAULT 0 CHECK (quarter BETWEEN 0 AND 3),
  quarter_row INTEGER CHECK (quarter_row > 0),
  ridges BOOLEAN NOT NULL DEFAULT false,
  stitch_count INTEGER CHECK (stitch_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES craft_parts(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) <= 80),
  from_row INTEGER NOT NULL CHECK (from_row > 0),
  to_row INTEGER NOT NULL CHECK (to_row >= from_row),
  sort_order INTEGER NOT NULL DEFAULT 0,
  close_check BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_timers (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  sitting_started_at TIMESTAMPTZ NOT NULL,
  running_since TIMESTAMPTZ,
  banked_seconds INTEGER NOT NULL DEFAULT 0 CHECK (banked_seconds >= 0),
  adjust_seconds INTEGER NOT NULL DEFAULT 0,
  start_row INTEGER NOT NULL CHECK (start_row > 0),
  start_quarter INTEGER NOT NULL DEFAULT 0 CHECK (start_quarter BETWEEN 0 AND 3),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_sitting_details (
  session_id UUID PRIMARY KEY REFERENCES work_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  from_row INTEGER NOT NULL CHECK (from_row >= 0),
  from_quarter INTEGER NOT NULL DEFAULT 0 CHECK (from_quarter BETWEEN 0 AND 3),
  to_row INTEGER NOT NULL CHECK (to_row >= from_row),
  to_quarter INTEGER NOT NULL DEFAULT 0 CHECK (to_quarter BETWEEN 0 AND 3),
  in_progress_row INTEGER CHECK (in_progress_row > 0),
  adjust_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  row INTEGER CHECK (row > 0),
  session_id UUID REFERENCES work_sessions(id) ON DELETE SET NULL,
  text TEXT NOT NULL CHECK (char_length(text) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  segment_id UUID REFERENCES craft_segments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'doc', 'video', 'ravelry', 'web')),
  title TEXT NOT NULL CHECK (char_length(title) <= 120),
  url TEXT NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2000),
  page INTEGER CHECK (page > 0),
  start_seconds INTEGER CHECK (start_seconds >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES craft_parts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'marker', 'check')),
  from_row INTEGER NOT NULL CHECK (from_row > 0),
  to_row INTEGER NOT NULL CHECK (to_row >= from_row),
  every_rows INTEGER CHECK (every_rows > 0),
  text TEXT NOT NULL CHECK (char_length(text) <= 1000),
  link_id UUID REFERENCES craft_links(id) ON DELETE SET NULL,
  page INTEGER CHECK (page > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE craft_yarns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  role TEXT CHECK (char_length(role) <= 40),
  name TEXT NOT NULL CHECK (char_length(name) <= 120),
  color TEXT CHECK (char_length(color) <= 60),
  weight TEXT CHECK (char_length(weight) <= 30),
  yards_per_skein NUMERIC CHECK (yards_per_skein >= 0),
  skeins_on_hand NUMERIC CHECK (skeins_on_hand >= 0),
  yards_needed NUMERIC CHECK (yards_needed >= 0),
  runouts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE craft_projects ADD CONSTRAINT craft_projects_active_part_id_fkey
  FOREIGN KEY (active_part_id) REFERENCES craft_parts(id) ON DELETE SET NULL;

ALTER TABLE task_checklist_items
  ADD COLUMN craft_part_id UUID REFERENCES craft_parts(id) ON DELETE SET NULL,
  ADD COLUMN craft_row INTEGER,
  ADD CONSTRAINT task_checklist_items_craft_pair_check CHECK (
    (craft_part_id IS NULL AND craft_row IS NULL) OR
    (craft_part_id IS NOT NULL AND craft_row IS NOT NULL AND craft_row > 0)
  );
CREATE UNIQUE INDEX idx_checklist_craft_row ON task_checklist_items(craft_part_id, craft_row)
  WHERE craft_part_id IS NOT NULL;
CREATE INDEX idx_checklist_craft_progress ON task_checklist_items(craft_part_id, is_done, craft_row);

-- Task first, then read its project: the 059 lock order. A task move and a
-- craft-row/segment write serialize on the same NO KEY UPDATE lock.
-- JSON is used only to share reference validation across the nine row shapes.
CREATE FUNCTION craft_check_ownership()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  r JSONB := to_jsonb(NEW);
  owner_id UUID := (r->>'user_id')::uuid;
  project_ref UUID := (r->>'project_id')::uuid;
  part_ref UUID := COALESCE((r->>'part_id')::uuid, (r->>'active_part_id')::uuid, (r->>'craft_part_id')::uuid);
  task_ref UUID := (r->>'task_id')::uuid;
  session_ref UUID := (r->>'session_id')::uuid;
  ref_project UUID;
  ref_user UUID;
  task_project UUID;
  task_user UUID;
BEGIN
  IF task_ref IS NOT NULL THEN
    SELECT project_id, user_id INTO task_project, task_user FROM tasks
      WHERE id = task_ref FOR NO KEY UPDATE;
    IF task_user IS DISTINCT FROM owner_id THEN
      RAISE EXCEPTION 'craft task must belong to the same user' USING ERRCODE = '23503';
    END IF;
    IF TG_TABLE_NAME = 'task_checklist_items' THEN
      project_ref := task_project;
    END IF;
  END IF;

  IF session_ref IS NOT NULL THEN
    SELECT project_id, user_id INTO ref_project, ref_user FROM work_sessions WHERE id = session_ref;
    IF ref_user IS DISTINCT FROM owner_id THEN
      RAISE EXCEPTION 'craft session must belong to the same user' USING ERRCODE = '23503';
    END IF;
    IF project_ref IS NULL THEN project_ref := ref_project; END IF;
    IF project_ref IS DISTINCT FROM ref_project THEN
      RAISE EXCEPTION 'craft session must belong to the same project' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF part_ref IS NOT NULL THEN
    SELECT project_id, user_id INTO ref_project, ref_user FROM craft_parts WHERE id = part_ref;
    IF ref_user IS DISTINCT FROM owner_id THEN
      RAISE EXCEPTION 'craft part must belong to the same user' USING ERRCODE = '23503';
    END IF;
    IF project_ref IS NULL AND TG_TABLE_NAME <> 'task_checklist_items' THEN project_ref := ref_project; END IF;
    IF project_ref IS DISTINCT FROM ref_project THEN
      RAISE EXCEPTION 'craft part must belong to the same project' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF task_ref IS NOT NULL AND task_project IS DISTINCT FROM project_ref THEN
    RAISE EXCEPTION 'craft task must belong to the same project' USING ERRCODE = '23503';
  END IF;

  IF (r->>'segment_id') IS NOT NULL THEN
    SELECT p.project_id, s.user_id INTO ref_project, ref_user
      FROM craft_segments s JOIN craft_parts p ON p.id = s.part_id WHERE s.id = (r->>'segment_id')::uuid;
    IF ref_user IS DISTINCT FROM owner_id OR ref_project IS DISTINCT FROM project_ref THEN
      RAISE EXCEPTION 'craft segment must belong to the same user and project' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF (r->>'link_id') IS NOT NULL THEN
    SELECT project_id, user_id INTO ref_project, ref_user FROM craft_links WHERE id = (r->>'link_id')::uuid;
    IF ref_user IS DISTINCT FROM owner_id OR ref_project IS DISTINCT FROM project_ref THEN
      RAISE EXCEPTION 'craft link must belong to the same user and project' USING ERRCODE = '23503';
    END IF;
  END IF;
  -- During a project CASCADE, optional links are nulled after the project has
  -- disappeared. Let that referential cleanup finish (same exception as 059).
  IF project_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id = project_ref AND user_id = owner_id) THEN
    IF TG_OP <> 'UPDATE' OR EXISTS (SELECT 1 FROM projects WHERE id = project_ref) THEN
      RAISE EXCEPTION 'craft project must belong to the same user' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- SET NULL must clear the paired row number as well, before the pair CHECK.
CREATE FUNCTION craft_checklist_ownership()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.craft_part_id IS NULL AND OLD.craft_part_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM craft_parts WHERE id = OLD.craft_part_id) THEN
    NEW.craft_row := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_checklist_craft_cleanup BEFORE UPDATE OF craft_part_id ON task_checklist_items
  FOR EACH ROW EXECUTE FUNCTION craft_checklist_ownership();
CREATE TRIGGER trg_checklist_craft_ownership BEFORE INSERT OR UPDATE OF user_id, task_id, craft_part_id, craft_row ON task_checklist_items
  FOR EACH ROW WHEN (NEW.craft_part_id IS NOT NULL) EXECUTE FUNCTION craft_check_ownership();

CREATE FUNCTION tasks_guard_project_move_with_craft()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NEW; END IF;
  IF NEW.project_id IS NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM task_checklist_items WHERE task_id = OLD.id AND craft_part_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM craft_segments WHERE task_id = OLD.id) THEN
    RAISE EXCEPTION 'This task has craft rows in its project; remove the craft links before moving it'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tasks_guard_project_move_craft BEFORE UPDATE OF project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_guard_project_move_with_craft();

ALTER TABLE craft_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_projects" ON craft_projects FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_projects" ON craft_projects FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_projects" ON craft_projects FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_projects" ON craft_projects FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_projects TO authenticated, service_role;
CREATE TRIGGER trg_craft_projects_updated BEFORE UPDATE ON craft_projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_projects_ownership BEFORE INSERT OR UPDATE ON craft_projects FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_parts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_parts" ON craft_parts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_parts" ON craft_parts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_parts" ON craft_parts FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_parts" ON craft_parts FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_parts TO authenticated, service_role;
CREATE TRIGGER trg_craft_parts_updated BEFORE UPDATE ON craft_parts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_parts_ownership BEFORE INSERT OR UPDATE ON craft_parts FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_segments" ON craft_segments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_segments" ON craft_segments FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_segments" ON craft_segments FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_segments" ON craft_segments FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_segments TO authenticated, service_role;
CREATE TRIGGER trg_craft_segments_updated BEFORE UPDATE ON craft_segments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_segments_ownership BEFORE INSERT OR UPDATE ON craft_segments FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_timers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_timers" ON craft_timers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_timers" ON craft_timers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_timers" ON craft_timers FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_timers" ON craft_timers FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_timers TO authenticated, service_role;
CREATE TRIGGER trg_craft_timers_updated BEFORE UPDATE ON craft_timers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_timers_ownership BEFORE INSERT OR UPDATE ON craft_timers FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_sitting_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_sitting_details" ON craft_sitting_details FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_sitting_details" ON craft_sitting_details FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_sitting_details" ON craft_sitting_details FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_sitting_details" ON craft_sitting_details FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_sitting_details TO authenticated, service_role;
CREATE TRIGGER trg_craft_sitting_details_updated BEFORE UPDATE ON craft_sitting_details FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_sitting_details_ownership BEFORE INSERT OR UPDATE ON craft_sitting_details FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_notes" ON craft_notes FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_notes" ON craft_notes FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_notes" ON craft_notes FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_notes" ON craft_notes FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_notes TO authenticated, service_role;
CREATE TRIGGER trg_craft_notes_updated BEFORE UPDATE ON craft_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_notes_ownership BEFORE INSERT OR UPDATE ON craft_notes FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_links" ON craft_links FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_links" ON craft_links FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_links" ON craft_links FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_links" ON craft_links FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_links TO authenticated, service_role;
CREATE TRIGGER trg_craft_links_updated BEFORE UPDATE ON craft_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_links_ownership BEFORE INSERT OR UPDATE ON craft_links FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_instructions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_instructions" ON craft_instructions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_instructions" ON craft_instructions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_instructions" ON craft_instructions FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_instructions" ON craft_instructions FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_instructions TO authenticated, service_role;
CREATE TRIGGER trg_craft_instructions_updated BEFORE UPDATE ON craft_instructions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_instructions_ownership BEFORE INSERT OR UPDATE ON craft_instructions FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
ALTER TABLE craft_yarns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own craft_yarns" ON craft_yarns FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own craft_yarns" ON craft_yarns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own craft_yarns" ON craft_yarns FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own craft_yarns" ON craft_yarns FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON craft_yarns TO authenticated, service_role;
CREATE TRIGGER trg_craft_yarns_updated BEFORE UPDATE ON craft_yarns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_craft_yarns_ownership BEFORE INSERT OR UPDATE ON craft_yarns FOR EACH ROW EXECUTE FUNCTION craft_check_ownership();
CREATE INDEX idx_craft_parts_project ON craft_parts(project_id);
CREATE INDEX idx_craft_timers_project ON craft_timers(project_id);
CREATE INDEX idx_craft_notes_project ON craft_notes(project_id);
CREATE INDEX idx_craft_links_project ON craft_links(project_id);
CREATE INDEX idx_craft_yarns_project ON craft_yarns(project_id);
CREATE INDEX idx_craft_segments_part ON craft_segments(part_id);
CREATE INDEX idx_craft_sitting_details_part ON craft_sitting_details(part_id);
CREATE INDEX idx_craft_instructions_part ON craft_instructions(part_id);
CREATE INDEX idx_craft_segments_task ON craft_segments(task_id);
COMMIT;
NOTIFY pgrst, 'reload schema';
