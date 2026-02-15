-- Mission Control MVP Schema
-- Run this in your Supabase SQL editor

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE task_status AS ENUM ('Next', 'Scheduled', 'Waiting', 'Done');
CREATE TYPE task_type AS ENUM ('Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build');
CREATE TYPE impl_phase AS ENUM ('Intake', 'Discovery', 'Design', 'Build', 'Test', 'Training', 'GoLive', 'Hypercare');
CREATE TYPE rag_status AS ENUM ('Green', 'Yellow', 'Red');
CREATE TYPE estimate_source AS ENUM ('default', 'llm', 'manual');

-- ============================================
-- TABLES
-- ============================================

-- Implementations (projects/apps being tracked)
CREATE TABLE implementations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  phase impl_phase NOT NULL DEFAULT 'Intake',
  rag rag_status NOT NULL DEFAULT 'Green',
  target_date DATE,
  status_summary TEXT NOT NULL DEFAULT '',
  next_milestone TEXT NOT NULL DEFAULT '',
  next_milestone_date DATE,
  stakeholders TEXT[] NOT NULL DEFAULT '{}',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbox items (email metadata only - no body content stored)
CREATE TABLE inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  from_name TEXT,
  from_email TEXT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL,  -- 'ActionIntakeEmail', 'ServiceNowEmail', 'Manual'
  source_message_id TEXT,
  source_url TEXT,
  dedupe_key TEXT UNIQUE,
  triage_state TEXT NOT NULL DEFAULT 'New',  -- 'New', 'Processed', 'Ignored'
  llm_extraction_json JSONB,
  extraction_version INT NOT NULL DEFAULT 1,
  extraction_model TEXT,
  extraction_confidence NUMERIC,
  processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  implementation_id UUID REFERENCES implementations(id) ON DELETE SET NULL,
  status task_status NOT NULL DEFAULT 'Next',
  task_type task_type NOT NULL DEFAULT 'Admin',
  priority_score INT NOT NULL DEFAULT 50 CHECK (priority_score >= 0 AND priority_score <= 100),
  estimated_minutes INT NOT NULL DEFAULT 30,
  estimate_source estimate_source NOT NULL DEFAULT 'default',
  due_at TIMESTAMPTZ,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  blocker BOOLEAN NOT NULL DEFAULT false,
  waiting_on TEXT,
  follow_up_at TIMESTAMPTZ,
  stakeholder_mentions TEXT[] NOT NULL DEFAULT '{}',
  source_type TEXT NOT NULL DEFAULT 'Email',  -- 'Email', 'ServiceNow', 'Jira', 'Manual'
  source_url TEXT,
  inbox_item_id UUID REFERENCES inbox_items(id) ON DELETE SET NULL,
  pinned_excerpt TEXT,  -- Manual paste only, clearly labeled in UI
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Task checklist items
CREATE TABLE task_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0
);

-- Status updates (for implementations)
CREATE TABLE status_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  implementation_id UUID NOT NULL REFERENCES implementations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  update_text TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'Brent',  -- 'Brent' or 'Assistant'
  related_task_ids UUID[] NOT NULL DEFAULT '{}'
);

-- Ingestion events (debugging/audit log)
CREATE TABLE ingestion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  inbox_item_id UUID REFERENCES inbox_items(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,  -- 'received', 'deduped', 'extracted', 'task_created'
  ok BOOLEAN NOT NULL DEFAULT true,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

-- Tasks indexes for common queries
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_user_needs_review ON tasks(user_id, needs_review) WHERE needs_review = true;
CREATE INDEX idx_tasks_user_due ON tasks(user_id, due_at) WHERE due_at IS NOT NULL;
CREATE INDEX idx_tasks_user_implementation ON tasks(user_id, implementation_id);
CREATE INDEX idx_tasks_user_blocker ON tasks(user_id, blocker) WHERE blocker = true;
CREATE INDEX idx_tasks_priority ON tasks(user_id, priority_score DESC);

-- Inbox items indexes
CREATE INDEX idx_inbox_items_user_triage ON inbox_items(user_id, triage_state);
CREATE INDEX idx_inbox_items_dedupe ON inbox_items(dedupe_key);

-- Implementations indexes
CREATE INDEX idx_implementations_user ON implementations(user_id);

-- Status updates indexes
CREATE INDEX idx_status_updates_impl ON status_updates(implementation_id, created_at DESC);

-- Ingestion events indexes
CREATE INDEX idx_ingestion_events_inbox ON ingestion_events(inbox_item_id, created_at DESC);

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_implementations_updated
  BEFORE UPDATE ON implementations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_tasks_updated
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE implementations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own data
-- Note: For single-user MVP, you may want to use service role key and skip auth
-- These policies are ready for multi-user when needed

CREATE POLICY "Users can view own implementations"
  ON implementations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own implementations"
  ON implementations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own implementations"
  ON implementations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own implementations"
  ON implementations FOR DELETE
  USING (auth.uid() = user_id);

-- Inbox items policies
CREATE POLICY "Users can view own inbox_items"
  ON inbox_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own inbox_items"
  ON inbox_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own inbox_items"
  ON inbox_items FOR UPDATE
  USING (auth.uid() = user_id);

-- Tasks policies
CREATE POLICY "Users can view own tasks"
  ON tasks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks"
  ON tasks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
  ON tasks FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
  ON tasks FOR DELETE
  USING (auth.uid() = user_id);

-- Checklist items policies
CREATE POLICY "Users can view own checklist_items"
  ON task_checklist_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own checklist_items"
  ON task_checklist_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own checklist_items"
  ON task_checklist_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own checklist_items"
  ON task_checklist_items FOR DELETE
  USING (auth.uid() = user_id);

-- Status updates policies
CREATE POLICY "Users can view own status_updates"
  ON status_updates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own status_updates"
  ON status_updates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Ingestion events policies
CREATE POLICY "Users can view own ingestion_events"
  ON ingestion_events FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own ingestion_events"
  ON ingestion_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Get implementation with blocker count and next action
CREATE OR REPLACE FUNCTION get_implementation_with_stats(impl_id UUID)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  name TEXT,
  phase impl_phase,
  rag rag_status,
  target_date DATE,
  status_summary TEXT,
  next_milestone TEXT,
  next_milestone_date DATE,
  stakeholders TEXT[],
  keywords TEXT[],
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  blockers_count BIGINT,
  next_action_id UUID,
  next_action_title TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    i.*,
    COALESCE(b.cnt, 0) AS blockers_count,
    t.id AS next_action_id,
    t.title AS next_action_title
  FROM implementations i
  LEFT JOIN (
    SELECT implementation_id, COUNT(*) AS cnt
    FROM tasks
    WHERE blocker = true AND status != 'Done'
    GROUP BY implementation_id
  ) b ON b.implementation_id = i.id
  LEFT JOIN LATERAL (
    SELECT id, title
    FROM tasks
    WHERE implementation_id = i.id AND status != 'Done'
    ORDER BY priority_score DESC
    LIMIT 1
  ) t ON true
  WHERE i.id = impl_id;
$$;

-- Get today's capacity summary
CREATE OR REPLACE FUNCTION get_today_tasks(p_user_id UUID)
RETURNS TABLE (
  task_id UUID,
  title TEXT,
  estimated_minutes INT,
  due_at TIMESTAMPTZ,
  priority_score INT,
  status task_status,
  implementation_name TEXT
) LANGUAGE SQL STABLE AS $$
  SELECT
    t.id,
    t.title,
    t.estimated_minutes,
    t.due_at,
    t.priority_score,
    t.status,
    i.name
  FROM tasks t
  LEFT JOIN implementations i ON i.id = t.implementation_id
  WHERE t.user_id = p_user_id
    AND t.status != 'Done'
    AND (
      t.due_at::date = CURRENT_DATE
      OR t.priority_score >= 80  -- Top priority tasks
    )
  ORDER BY t.priority_score DESC;
$$;
