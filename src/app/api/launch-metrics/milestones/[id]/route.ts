import { NextRequest } from 'next/server';
import { parseMilestoneInput } from '@/lib/launch-metrics/manual';
import { dbErrorReply, isUuid, launchReply, readJsonBody, requireLaunchSession } from '@/lib/launch-metrics/route-session';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Fix a timeline event (allowlisted fields only). */
export async function PATCH(request: NextRequest, { params }: Context) {
  const auth = await requireLaunchSession(request);
  if (!auth.context) {
    return auth.response;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return launchReply(request, { error: 'Not found' }, 404);
  }
  const parsed = parseMilestoneInput(await readJsonBody(request), new Date(), true);
  if (!parsed.ok) {
    return launchReply(request, { error: parsed.error }, 400);
  }
  const { supabase, userId } = auth.context;
  const { data, error } = await supabase
    .from('launch_milestones')
    .update(parsed.value)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error) {
    return dbErrorReply(request, error, 'That event is already on the timeline');
  }
  return launchReply(request, { milestone: data });
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const auth = await requireLaunchSession(request);
  if (!auth.context) {
    return auth.response;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return launchReply(request, { error: 'Not found' }, 404);
  }
  const { supabase, userId } = auth.context;
  const { data, error } = await supabase.from('launch_milestones').delete().eq('id', id).eq('user_id', userId).select('id');
  if (error) {
    return dbErrorReply(request, error, '');
  }
  if (!data || data.length === 0) {
    return launchReply(request, { error: 'Not found' }, 404);
  }
  return launchReply(request, { deleted: id });
}
