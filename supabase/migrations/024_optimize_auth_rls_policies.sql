-- Cache auth helper calls once per statement instead of once per row in RLS policies.
BEGIN;

DO $$
DECLARE
  policy_row record;
  updated_qual text;
  updated_with_check text;
  alter_sql text;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        coalesce(qual, '') LIKE '%auth.uid()%'
        OR coalesce(with_check, '') LIKE '%auth.uid()%'
        OR coalesce(qual, '') LIKE '%auth.role()%'
        OR coalesce(with_check, '') LIKE '%auth.role()%'
      )
  LOOP
    updated_qual := policy_row.qual;
    updated_with_check := policy_row.with_check;

    IF updated_qual IS NOT NULL THEN
      IF position('(select auth.uid())' IN updated_qual) = 0 THEN
        updated_qual := replace(updated_qual, 'auth.uid()', '(select auth.uid())');
      END IF;

      IF position('(select auth.role())' IN updated_qual) = 0 THEN
        updated_qual := replace(updated_qual, 'auth.role()', '(select auth.role())');
      END IF;
    END IF;

    IF updated_with_check IS NOT NULL THEN
      IF position('(select auth.uid())' IN updated_with_check) = 0 THEN
        updated_with_check := replace(updated_with_check, 'auth.uid()', '(select auth.uid())');
      END IF;

      IF position('(select auth.role())' IN updated_with_check) = 0 THEN
        updated_with_check := replace(updated_with_check, 'auth.role()', '(select auth.role())');
      END IF;
    END IF;

    IF updated_qual IS DISTINCT FROM policy_row.qual
       OR updated_with_check IS DISTINCT FROM policy_row.with_check THEN
      alter_sql := format(
        'ALTER POLICY %I ON %I.%I',
        policy_row.policyname,
        policy_row.schemaname,
        policy_row.tablename
      );

      IF updated_qual IS NOT NULL THEN
        alter_sql := alter_sql || format(' USING (%s)', updated_qual);
      END IF;

      IF updated_with_check IS NOT NULL THEN
        alter_sql := alter_sql || format(' WITH CHECK (%s)', updated_with_check);
      END IF;

      EXECUTE alter_sql;
    END IF;
  END LOOP;
END
$$;

COMMIT;
