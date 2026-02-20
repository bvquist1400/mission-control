-- CRM: Stakeholders & Commitments
-- Adds first-class stakeholder contacts and commitment tracking

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE commitment_status AS ENUM ('Open', 'Done', 'Dropped');
CREATE TYPE commitment_direction AS ENUM ('ours', 'theirs');

-- ============================================
-- TABLES
-- ============================================

-- Stakeholders: People you work with
CREATE TABLE stakeholders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT,            -- e.g. 'Product Owner', 'VP Engineering', 'Vendor PM'
  organization TEXT,    -- e.g. 'Acme Corp', 'Internal - Finance'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Commitments: Promises made to or by stakeholders
CREATE TABLE commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  stakeholder_id UUID NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  direction commitment_direction NOT NULL DEFAULT 'ours',
  status commitment_status NOT NULL DEFAULT 'Open',
  due_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_stakeholders_user ON stakeholders(user_id);
CREATE INDEX idx_stakeholders_user_name ON stakeholders(user_id, name);

CREATE INDEX idx_commitments_user ON commitments(user_id);
CREATE INDEX idx_commitments_stakeholder ON commitments(stakeholder_id);
CREATE INDEX idx_commitments_task ON commitments(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_commitments_user_status ON commitments(user_id, status);
CREATE INDEX idx_commitments_user_due ON commitments(user_id, due_at) WHERE due_at IS NOT NULL AND status = 'Open';

-- ============================================
-- TRIGGERS
-- ============================================

CREATE TRIGGER trg_stakeholders_updated
  BEFORE UPDATE ON stakeholders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_commitments_updated
  BEFORE UPDATE ON commitments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;

-- Stakeholder policies
CREATE POLICY "Users can view own stakeholders"
  ON stakeholders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own stakeholders"
  ON stakeholders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own stakeholders"
  ON stakeholders FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own stakeholders"
  ON stakeholders FOR DELETE
  USING (auth.uid() = user_id);

-- Commitment policies
CREATE POLICY "Users can view own commitments"
  ON commitments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own commitments"
  ON commitments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own commitments"
  ON commitments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own commitments"
  ON commitments FOR DELETE
  USING (auth.uid() = user_id);
