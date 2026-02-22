-- Application portfolio ranking for drag-and-drop ordering in Applications module

ALTER TABLE implementations
  ADD COLUMN IF NOT EXISTS portfolio_rank INT NOT NULL DEFAULT 1000;

-- Backfill existing applications to a stable per-user order.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY created_at ASC, name ASC, id ASC
    ) AS row_rank
  FROM implementations
)
UPDATE implementations AS i
SET portfolio_rank = ranked.row_rank
FROM ranked
WHERE i.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_implementations_user_portfolio_rank
  ON implementations(user_id, portfolio_rank ASC);
