-- Focus + Planner schema for Mission Control Brain v1.1

-- ============================================
-- IMPLEMENTATIONS: baseline ranking
-- ============================================

ALTER TABLE implementations
  ADD COLUMN IF NOT EXISTS priority_weight INT NOT NULL DEFAULT 5 CHECK (priority_weight BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS priority_note TEXT;

-- ============================================
-- FOCUS DIRECTIVES
-- ============================================

CREATE TABLE IF NOT EXISTS focus_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,

  text TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('implementation', 'stakeholder', 'task_type', 'query')),
  scope_id UUID NULL REFERENCES implementations(id) ON DELETE SET NULL,
  scope_value TEXT NULL,
  strength TEXT NOT NULL DEFAULT 'strong' CHECK (strength IN ('nudge', 'strong', 'hard')),
  starts_at TIMESTAMPTZ NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NULL,
  reason TEXT NULL,

  CONSTRAINT focus_directives_time_window_valid
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CONSTRAINT focus_directives_scope_consistency
    CHECK (
      (scope_type = 'implementation' AND scope_id IS NOT NULL)
      OR (scope_type <> 'implementation')
    )
);

CREATE INDEX IF NOT EXISTS idx_focus_directives_created_by_active
  ON focus_directives(created_by, is_active, created_at DESC);

-- MVP guardrail: one active directive per user
CREATE UNIQUE INDEX IF NOT EXISTS uniq_focus_directives_one_active_per_user
  ON focus_directives(created_by)
  WHERE is_active = true;

-- ============================================
-- PLANS
-- ============================================

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'planner_v1',
  inputs_snapshot JSONB NOT NULL,
  plan_json JSONB NOT NULL,
  reasons_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'dismissed')),
  applied_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_created_by_date_created_at
  ON plans(created_by, plan_date, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plans_created_by_status_created_at
  ON plans(created_by, status, created_at DESC);

-- ============================================
-- RLS
-- ============================================

ALTER TABLE focus_directives ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own focus_directives"
  ON focus_directives FOR SELECT
  USING (auth.uid() = created_by);

CREATE POLICY "Users can insert own focus_directives"
  ON focus_directives FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own focus_directives"
  ON focus_directives FOR UPDATE
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can delete own focus_directives"
  ON focus_directives FOR DELETE
  USING (auth.uid() = created_by);

CREATE POLICY "Users can view own plans"
  ON plans FOR SELECT
  USING (auth.uid() = created_by);

CREATE POLICY "Users can insert own plans"
  ON plans FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own plans"
  ON plans FOR UPDATE
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can delete own plans"
  ON plans FOR DELETE
  USING (auth.uid() = created_by);
