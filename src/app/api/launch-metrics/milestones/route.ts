import { NextRequest } from 'next/server';
import { parseMilestoneInput } from '@/lib/launch-metrics/manual';
import { dbErrorReply, launchReply, readJsonBody, requireLaunchSession } from '@/lib/launch-metrics/route-session';

export const dynamic = 'force-dynamic';

/** Add a launch timeline event (happened_at, label, kind). */
export async function POST(request: NextRequest) {
  const auth = await requireLaunchSession(request);
  if (!auth.context) {
    return auth.response;
  }
  const parsed = parseMilestoneInput(await readJsonBody(request), new Date(), false);
  if (!parsed.ok) {
    return launchReply(request, { error: parsed.error }, 400);
  }
  const { supabase, userId } = auth.context;
  const input = parsed.value;
  if (!input.label || !input.happened_at || !input.kind) {
    return launchReply(request, { error: 'happened_at, label and kind are required' }, 400);
  }
  const { data, error } = await supabase
    .from('launch_milestones')
    .insert({ user_id: userId, happened_at: input.happened_at, label: input.label, kind: input.kind })
    .select('*')
    .single();
  if (error) {
    return dbErrorReply(request, error, 'That event is already on the timeline');
  }
  return launchReply(request, { milestone: data }, 201);
}
