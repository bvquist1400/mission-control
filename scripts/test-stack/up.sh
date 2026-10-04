#!/usr/bin/env bash
# Starts the private LOCAL Supabase stack for the DB test suites (project mc-pace,
# API 58321 / DB 58322), applies every migration in supabase/migrations, grants
# the pre-055 tables to the API roles (a fresh stack doesn't; production does),
# and writes the keys to scripts/test-stack/.env.local (git-ignored, never printed).
#
#   bash scripts/test-stack/up.sh        # then: set -a; . scripts/test-stack/.env.local; set +a
#   bash scripts/test-stack/down.sh      # stop and delete it (containers + volumes)
#
# Only images already pulled for the installed Supabase CLI are used: realtime,
# studio, storage, mail, edge runtime, analytics and the pooler are disabled.
# Never touches any other project's stack (e.g. pantry-local) and never links to production.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
container=supabase_db_mc-pace

supabase start --workdir "$here"

docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
-- test:briefs-review-db expects production's anon table grants on the brief tables (RLS still denies rows).
GRANT SELECT, INSERT, UPDATE, DELETE ON briefs, brief_items TO anon;
NOTIFY pgrst, 'reload schema';
SQL

supabase status -o env --workdir "$here" 2>/dev/null > "$here/.env.local.raw"
{
  grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=' "$here/.env.local.raw" | sed -E 's/^API_URL=/STACK_API_URL=/; s/^ANON_KEY=/STACK_ANON_KEY=/; s/^SERVICE_ROLE_KEY=/STACK_SERVICE_ROLE_KEY=/'
  echo "STACK_DB_CONTAINER=$container"
} > "$here/.env.local"
rm -f "$here/.env.local.raw"
echo "mc-pace is up. Keys are in scripts/test-stack/.env.local (STACK_API_URL, STACK_ANON_KEY, STACK_SERVICE_ROLE_KEY, STACK_DB_CONTAINER)."
