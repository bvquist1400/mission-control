import { NextRequest, NextResponse } from 'next/server';
import { normalizeDateOnly } from '@/lib/briefing/review-snapshots';
import { requireAuthenticatedRoute } from '@/lib/supabase/route-auth';
import type { ProjectStatusUpdatePayload, RagStatus } from '@/types/database';

const RAG_STATUS_VALUES: RagStatus[] = ['Green', 'Yellow', 'Red'];

function getTodayETDateOnly(): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function asTrimmedString(value: unknown, maxLength: number, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer`);
  }

  return trimmed;
}

function asTrimmedStringArray(value: unknown, fieldName: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  const normalized = value
    .map((item) => {
      if (typeof item !== 'string') {
        throw new Error(`${fieldName} must contain only strings`);
      }

      const trimmed = item.trim();
      if (trimmed.length === 0) {
        return null;
      }

      if (trimmed.length > maxLength) {
        throw new Error(`${fieldName} items must be ${maxLength} characters or fewer`);
      }

      return trimmed;
    })
    .filter((item): item is string => Boolean(item));

  if (normalized.length > maxItems) {
    throw new Error(`${fieldName} must contain ${maxItems} items or fewer`);
  }

  return normalized;
}

function normalizeRagStatus(value: unknown): RagStatus | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string' || !RAG_STATUS_VALUES.includes(value as RagStatus)) {
    throw new Error(`rag must be one of: ${RAG_STATUS_VALUES.join(', ')}`);
  }

  return value as RagStatus;
}

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// GET /api/project-status-updates - List stored project status snapshots
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('project_id');
    const implementationId = searchParams.get('implementation_id');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const rawLimit = Number.parseInt(searchParams.get('limit') || '30', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 30;

    if (from && !normalizeDateOnly(from)) {
      return NextResponse.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
    }

    if (to && !normalizeDateOnly(to)) {
      return NextResponse.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
    }

    if (from && to && from > to) {
      return NextResponse.json({ error: 'from must be on or before to' }, { status: 400 });
    }

    let query = supabase
      .from('project_status_updates')
      .select('*, project:projects(id, name), implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .eq('user_id', userId)
      .order('captured_for_date', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    if (implementationId) {
      query = query.eq('implementation_id', implementationId);
    }

    if (from) {
      query = query.gte('captured_for_date', from);
    }

    if (to) {
      query = query.lte('captured_for_date', to);
    }

    const { data, error } = await query;
    if (error) {
      throw error;
    }

    return NextResponse.json(data || []);
  } catch (error) {
    console.error('Error fetching project status updates:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/project-status-updates - Upsert a daily project status snapshot
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedRoute(request);
    if (auth.response || !auth.context) {
      return auth.response as NextResponse;
    }

    const { supabase, userId } = auth.context;
    const body = (await request.json()) as Partial<ProjectStatusUpdatePayload>;
    const projectId = asTrimmedString(body.project_id, 120, 'project_id');

    if (!projectId) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
    }

    const summary = asTrimmedString(body.summary, 2000, 'summary');
    if (!summary) {
      return NextResponse.json({ error: 'summary is required' }, { status: 400 });
    }

    const capturedForDate = body.captured_for_date
      ? normalizeDateOnly(body.captured_for_date)
      : getTodayETDateOnly();

    if (!capturedForDate) {
      return NextResponse.json({ error: 'captured_for_date must be YYYY-MM-DD' }, { status: 400 });
    }

    let rag: RagStatus | null = null;
    let changesToday: string[] = [];
    let blockers: string[] = [];
    let nextStep: string | null = null;
    let needsDecision: string | null = null;
    let relatedTaskIds: string[] = [];
    let source = 'system';
    let model: string | null = null;
    let payload: Record<string, unknown> | null = null;

    try {
      rag = normalizeRagStatus(body.rag);
      changesToday = asTrimmedStringArray(body.changes_today, 'changes_today', 12, 400);
      blockers = asTrimmedStringArray(body.blockers, 'blockers', 12, 400);
      nextStep = asTrimmedString(body.next_step, 1000, 'next_step');
      needsDecision = asTrimmedString(body.needs_decision, 1000, 'needs_decision');
      relatedTaskIds = asTrimmedStringArray(body.related_task_ids, 'related_task_ids', 50, 120);
      source = asTrimmedString(body.source, 50, 'source') ?? 'system';
      model = asTrimmedString(body.model, 120, 'model');
    } catch (validationError) {
      return NextResponse.json({ error: (validationError as Error).message }, { status: 400 });
    }

    if (body.payload !== undefined && body.payload !== null) {
      if (!isObjectPayload(body.payload)) {
        return NextResponse.json({ error: 'payload must be an object when provided' }, { status: 400 });
      }
      payload = body.payload;
    }

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, implementation_id')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'project_id is invalid' }, { status: 400 });
    }

    const { data: update, error: upsertError } = await supabase
      .from('project_status_updates')
      .upsert(
        {
          user_id: userId,
          project_id: projectId,
          implementation_id: project.implementation_id,
          captured_for_date: capturedForDate,
          summary,
          rag,
          changes_today: changesToday,
          blockers,
          next_step: nextStep,
          needs_decision: needsDecision,
          related_task_ids: relatedTaskIds,
          source,
          model,
          payload,
        },
        { onConflict: 'user_id,project_id,captured_for_date' }
      )
      .select('*, project:projects(id, name), implementation:implementations(id, name, phase, rag, portfolio_rank)')
      .single();

    if (upsertError) {
      throw upsertError;
    }

    const shouldSyncProjectStatus = body.sync_project_status_summary !== false;
    let projectSync: { id: string; name: string; rag: RagStatus; status_summary: string } | null = null;

    if (shouldSyncProjectStatus) {
      const projectUpdates: { status_summary: string; rag?: RagStatus | null } = { status_summary: summary };
      if (body.rag !== undefined) {
        projectUpdates.rag = rag;
      }

      const { data: syncedProject, error: syncError } = await supabase
        .from('projects')
        .update(projectUpdates)
        .eq('id', projectId)
        .eq('user_id', userId)
        .select('id, name, rag, status_summary')
        .single();

      if (syncError) {
        throw syncError;
      }

      projectSync = syncedProject;
    }

    return NextResponse.json({
      update,
      project_sync: projectSync,
    });
  } catch (error) {
    console.error('Error saving project status update:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
