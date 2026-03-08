import { NextRequest, NextResponse } from 'next/server';
import * as applicationsRoute from '@/app/api/applications/route';
import * as applicationRoute from '@/app/api/applications/[id]/route';
import * as applicationHealthRoute from '@/app/api/applications/health-scores/route';
import * as briefingRoute from '@/app/api/briefing/route';
import * as briefingNarrativeRoute from '@/app/api/briefing/narrative/route';
import * as briefingWeeklyReviewRoute from '@/app/api/briefing/weekly-review/route';
import * as commitmentsRoute from '@/app/api/commitments/route';
import * as commitmentRoute from '@/app/api/commitments/[id]/route';
import * as focusRoute from '@/app/api/focus/route';
import * as focusItemRoute from '@/app/api/focus/[id]/route';
import * as focusClearRoute from '@/app/api/focus/clear/route';
import * as calendarRoute from '@/app/api/calendar/route';
import * as plannerPlanRoute from '@/app/api/planner/plan/route';
import * as plannerSyncTodayRoute from '@/app/api/planner/sync-today/route';
import * as projectsRoute from '@/app/api/projects/route';
import * as projectRoute from '@/app/api/projects/[id]/route';
import * as sprintsRoute from '@/app/api/sprints/route';
import * as sprintRoute from '@/app/api/sprints/[id]/route';
import * as stakeholdersRoute from '@/app/api/stakeholders/route';
import * as stakeholderRoute from '@/app/api/stakeholders/[id]/route';
import * as stakeholderCommitmentsRoute from '@/app/api/stakeholders/[id]/commitments/route';
import * as tasksRoute from '@/app/api/tasks/route';
import * as taskRoute from '@/app/api/tasks/[id]/route';
import * as taskCommentsRoute from '@/app/api/tasks/[id]/comments/route';
import * as taskChecklistRoute from '@/app/api/tasks/[id]/checklist/route';
import * as taskRecurrenceRoute from '@/app/api/tasks/[id]/recur/route';
import * as taskParkRoute from '@/app/api/tasks/park/[id]/route';
import * as parkedTasksRoute from '@/app/api/tasks/parked/route';
import * as generateRecurringRoute from '@/app/api/tasks/generate-recurring/route';
import { requireMcpOauthRoute } from '@/lib/mcp/oauth';
import { writeInternalAuthContext } from '@/lib/supabase/internal-auth';

type StaticHandler = ((request: NextRequest) => Promise<Response>) | undefined;
type DynamicHandler = ((request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>) | undefined;

function methodNotAllowed(): NextResponse {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

async function invokeStatic(handler: StaticHandler, request: NextRequest): Promise<Response> {
  if (!handler) {
    return methodNotAllowed();
  }

  return handler(request);
}

async function invokeDynamic(
  handler: DynamicHandler,
  request: NextRequest,
  params: { id: string }
): Promise<Response> {
  if (!handler) {
    return methodNotAllowed();
  }

  return handler(request, { params: Promise.resolve(params) });
}

function normalizeSegments(input: string[] | undefined): string[] {
  return (input || []).filter(Boolean);
}

function getRequiredScopesForPath(pathSegments: string[], method: string): readonly ('mcp.read' | 'mcp.write' | 'mcp.delete')[] {
  const normalizedMethod = method.toUpperCase();

  if (
    normalizedMethod === 'POST' &&
    pathSegments[0] === 'briefing' &&
    pathSegments[1] === 'narrative'
  ) {
    return ['mcp.read'] as const;
  }

  if (
    (normalizedMethod === 'GET' || normalizedMethod === 'POST') &&
    pathSegments[0] === 'planner' &&
    pathSegments[1] === 'plan'
  ) {
    return ['mcp.read'] as const;
  }

  if (
    normalizedMethod === 'DELETE' &&
    pathSegments[0] === 'tasks' &&
    pathSegments[2] === 'recur'
  ) {
    return ['mcp.write'] as const;
  }

  if (normalizedMethod === 'DELETE') {
    return ['mcp.delete'] as const;
  }

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') {
    return ['mcp.read'] as const;
  }

  return ['mcp.write'] as const;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return handleRequest(request, params);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return handleRequest(request, params);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return handleRequest(request, params);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  return handleRequest(request, params);
}

async function handleRequest(
  request: NextRequest,
  paramsPromise: Promise<{ path?: string[] }>
): Promise<Response> {
  const segments = normalizeSegments((await paramsPromise).path);
  const auth = await requireMcpOauthRoute(request, getRequiredScopesForPath(segments, request.method));
  if (auth.response || !auth.context) {
    return auth.response as Response;
  }

  const requestWithContext = writeInternalAuthContext(request, auth.context);

  if (segments.length === 0) {
    return NextResponse.json({ error: 'Upstream path required' }, { status: 404 });
  }

  if (segments[0] === 'briefing' && segments.length === 1) {
    return invokeStatic(briefingRoute.GET, requestWithContext);
  }

  if (segments[0] === 'briefing' && segments[1] === 'weekly-review' && segments.length === 2) {
    return invokeStatic(briefingWeeklyReviewRoute.GET, requestWithContext);
  }

  if (segments[0] === 'briefing' && segments[1] === 'narrative' && segments.length === 2) {
    return invokeStatic(briefingNarrativeRoute.POST, requestWithContext);
  }

  if (segments[0] === 'tasks' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(tasksRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(tasksRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'tasks' && segments[1] === 'parked' && segments.length === 2) {
    return invokeStatic(parkedTasksRoute.GET, requestWithContext);
  }

  if (segments[0] === 'tasks' && segments[1] === 'generate-recurring' && segments.length === 2) {
    if (request.method === 'GET') return invokeStatic(generateRecurringRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(generateRecurringRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'tasks' && segments[1] === 'park' && segments[2] && segments.length === 3) {
    return invokeDynamic(taskParkRoute.POST, requestWithContext, { id: segments[2] });
  }

  if (segments[0] === 'tasks' && segments[1] && segments[2] === 'comments' && segments.length === 3) {
    if (request.method === 'GET') return invokeDynamic(taskCommentsRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'POST') return invokeDynamic(taskCommentsRoute.POST, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(taskCommentsRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(taskCommentsRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'tasks' && segments[1] && segments[2] === 'checklist' && segments.length === 3) {
    if (request.method === 'GET') return invokeDynamic(taskChecklistRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'POST') return invokeDynamic(taskChecklistRoute.POST, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(taskChecklistRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(taskChecklistRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'tasks' && segments[1] && segments[2] === 'recur' && segments.length === 3) {
    if (request.method === 'POST') return invokeDynamic(taskRecurrenceRoute.POST, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(taskRecurrenceRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'tasks' && segments[1] && segments.length === 2) {
    if (request.method === 'GET') return invokeDynamic(taskRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(taskRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(taskRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'applications' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(applicationsRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(applicationsRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'applications' && segments[1] === 'health-scores' && segments.length === 2) {
    return invokeStatic(applicationHealthRoute.GET, requestWithContext);
  }

  if (segments[0] === 'applications' && segments[1] && segments.length === 2) {
    if (request.method === 'GET') return invokeDynamic(applicationRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(applicationRoute.PATCH, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'projects' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(projectsRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(projectsRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'projects' && segments[1] && segments.length === 2) {
    if (request.method === 'GET') return invokeDynamic(projectRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(projectRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(projectRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'sprints' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(sprintsRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(sprintsRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'sprints' && segments[1] && segments.length === 2) {
    if (request.method === 'GET') return invokeDynamic(sprintRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(sprintRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(sprintRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'stakeholders' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(stakeholdersRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(stakeholdersRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'stakeholders' && segments[1] && segments[2] === 'commitments' && segments.length === 3) {
    if (request.method === 'GET') return invokeDynamic(stakeholderCommitmentsRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'POST') return invokeDynamic(stakeholderCommitmentsRoute.POST, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'stakeholders' && segments[1] && segments.length === 2) {
    if (request.method === 'GET') return invokeDynamic(stakeholderRoute.GET, requestWithContext, { id: segments[1] });
    if (request.method === 'PATCH') return invokeDynamic(stakeholderRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(stakeholderRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'commitments' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(commitmentsRoute.GET, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'commitments' && segments[1] && segments.length === 2) {
    if (request.method === 'PATCH') return invokeDynamic(commitmentRoute.PATCH, requestWithContext, { id: segments[1] });
    if (request.method === 'DELETE') return invokeDynamic(commitmentRoute.DELETE, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'focus' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(focusRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(focusRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'focus' && segments[1] === 'clear' && segments.length === 2) {
    return invokeStatic(focusClearRoute.POST, requestWithContext);
  }

  if (segments[0] === 'focus' && segments[1] && segments.length === 2) {
    if (request.method === 'PATCH') return invokeDynamic(focusItemRoute.PATCH, requestWithContext, { id: segments[1] });
    return methodNotAllowed();
  }

  if (segments[0] === 'calendar' && segments.length === 1) {
    if (request.method === 'GET') return invokeStatic(calendarRoute.GET, requestWithContext);
    if (request.method === 'PATCH') return invokeStatic(calendarRoute.PATCH, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'planner' && segments[1] === 'plan' && segments.length === 2) {
    if (request.method === 'GET') return invokeStatic(plannerPlanRoute.GET, requestWithContext);
    if (request.method === 'POST') return invokeStatic(plannerPlanRoute.POST, requestWithContext);
    return methodNotAllowed();
  }

  if (segments[0] === 'planner' && segments[1] === 'sync-today' && segments.length === 2) {
    return invokeStatic(plannerSyncTodayRoute.POST, requestWithContext);
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
