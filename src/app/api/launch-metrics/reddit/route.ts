import { NextRequest } from 'next/server';
import { parseRedditInput } from '@/lib/launch-metrics/manual';
import { dbErrorReply, launchReply, readJsonBody, requireLaunchSession } from '@/lib/launch-metrics/route-session';

export const dynamic = 'force-dynamic';

/** Add a Reddit post (label, subreddit, posted_at; optional views/upvotes/comments). */
export async function POST(request: NextRequest) {
  const auth = await requireLaunchSession(request);
  if (!auth.context) {
    return auth.response;
  }
  const parsed = parseRedditInput(await readJsonBody(request), new Date(), false);
  if (!parsed.ok) {
    return launchReply(request, { error: parsed.error }, 400);
  }
  const { supabase, userId } = auth.context;
  const input = parsed.value;
  if (!input.label || !input.subreddit || !input.posted_at) {
    return launchReply(request, { error: 'label, subreddit and posted_at are required' }, 400);
  }
  const { data, error } = await supabase
    .from('launch_reddit_posts')
    .insert({
      user_id: userId,
      label: input.label,
      subreddit: input.subreddit,
      posted_at: input.posted_at,
      views: input.views ?? null,
      upvotes: input.upvotes ?? null,
      comments: input.comments ?? null,
      stats_as_of: input.stats_as_of ?? null,
    })
    .select('*')
    .single();
  if (error) {
    return dbErrorReply(request, error, 'That post is already on the list');
  }
  return launchReply(request, { post: data }, 201);
}
