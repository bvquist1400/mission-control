-- Add generic "Task" option to task_type enum
ALTER TYPE task_type ADD VALUE IF NOT EXISTS 'Task';
