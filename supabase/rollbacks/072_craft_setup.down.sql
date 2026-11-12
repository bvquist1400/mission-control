-- Removes only 072: the setup/remove functions, and gives the API roles back the
-- table rights 072 took away (the hosted database gives them to new tables by
-- default, so this is the 071 state there). Craft rows already set up stay.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION craft_remove_project(UUID, UUID);
DROP FUNCTION craft_setup_project(UUID, UUID, JSONB, TEXT);
DROP FUNCTION craft_setup_lock(UUID, UUID);
DROP FUNCTION craft_setup_fingerprint(UUID, UUID);
GRANT TRUNCATE, REFERENCES, TRIGGER ON craft_projects, craft_parts, craft_segments, craft_timers, craft_sitting_details,
  craft_notes, craft_links, craft_instructions, craft_yarns TO authenticated, service_role;
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'GRANT MAINTAIN ON craft_projects, craft_parts, craft_segments, craft_timers, craft_sitting_details, '
      'craft_notes, craft_links, craft_instructions, craft_yarns TO authenticated, service_role';
  END IF;
END;
$$;
COMMIT;
NOTIFY pgrst, 'reload schema';
