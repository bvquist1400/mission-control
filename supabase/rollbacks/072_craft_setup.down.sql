-- Removes only 072: the setup/remove functions, and gives back the table rights 072 took
-- away, exactly as 071 left them. Craft rows already set up stay. Roll the app back first.
--
-- What 071 left: 071 creates the nine tables, revokes everything from anon and PUBLIC and
-- grants SELECT, INSERT, UPDATE, DELETE to authenticated and service_role. Anything else a
-- role had came from the default privileges of the role that created the tables (the
-- table owner) in schema public. On hosted, per the S1 ship read-back, authenticated and
-- service_role had TRUNCATE, REFERENCES, TRIGGER and MAINTAIN that way; on the local test
-- stack the owner's defaults give them the same. So for each table, each of the two roles
-- gets back only those of the four rights 072 revoked that the owner's default privileges
-- (pg_default_acl for tables, schema public or global) give it, which is what a fresh 071
-- apply leaves; a role whose defaults never had a right does not get it.
BEGIN;
SET LOCAL lock_timeout = '10s';
DROP FUNCTION craft_remove_project(UUID, UUID);
DROP FUNCTION craft_remove_blockers(UUID, UUID);
DROP FUNCTION craft_setup_project(UUID, UUID, JSONB, TEXT);
DROP FUNCTION craft_setup_plan(UUID, UUID);
DROP FUNCTION craft_setup_lock(UUID, UUID);
DROP FUNCTION craft_setup_fingerprint(UUID, UUID);
DO $$
DECLARE
  v RECORD;
BEGIN
  FOR v IN
    SELECT c.relname, r.rolname, p.privilege
    FROM pg_class c
    CROSS JOIN pg_roles r
    CROSS JOIN unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']
      || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE '{}'::text[] END) AS p(privilege)
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND c.relname IN ('craft_projects', 'craft_parts', 'craft_segments', 'craft_timers', 'craft_sitting_details',
        'craft_notes', 'craft_links', 'craft_instructions', 'craft_yarns')
      AND r.rolname IN ('authenticated', 'service_role')
      AND EXISTS (
        SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
        WHERE d.defaclrole = c.relowner AND d.defaclobjtype = 'r'
          AND d.defaclnamespace IN (0, 'public'::regnamespace)
          AND a.grantee = r.oid AND a.privilege_type = p.privilege)
    ORDER BY c.relname, r.rolname, p.privilege
  LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', v.privilege, v.relname, v.rolname);
  END LOOP;
END;
$$;
COMMIT;
NOTIFY pgrst, 'reload schema';
