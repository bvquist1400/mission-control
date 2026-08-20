-- Store durable, user-scoped identities for tasks imported from external systems.
ALTER TABLE tasks
  ADD COLUMN external_source_system TEXT,
  ADD COLUMN external_source_id TEXT;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_external_source_id_requires_system
  CHECK (
    external_source_id IS NULL
    OR (
      NULLIF(BTRIM(external_source_id), '') IS NOT NULL
      AND NULLIF(BTRIM(external_source_system), '') IS NOT NULL
    )
  );

CREATE INDEX idx_tasks_user_external_source
  ON tasks(user_id, external_source_system, external_source_id);

CREATE UNIQUE INDEX uq_tasks_user_external_source_id
  ON tasks(user_id, external_source_system, external_source_id)
  WHERE external_source_id IS NOT NULL;
