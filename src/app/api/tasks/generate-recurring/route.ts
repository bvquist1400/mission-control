import { NextRequest, NextResponse } from 'next/server';
import { generateRecurringTasks } from '@/lib/recurring-task-generator';
import { secureCompare } from '@/lib/secure-compare';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readInternalAuthContext } from '@/lib/supabase/internal-auth';

function isAuthorized(request: NextRequest): boolean {
  if (readInternalAuthContext(request)) {
    return true;
  }

  const cronSecret = process.env.CRON_SECRET;
  const apiKey = process.env.MISSION_CONTROL_API_KEY;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : null;
  const providedApiKey = request.headers.get('x-mission-control-key');

  if (cronSecret && secureCompare(bearerToken, cronSecret)) {
    return true;
  }

  if (apiKey && secureCompare(providedApiKey, apiKey)) {
    return true;
  }

  return false;
}

async function runGeneration(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await generateRecurringTasks(createSupabaseAdminClient());
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error generating recurring tasks:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Vercel invokes this at 04:00 and 05:00 UTC so one run lands at midnight in
// America/New_York across EST/EDT. Setting recurrence for today also generates
// eagerly, and every run catches up any missed scheduled dates.
export async function GET(request: NextRequest) {
  return runGeneration(request);
}

export async function POST(request: NextRequest) {
  return runGeneration(request);
}
