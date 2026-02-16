-- Task Comments and Dependencies Schema
-- Adds task-level comments and task-to-task blocking relationships

-- ============================================
-- TABLES
-- ============================================

-- Task comments (flat, chronological like Asana)
CREATE TABLE task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'system', 'llm'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Task dependencies (blocking relationships)
-- blocked_task_id is blocked BY blocker_task_id
-- (blocker_task_id must be completed before blocked_task_id can proceed)
CREATE TABLE task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  blocker_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_dependency CHECK (blocker_task_id != blocked_task_id),
  CONSTRAINT unique_dependency UNIQUE (blocker_task_id, blocked_task_id)
);

-- ============================================
-- INDEXES
-- ============================================

-- Comments: fetch all comments for a task, ordered by time
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at DESC);
CREATE INDEX idx_task_comments_user ON task_comments(user_id);

-- Dependencies: find what blocks a task, and what a task blocks
CREATE INDEX idx_task_dependencies_blocked ON task_dependencies(blocked_task_id);
CREATE INDEX idx_task_dependencies_blocker ON task_dependencies(blocker_task_id);
CREATE INDEX idx_task_dependencies_user ON task_dependencies(user_id);

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at for comments
CREATE TRIGGER trg_task_comments_updated
  BEFORE UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;

-- Task comments policies
CREATE POLICY "Users can view own task_comments"
  ON task_comments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own task_comments"
  ON task_comments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own task_comments"
  ON task_comments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own task_comments"
  ON task_comments FOR DELETE
  USING (auth.uid() = user_id);

-- Task dependencies policies
CREATE POLICY "Users can view own task_dependencies"
  ON task_dependencies FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own task_dependencies"
  ON task_dependencies FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own task_dependencies"
  ON task_dependencies FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Get all tasks blocking a given task (with task details)
CREATE OR REPLACE FUNCTION get_blocking_tasks(p_task_id UUID)
RETURNS TABLE (
  dependency_id UUID,
  task_id UUID,
  title TEXT,
  status task_status,
  blocker BOOLEAN,
  implementation_id UUID,
  implementation_name TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    d.id AS dependency_id,
    t.id AS task_id,
    t.title,
    t.status,
    t.blocker,
    t.implementation_id,
    i.name AS implementation_name
  FROM task_dependencies d
  JOIN tasks t ON t.id = d.blocker_task_id
  LEFT JOIN implementations i ON i.id = t.implementation_id
  WHERE d.blocked_task_id = p_task_id
  ORDER BY t.priority_score DESC;
$$;

-- Get all tasks that a given task is blocking
CREATE OR REPLACE FUNCTION get_blocked_by_tasks(p_task_id UUID)
RETURNS TABLE (
  dependency_id UUID,
  task_id UUID,
  title TEXT,
  status task_status,
  blocker BOOLEAN,
  implementation_id UUID,
  implementation_name TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    d.id AS dependency_id,
    t.id AS task_id,
    t.title,
    t.status,
    t.blocker,
    t.implementation_id,
    i.name AS implementation_name
  FROM task_dependencies d
  JOIN tasks t ON t.id = d.blocked_task_id
  LEFT JOIN implementations i ON i.id = t.implementation_id
  WHERE d.blocker_task_id = p_task_id
  ORDER BY t.priority_score DESC;
$$;
