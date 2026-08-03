-- Preserve unfinished recurring occurrences as a terminal historical outcome
-- without treating them as completed or leaving them in the active backlog.
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'Missed' BEFORE 'Done';
