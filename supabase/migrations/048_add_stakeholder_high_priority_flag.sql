-- Migration 048: move high-priority stakeholder flagging into data
--
-- src/lib/priority.ts hardcoded a HIGH_PRIORITY_STAKEHOLDERS name list
-- ('nancy', 'heath'). Moving it onto the stakeholders table lets it be
-- managed per-user via the UI/API/MCP instead of a code deploy.

BEGIN;

ALTER TABLE stakeholders ADD COLUMN is_high_priority BOOLEAN NOT NULL DEFAULT false;

UPDATE stakeholders
SET is_high_priority = true
WHERE lower(name) LIKE '%nancy%' OR lower(name) LIKE '%heath%';

COMMIT;
