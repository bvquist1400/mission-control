ALTER TABLE focus_directives
  DROP CONSTRAINT IF EXISTS focus_directives_scope_type_check;

ALTER TABLE focus_directives
  ADD CONSTRAINT focus_directives_scope_type_check
  CHECK (scope_type IN ('implementation', 'project', 'stakeholder', 'task_type', 'query'));
