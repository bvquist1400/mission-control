-- Extended Implementation Lifecycle Phases
-- Adds Steady State and Sundown phases to impl_phase enum.

BEGIN;

ALTER TYPE impl_phase ADD VALUE IF NOT EXISTS 'Steady State' AFTER 'Hypercare';
ALTER TYPE impl_phase ADD VALUE IF NOT EXISTS 'Sundown' AFTER 'Steady State';

COMMIT;
