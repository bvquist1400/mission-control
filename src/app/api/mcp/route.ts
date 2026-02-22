import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Auth helper — validates API key before allowing MCP access
// ---------------------------------------------------------------------------
function authenticate(request: Request): true | Response {
  const validApiKey = process.env.MISSION_CONTROL_API_KEY;

  if (!validApiKey) {
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

  if (!apiKey || apiKey !== validApiKey) {
    return new Response(JSON.stringify({ error: 'Invalid or missing API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Build the MCP server with all Mission Control tools
// ---------------------------------------------------------------------------
function createMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: 'mission-control', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // ── GET BRIEFING ──────────────────────────────────────────────────────
  mcp.tool(
    'get_briefing',
    'Get a daily briefing snapshot with calendar, tasks, capacity, and progress. Modes: morning, midday, eod, auto.',
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── LIST TASKS ────────────────────────────────────────────────────────
  mcp.tool(
    'list_tasks',
    'List tasks with optional filters. Returns tasks sorted by priority.',
    {
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Done']).optional().describe('Filter by status'),
      needs_review: z.boolean().optional().describe('Only tasks flagged for review'),
      implementation_id: z.string().optional().describe('Filter by application UUID'),
      due_soon: z.boolean().optional().describe('Due within 48 hours, not Done'),
      include_done: z.boolean().optional().describe('Include completed tasks (default: excluded)'),
      limit: z.number().min(1).max(500).optional().describe('Max results (default 100)'),
    },
    async (args) => {
      const url = new URL('/api/tasks', 'https://mission-control-orpin-chi.vercel.app');
      if (args.status) url.searchParams.set('status', args.status);
      if (args.needs_review) url.searchParams.set('needs_review', 'true');
      if (args.implementation_id) url.searchParams.set('implementation_id', args.implementation_id);
      if (args.due_soon) url.searchParams.set('due_soon', 'true');
      if (args.include_done) url.searchParams.set('include_done', 'true');
      if (args.limit) url.searchParams.set('limit', String(args.limit));

      const res = await fetch(url.toString(), {
        headers: { 'X-Mission-Control-Key': process.env.MISSION_CONTROL_API_KEY! },
      });
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── CREATE TASK ───────────────────────────────────────────────────────
  mcp.tool(
    'create_task',
    'Create a new task. Only title is required.',
    {
      title: z.string().describe('Task title (required)'),
      description: z.string().optional().describe('Task description'),
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Done']).default('Backlog'),
      task_type: z.enum(['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build']).default('Task'),
      estimated_minutes: z.number().min(1).max(480).optional().describe('Time estimate in minutes'),
      due_at: z.string().optional().describe('Due date as ISO string'),
      priority_score: z.number().min(0).max(100).optional().describe('Priority 0-100'),
      blocker: z.boolean().optional().describe('Is this a blocker?'),
      needs_review: z.boolean().optional().describe('Flag for review'),
      waiting_on: z.string().optional().describe('Who/what is this waiting on'),
      implementation_id: z.string().optional().describe('Application UUID to link to'),
      stakeholder_mentions: z.array(z.string()).optional().describe('Stakeholder names'),
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── UPDATE TASK ───────────────────────────────────────────────────────
  mcp.tool(
    'update_task',
    'Update an existing task. Provide task_id and any fields to change.',
    {
      task_id: z.string().describe('Task UUID'),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['Backlog', 'Planned', 'In Progress', 'Blocked/Waiting', 'Done']).optional(),
      task_type: z.enum(['Task', 'Ticket', 'MeetingPrep', 'FollowUp', 'Admin', 'Build']).optional(),
      estimated_minutes: z.number().min(1).max(480).optional(),
      due_at: z.string().nullable().optional(),
      needs_review: z.boolean().optional(),
      blocker: z.boolean().optional(),
      waiting_on: z.string().nullable().optional(),
      follow_up_at: z.string().nullable().optional(),
      implementation_id: z.string().nullable().optional(),
      pinned_excerpt: z.string().nullable().optional(),
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── LIST APPLICATIONS ─────────────────────────────────────────────────
  mcp.tool(
    'list_applications',
    'List all applications/implementations. Use with_stats for blocker counts and next action.',
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── GET CALENDAR ──────────────────────────────────────────────────────
  mcp.tool(
    'get_calendar',
    'Get calendar events for a date range. Triggers iCal ingestion.',
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Failed to fetch briefing for narrative generation',
              status: briefingRes.status,
              body: errorText,
            }, null, 2),
          }],
        };
      }

      const briefing = await briefingRes.json();

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
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Narrative endpoint returned an empty response body',
              status: narrativeRes.status,
            }, null, 2),
          }],
        };
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

      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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
