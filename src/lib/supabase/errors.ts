import type { PostgrestError } from '@supabase/supabase-js';

/**
 * True when a PostgREST error means "zero rows matched" (e.g. `.single()` on no
 * match) rather than a real failure. Routes must only translate this case into
 * a 404 — transient errors (timeouts, connection resets) must surface as 500s
 * so callers know to retry instead of treating the record as missing.
 */
export function isPostgrestNotFound(
  error: Pick<PostgrestError, 'code'> | null | undefined
): boolean {
  return error?.code === 'PGRST116';
}
