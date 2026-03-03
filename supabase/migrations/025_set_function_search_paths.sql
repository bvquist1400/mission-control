-- Pin function search_path to avoid role-mutable lookup during execution.
BEGIN;

ALTER FUNCTION public.get_blocking_tasks(uuid)
  SET search_path = public;

ALTER FUNCTION public.get_blocked_by_tasks(uuid)
  SET search_path = public;

ALTER FUNCTION public.prune_llm_usage_events(interval)
  SET search_path = public;

ALTER FUNCTION public.sync_today_tasks(uuid, uuid[], date)
  SET search_path = public;

ALTER FUNCTION public.set_updated_at()
  SET search_path = public;

ALTER FUNCTION public.get_implementation_with_stats(uuid)
  SET search_path = public;

ALTER FUNCTION public.get_today_tasks(uuid)
  SET search_path = public;

COMMIT;
