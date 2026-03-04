import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PROJECT_STAGE_VALUES } from '@/lib/project-stage';
import { z } from 'zod';

const ET_TIMEZONE = 'America/New_York';
const TASK_RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
const STAKEHOLDER_CONTEXT_SCHEMA = z.object({
  last_contacted_at: z.string().nullable().optional().describe('Last contact timestamp (ISO)'),
  preferred_contact: z.string().nullable().optional().describe('Preferred contact method'),
  current_priorities: z.string().nullable().optional().describe('Current stakeholder priorities'),
  notes: z.string().nullable().optional().describe('Structured context notes'),
});

function getCurrentTimeEt(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: ET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/**
 * Annotate calendar events with temporal_status relative to current time.
 * This prevents the LLM from misinterpreting whether meetings are past or upcoming.
 */
function annotateCalendarEvents(
  events: Array<Record<string, unknown>>,
  now: Date = new Date()
): Array<Record<string, unknown>> {
  const nowMs = now.getTime();

  return events.map(event => {
    const startStr = (event.start_at ?? event.start) as string | undefined;
    const endStr = (event.end_at ?? event.end) as string | undefined;

    if (!startStr || !endStr) return event;

    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();

    let temporal_status: 'past' | 'in_progress' | 'upcoming';
    if (nowMs >= endMs) {
      temporal_status = 'past';
    } else if (nowMs >= startMs) {
      temporal_status = 'in_progress';
    } else {
      temporal_status = 'upcoming';
    }

    return {
      ...event,
      temporal_status,
    };
  });
}

function toMcpResponse(data: unknown) {
  const now = new Date();
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(
        {
          current_time_et: getCurrentTimeEt(),
          current_time_utc: now.toISOString(),
          data,
        },
        null,
        2
      ),
    }],
  };
}

// ---------------------------------------------------------------------------
// Auth helper — validates API key before allowing MCP access
// ---------------------------------------------------------------------------
function authenticate(request: Request): true | Response {
  const validApiKey = process.env.MISSION_CONTROL_API_KEY;
  const actionsApiKey = process.env.MISSION_CONTROL_ACTIONS_API_KEY;

  // Preserve the legacy MCP key path exactly as-is for Claude.
  // If the actions key is distinct, reject it explicitly for this endpoint.
  if (!validApiKey && !actionsApiKey) {
    return new Response(JSON.stringify({ error: 'API key auth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Accept API key via header, Bearer token, or ?key= query param
  const customKey = request.headers.get('x-mission-control-key');
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const urlKey = new URL(request.url).searchParams.get('key');
  const apiKey = customKey || bearerToken || urlKey;

  if (apiKey && validApiKey && apiKey === validApiKey) {
    return true;
  }

  if (apiKey && actionsApiKey && apiKey === actionsApiKey) {
    return new Response(JSON.stringify({ error: 'The actions API key cannot access /api/mcp' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!validApiKey) {
    return new Response(JSON.stringify({ error: 'API key auth not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Invalid or missing API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid or missing API key' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Build the MCP server with all Baseline tools
// ---------------------------------------------------------------------------
function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: 'mission-control', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // ── GET BRIEFING ──────────────────────────────────────────────────────
  mcp.tool(
    'get_briefing',
    'Get a daily briefing snapshot with calendar, tasks, capacity, and progress. Calendar events include temporal_status (past, in_progress, or upcoming) relative to current time — always use this to determine whether a meeting already happened. Modes: morning, midday, eod, auto.',
    {
      mode: z.enum(['morning', 'midday', 'eod', 'auto']).default('auto').describe('Briefing mode'),
      date: z.string().optional().describe('ISO date (YYYY-MM-DD). Defaults to today ET.'),
    },
    async ({ mode, date }) => {
      const url = new URL('/api/briefing', 'https://mission-control-orpin-chi.vercel.app');
      url.searchParams.set('mode', mode);
      if (date) url.searchParams.set('date', date);

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();

      // Annotate calendar events with temporal_status so the LLM knows which are past/upcoming
      if (data.today?.calendar?.events && Array.isArray(data.today.calendar.events)) {
        data.today.calendar.events = annotateCalendarEvents(data.today.calendar.events);
      }
      if (data.tomorrow?.calendar?.events && Array.isArray(data.tomorrow.calendar.events)) {
        data.tomorrow.calendar.events = annotateCalendarEvents(data.tomorrow.calendar.events);
      }

      return toMcpResponse(data);
    }
  );

  // ── GET WEEKLY REVIEW ────────────────────────────────────────────────
  mcp.tool(
    'get_weekly_review',
    'Get the structured weekly review snapshot with shipped work, stalled work, pending decisions, health scores, and next-week suggestions.',
    {
      date: z.string().optional().describe('ISO date (YYYY-MM-DD). Defaults to today ET and reviews the current week-to-date.'),
    },
    async ({ date }) => {
      const url = new URL('/api/briefing/weekly-review', 'https://mission-control-orpin-chi.vercel.app');
      if (date) url.searchParams.set('date', date);

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST TASKS ────────────────────────────────────────────────────────
  mcp.tool(
    'list_tasks',
    'List tasks with optional filters. Returns tasks sorted by priority.',
    {
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done']).optional().describe('Filter by status'),
      needs_review: z.boolean().optional().describe('Only tasks flagged for review'),
      implementation_id: z.string().optional().describe('Filter by application UUID'),
      project_id: z.string().optional().describe('Filter by project UUID'),
      due_soon: z.boolean().optional().describe('Due within 48 hours, excluding Done and Parked'),
      include_done: z.boolean().optional().describe('Include completed tasks (default: excluded)'),
      include_parked: z.boolean().optional().describe('Include parked tasks (default: excluded)'),
      limit: z.number().min(1).max(500).optional().describe('Max results (default 100)'),
      offset: z.number().min(0).max(5000).optional().describe('Result offset for pagination'),
    },
    async (args) => {
      const url = new URL('/api/tasks', 'https://mission-control-orpin-chi.vercel.app');
      if (args.status) url.searchParams.set('status', args.status);
      if (args.needs_review) url.searchParams.set('needs_review', 'true');
      if (args.implementation_id) url.searchParams.set('implementation_id', args.implementation_id);
      if (args.project_id) url.searchParams.set('project_id', args.project_id);
      if (args.due_soon) url.searchParams.set('due_soon', 'true');
      if (args.include_done) url.searchParams.set('include_done', 'true');
      if (args.include_parked) url.searchParams.set('include_parked', 'true');
      if (args.limit) url.searchParams.set('limit', String(args.limit));
      if (typeof args.offset === 'number') url.searchParams.set('offset', String(args.offset));

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST PARKED TASKS ─────────────────────────────────────────────────
  mcp.tool(
    'list_parked_tasks',
    'List only parked tasks using the dedicated parking-lot endpoint.',
    {
      implementation_id: z.string().optional().describe('Filter by application UUID'),
      project_id: z.string().optional().describe('Filter by project UUID'),
      limit: z.number().min(1).max(500).optional().describe('Max results (default 100)'),
      offset: z.number().min(0).max(5000).optional().describe('Result offset for pagination'),
    },
    async (args) => {
      const url = new URL('/api/tasks/parked', 'https://mission-control-orpin-chi.vercel.app');
      if (args.implementation_id) url.searchParams.set('implementation_id', args.implementation_id);
      if (args.project_id) url.searchParams.set('project_id', args.project_id);
      if (args.limit) url.searchParams.set('limit', String(args.limit));
      if (typeof args.offset === 'number') url.searchParams.set('offset', String(args.offset));

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET TASK ──────────────────────────────────────────────────────────
  mcp.tool(
    'get_task',
    'Get a single task by ID, including implementation details.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CREATE TASK ───────────────────────────────────────────────────────
  mcp.tool(
    'create_task',
    'Create a new task. Only title is required.',
    {
      title: z.string().describe('Task title (required)'),
      description: z.string().optional().describe('Task description'),
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done']).default('Backlog'),
      task_type: z.enum(['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build']).default('Task'),
      estimated_minutes: z.number().min(1).max(480).optional().describe('Time estimate in minutes'),
      estimate_source: z.enum(['default', 'llm', 'manual']).optional().describe('How the estimate was chosen'),
      due_at: z.string().optional().describe('Due date as ISO string'),
      priority_score: z.number().min(0).max(100).optional().describe('Priority 0-100'),
      blocker: z.boolean().optional().describe('Is this a blocker?'),
      needs_review: z.boolean().optional().describe('Flag for review'),
      waiting_on: z.string().optional().describe('Who/what is this waiting on'),
      implementation_id: z.string().optional().describe('Application UUID to link to'),
      project_id: z.string().optional().describe('Project UUID to link to'),
      stakeholder_mentions: z.array(z.string()).optional().describe('Stakeholder names'),
      source_type: z.string().optional().describe('Source label, e.g. Manual or Recurring'),
      source_url: z.string().optional().describe('Source URL for traceability'),
      pinned_excerpt: z.string().optional().describe('Pinned source excerpt'),
      blocked_by_task_id: z.string().optional().describe('Task UUID this new task should depend on'),
      initial_comment: z.string().optional().describe('Creates first comment on the task'),
      initial_checklist: z.array(z.string()).optional().describe('Creates checklist items'),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/tasks', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── UPDATE TASK ───────────────────────────────────────────────────────
  mcp.tool(
    'update_task',
    'Update an existing task. Provide task_id and any fields to change.',
    {
      task_id: z.string().describe('Task UUID'),
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Parked', 'Done']).optional(),
      task_type: z.enum(['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build']).optional(),
      estimated_minutes: z.number().min(1).max(480).optional(),
      estimate_source: z.enum(['default', 'llm', 'manual']).optional(),
      actual_minutes: z.number().int().min(0).nullable().optional(),
      due_at: z.string().nullable().optional(),
      needs_review: z.boolean().optional(),
      blocker: z.boolean().optional(),
      waiting_on: z.string().nullable().optional(),
      follow_up_at: z.string().nullable().optional(),
      implementation_id: z.string().nullable().optional(),
      project_id: z.string().nullable().optional().describe('Project UUID or null to unlink'),
      sprint_id: z.string().nullable().optional().describe('Sprint UUID or null to unlink'),
      pinned_excerpt: z.string().nullable().optional(),
      pinned: z.boolean().optional(),
    },
    async ({ task_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── PARK TASK ─────────────────────────────────────────────────────────
  mcp.tool(
    'park_task',
    'Move a task into the Parked status using the dedicated convenience endpoint.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/park/${task_id}`,
        {
          method: 'POST',
          headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── DELETE TASK ───────────────────────────────────────────────────────
  mcp.tool(
    'delete_task',
    'Delete a task by ID.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}`,
        {
          method: 'DELETE',
          headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── TASK RECURRENCE ───────────────────────────────────────────────────
  mcp.tool(
    'set_task_recurrence',
    'Configure a task as a recurring template. This parks the template (unless already Done) and clears any sprint assignment.',
    {
      task_id: z.string().describe('Task UUID'),
      frequency: z.enum(TASK_RECURRENCE_FREQUENCIES).describe('Recurring cadence'),
      next_due: z.string().optional().describe('Next scheduled date YYYY-MM-DD. Defaults from task due date or today.'),
      day_of_week: z.number().int().min(0).max(6).optional().describe('For weekly/biweekly schedules, 0=Sunday through 6=Saturday'),
      day_of_month: z.number().int().min(1).max(31).optional().describe('For monthly schedules, preferred day of month'),
    },
    async ({ task_id, ...recurrence }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/recur`,
        {
          method: 'POST',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(recurrence),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'clear_task_recurrence',
    'Remove recurrence from a task template.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/recur`,
        {
          method: 'DELETE',
          headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'generate_recurring_tasks',
    'Manually run the recurring-task generator now.',
    {},
    async () => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/tasks/generate-recurring', {
        method: 'POST',
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── TASK COMMENTS ─────────────────────────────────────────────────────
  mcp.tool(
    'list_task_comments',
    'List comments on a task.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/comments`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'add_task_comment',
    'Add a comment to a task.',
    {
      task_id: z.string().describe('Task UUID'),
      content: z.string().describe('Comment text'),
    },
    async ({ task_id, content }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/comments`,
        {
          method: 'POST',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content }),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── TASK CHECKLIST ────────────────────────────────────────────────────
  mcp.tool(
    'get_task_checklist',
    'Get checklist items for a task.',
    {
      task_id: z.string().describe('Task UUID'),
    },
    async ({ task_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/checklist`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'update_task_checklist',
    'Update checklist items (mark done/undone).',
    {
      task_id: z.string().describe('Task UUID'),
      items: z.array(z.object({
        id: z.string().describe('Checklist item UUID'),
        is_done: z.boolean().describe('Whether the item is done'),
      })).describe('Items to update'),
    },
    async ({ task_id, items }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/tasks/${task_id}/checklist`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items }),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST APPLICATIONS ─────────────────────────────────────────────────
  mcp.tool(
    'list_applications',
    'List all applications/implementations. Use with_stats for blocker counts, next action, and risk signals.',
    {
      with_stats: z.boolean().optional().describe('Include blockers_count and next_action'),
    },
    async ({ with_stats }) => {
      const url = new URL('/api/applications', 'https://mission-control-orpin-chi.vercel.app');
      if (with_stats) url.searchParams.set('with_stats', 'true');

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET APPLICATION HEALTH SCORES ────────────────────────────────────
  mcp.tool(
    'get_application_health_scores',
    'Compute and return current health scores for all applications. This also persists snapshots so later calls can report trend.',
    {},
    async () => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/applications/health-scores', {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET APPLICATION ───────────────────────────────────────────────────
  mcp.tool(
    'get_application',
    'Get application detail with open tasks, done tasks, and blocker count.',
    {
      application_id: z.string().describe('Application UUID'),
    },
    async ({ application_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/applications/${application_id}`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CREATE APPLICATION ────────────────────────────────────────────────
  mcp.tool(
    'create_application',
    'Create a new application/implementation.',
    {
      name: z.string().describe('Application name (required)'),
      phase: z.enum(['Intake', 'Discovery', 'Design', 'Build', 'Test', 'Training', 'GoLive', 'Hypercare', 'Steady State', 'Sundown']).default('Intake'),
      rag: z.enum(['Green', 'Yellow', 'Red']).default('Green'),
      target_date: z.string().optional().describe('Target date (ISO)'),
      status_summary: z.string().optional(),
      next_milestone: z.string().optional(),
      next_milestone_date: z.string().optional(),
      stakeholders: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/applications', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── UPDATE APPLICATION ────────────────────────────────────────────────
  mcp.tool(
    'update_application',
    'Update an application. Provide application_id and fields to change.',
    {
      application_id: z.string().describe('Application UUID'),
      name: z.string().optional(),
      phase: z.enum(['Intake', 'Discovery', 'Design', 'Build', 'Test', 'Training', 'GoLive', 'Hypercare', 'Steady State', 'Sundown']).optional(),
      rag: z.enum(['Green', 'Yellow', 'Red']).optional(),
      target_date: z.string().nullable().optional(),
      status_summary: z.string().optional(),
      next_milestone: z.string().optional(),
      next_milestone_date: z.string().nullable().optional(),
      stakeholders: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      priority_weight: z.number().int().min(0).max(10).optional(),
      priority_note: z.string().nullable().optional(),
      portfolio_rank: z.number().int().min(1).optional(),
    },
    async ({ application_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/applications/${application_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST PROJECTS ─────────────────────────────────────────────────────
  mcp.tool(
    'list_projects',
    'List projects, optionally filtered by application. Use with_stats=true for task counts.',
    {
      implementation_id: z.string().optional().describe('Filter by application UUID'),
      with_stats: z.boolean().optional().describe('Include open_task_count and implementation info'),
    },
    async ({ implementation_id, with_stats }) => {
      const url = new URL('/api/projects', 'https://mission-control-orpin-chi.vercel.app');
      if (implementation_id) url.searchParams.set('implementation_id', implementation_id);
      if (with_stats) url.searchParams.set('with_stats', 'true');

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET PROJECT ───────────────────────────────────────────────────────
  mcp.tool(
    'get_project',
    'Get a single project with open tasks, blocker count, and linked application.',
    {
      project_id: z.string().describe('Project UUID'),
    },
    async ({ project_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/projects/${project_id}`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CREATE PROJECT ────────────────────────────────────────────────────
  mcp.tool(
    'create_project',
    'Create a new project. Only name is required.',
    {
      name: z.string().describe('Project name (required)'),
      description: z.string().optional(),
      implementation_id: z.string().optional().describe('Application UUID to link to'),
      stage: z.enum(PROJECT_STAGE_VALUES).default('Planned'),
      rag: z.enum(['Green', 'Yellow', 'Red']).default('Green'),
      target_date: z.string().optional().describe('Target date (ISO date YYYY-MM-DD)'),
      servicenow_spm_id: z.string().optional().describe('ServiceNow SPM project ID'),
      status_summary: z.string().optional(),
      portfolio_rank: z.number().int().min(1).optional().describe('Positive integer for ordering within the portfolio'),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/projects', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── SPRINTS ───────────────────────────────────────────────────────────
  mcp.tool(
    'list_sprints',
    'List all sprints, most recent first.',
    {},
    async () => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/sprints', {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'create_sprint',
    'Create a sprint for week-level planning.',
    {
      name: z.string().describe('Sprint name'),
      start_date: z.string().describe('Start date YYYY-MM-DD'),
      end_date: z.string().describe('End date YYYY-MM-DD'),
      theme: z.string().optional().describe('Optional sprint theme'),
      focus_implementation_id: z.string().nullable().optional().describe('Application UUID to focus the sprint on'),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/sprints', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'get_sprint',
    'Get a sprint with completion stats and tasks grouped by status.',
    {
      sprint_id: z.string().describe('Sprint UUID'),
    },
    async ({ sprint_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/sprints/${sprint_id}`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'update_sprint',
    'Update sprint metadata. Provide sprint_id and any fields to change.',
    {
      sprint_id: z.string().describe('Sprint UUID'),
      name: z.string().optional(),
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
      theme: z.string().nullable().optional(),
      focus_implementation_id: z.string().nullable().optional().describe('Application UUID or null to unlink'),
    },
    async ({ sprint_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/sprints/${sprint_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  mcp.tool(
    'delete_sprint',
    'Delete a sprint by ID.',
    {
      sprint_id: z.string().describe('Sprint UUID'),
    },
    async ({ sprint_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/sprints/${sprint_id}`,
        {
          method: 'DELETE',
          headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── UPDATE PROJECT ────────────────────────────────────────────────────
  mcp.tool(
    'update_project',
    'Update a project. Provide project_id and any fields to change.',
    {
      project_id: z.string().describe('Project UUID'),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      implementation_id: z.string().nullable().optional(),
      stage: z.enum(PROJECT_STAGE_VALUES).optional(),
      rag: z.enum(['Green', 'Yellow', 'Red']).optional(),
      target_date: z.string().nullable().optional(),
      servicenow_spm_id: z.string().nullable().optional(),
      status_summary: z.string().optional(),
      portfolio_rank: z.number().int().min(1).optional(),
    },
    async ({ project_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/projects/${project_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── DELETE PROJECT ────────────────────────────────────────────────────
  mcp.tool(
    'delete_project',
    'Delete a project by ID.',
    {
      project_id: z.string().describe('Project UUID'),
    },
    async ({ project_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/projects/${project_id}`,
        {
          method: 'DELETE',
          headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST STAKEHOLDERS ─────────────────────────────────────────────────
  mcp.tool(
    'list_stakeholders',
    'List stakeholders with open commitment counts. Optionally search by name/email/org.',
    {
      search: z.string().optional().describe('Search by name, email, or organization'),
    },
    async ({ search }) => {
      const url = new URL('/api/stakeholders', 'https://mission-control-orpin-chi.vercel.app');
      if (search) url.searchParams.set('search', search);

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET STAKEHOLDER ───────────────────────────────────────────────────
  mcp.tool(
    'get_stakeholder',
    'Get a stakeholder by ID.',
    {
      stakeholder_id: z.string().describe('Stakeholder UUID'),
    },
    async ({ stakeholder_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/stakeholders/${stakeholder_id}`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CREATE STAKEHOLDER ────────────────────────────────────────────────
  mcp.tool(
    'create_stakeholder',
    'Create a new stakeholder.',
    {
      name: z.string().describe('Name (required)'),
      email: z.string().optional(),
      role: z.string().optional(),
      organization: z.string().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/stakeholders', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── UPDATE STAKEHOLDER ────────────────────────────────────────────────
  mcp.tool(
    'update_stakeholder',
    'Update a stakeholder.',
    {
      stakeholder_id: z.string().describe('Stakeholder UUID'),
      name: z.string().optional(),
      email: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      organization: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      context: STAKEHOLDER_CONTEXT_SCHEMA.optional().describe('Structured stakeholder memory to merge into existing context'),
    },
    async ({ stakeholder_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/stakeholders/${stakeholder_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── LIST COMMITMENTS ──────────────────────────────────────────────────
  mcp.tool(
    'list_commitments',
    'List commitments for a stakeholder.',
    {
      stakeholder_id: z.string().describe('Stakeholder UUID'),
    },
    async ({ stakeholder_id }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/stakeholders/${stakeholder_id}/commitments`,
        { headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! } }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CREATE COMMITMENT ─────────────────────────────────────────────────
  mcp.tool(
    'create_commitment',
    'Create a commitment between Brent and a stakeholder.',
    {
      stakeholder_id: z.string().describe('Stakeholder UUID'),
      title: z.string().describe('Commitment title (required)'),
      direction: z.enum(['ours', 'theirs']).describe('"ours" = we promised them, "theirs" = they promised us'),
      status: z.enum(['Open', 'Done', 'Dropped']).default('Open'),
      due_at: z.string().optional().describe('Due date (ISO)'),
      notes: z.string().optional(),
      task_id: z.string().optional().describe('Link to a task UUID'),
    },
    async ({ stakeholder_id, ...rest }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/stakeholders/${stakeholder_id}/commitments`,
        {
          method: 'POST',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(rest),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── UPDATE COMMITMENT ─────────────────────────────────────────────────
  mcp.tool(
    'update_commitment',
    'Update a commitment.',
    {
      commitment_id: z.string().describe('Commitment UUID'),
      title: z.string().optional(),
      status: z.enum(['Open', 'Done', 'Dropped']).optional(),
      direction: z.enum(['ours', 'theirs']).optional(),
      due_at: z.string().nullable().optional(),
      done_at: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      task_id: z.string().nullable().optional(),
    },
    async ({ commitment_id, ...updates }) => {
      const res = await fetch(
        `https://mission-control-orpin-chi.vercel.app/api/commitments/${commitment_id}`,
        {
          method: 'PATCH',
          headers: {
            'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updates),
        }
      );
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET FOCUS ─────────────────────────────────────────────────────────
  mcp.tool(
    'get_focus',
    'Get the active focus directive and optionally recent history.',
    {
      include_history: z.boolean().optional().describe('Include recent directives'),
    },
    async ({ include_history }) => {
      const url = new URL('/api/focus', 'https://mission-control-orpin-chi.vercel.app');
      if (include_history) url.searchParams.set('include_history', 'true');

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── SET FOCUS ─────────────────────────────────────────────────────────
  mcp.tool(
    'set_focus',
    'Set a focus directive to prioritize certain areas in the planner.',
    {
      text: z.string().describe('Description of the focus directive'),
      scope_type: z.enum(['implementation', 'stakeholder', 'task_type', 'query']).describe('What kind of thing to focus on'),
      scope_id: z.string().optional().describe('UUID — for scope_type=implementation'),
      scope_value: z.string().optional().describe('String value — for stakeholder/task_type/query'),
      strength: z.enum(['nudge', 'strong', 'hard']).default('strong'),
      reason: z.string().optional().describe('Why this focus matters'),
      starts_at: z.string().optional(),
      ends_at: z.string().optional(),
    },
    async (args) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/focus', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...args, is_active: true }),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── CLEAR FOCUS ───────────────────────────────────────────────────────
  mcp.tool(
    'clear_focus',
    'Deactivate all active focus directives.',
    {},
    async () => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/focus/clear', {
        method: 'POST',
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET CALENDAR ──────────────────────────────────────────────────────
  mcp.tool(
    'get_calendar',
    'Get calendar events for a date range. Events include temporal_status (past, in_progress, or upcoming) relative to current time — always use this to determine whether a meeting already happened. Triggers iCal ingestion.',
    {
      range_start: z.string().describe('Start date (YYYY-MM-DD)'),
      range_end: z.string().describe('End date (YYYY-MM-DD)'),
    },
    async ({ range_start, range_end }) => {
      const url = new URL('/api/calendar', 'https://mission-control-orpin-chi.vercel.app');
      url.searchParams.set('rangeStart', range_start);
      url.searchParams.set('rangeEnd', range_end);

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();

      // Annotate calendar events with temporal_status so the LLM knows which are past/upcoming
      if (data.events && Array.isArray(data.events)) {
        data.events = annotateCalendarEvents(data.events);
      }

      return toMcpResponse(data);
    }
  );

  // ── GET PLANNER ───────────────────────────────────────────────────────
  mcp.tool(
    'get_plan',
    'Get the AI-scored task plan for today, considering capacity, focus, and priority.',
    {},
    async () => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/planner/plan', {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── SYNC TODAY TASKS ─────────────────────────────────────────────────
  mcp.tool(
    'sync_today',
    'Promotes recommended tasks to Planned on the Today tab and demotes stale Planned tasks to Backlog. Call this at the end of every morning brief.',
    {
      task_ids: z.array(z.string()).min(1).max(20).describe('Task UUIDs to keep on Today'),
    },
    async ({ task_ids }) => {
      const res = await fetch('https://mission-control-orpin-chi.vercel.app/api/planner/sync-today', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ task_ids }),
      });
      const data = await res.json();
      return toMcpResponse(data);
    }
  );

  // ── GET BRIEFING NARRATIVE ────────────────────────────────────────────
  mcp.tool(
    'get_briefing_narrative',
    'Get an AI-generated prose summary of the current day.',
    {
      mode: z.enum(['morning', 'midday', 'eod', 'auto']).default('auto').describe('Briefing mode'),
      date: z.string().optional().describe('ISO date (YYYY-MM-DD). Defaults to today ET.'),
    },
    async ({ mode, date }) => {
      const briefingUrl = new URL('/api/briefing', 'https://mission-control-orpin-chi.vercel.app');
      briefingUrl.searchParams.set('mode', mode);
      if (date) briefingUrl.searchParams.set('date', date);

      const briefingRes = await fetch(briefingUrl.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });

      if (!briefingRes.ok) {
        const errorText = await briefingRes.text();
        return toMcpResponse({
          error: 'Failed to fetch briefing for narrative generation',
          status: briefingRes.status,
          body: errorText,
        });
      }

      const briefing = await briefingRes.json();

      // Annotate calendar events with temporal_status before narrative generation
      if (briefing.today?.calendar?.events && Array.isArray(briefing.today.calendar.events)) {
        briefing.today.calendar.events = annotateCalendarEvents(briefing.today.calendar.events);
      }
      if (briefing.tomorrow?.calendar?.events && Array.isArray(briefing.tomorrow.calendar.events)) {
        briefing.tomorrow.calendar.events = annotateCalendarEvents(briefing.tomorrow.calendar.events);
      }

      const narrativeRes = await fetch('https://mission-control-orpin-chi.vercel.app/api/briefing/narrative', {
        method: 'POST',
        headers: {
          'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ briefing }),
      });

      const payloadText = await narrativeRes.text();
      if (!payloadText.trim()) {
        return toMcpResponse({
          error: 'Narrative endpoint returned an empty response body',
          status: narrativeRes.status,
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(payloadText);
      } catch {
        data = {
          error: 'Narrative endpoint returned non-JSON output',
          status: narrativeRes.status,
          body: payloadText,
        };
      }

      return toMcpResponse(data);
    }
  );

  return mcp;
}

// ---------------------------------------------------------------------------
// Next.js App Router handlers — POST for MCP messages, GET for SSE, DELETE for cleanup
// ---------------------------------------------------------------------------

async function handleMcpRequest(request: Request): Promise<Response> {
  // Authenticate
  const authResult = authenticate(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  // Create a fresh MCP server + transport per request (stateless / serverless)
  const mcp = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  });

  await mcp.connect(transport);

  try {
    return await transport.handleRequest(request);
  } finally {
    // Clean up after the request
    await mcp.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}
