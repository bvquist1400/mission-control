import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient, User } from '@supabase/supabase-js';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { withCorsHeaders } from '@/lib/cors';
import { readInternalAuthContext } from '@/lib/supabase/internal-auth';

export type AuthSource = 'session' | 'bearer' | 'legacy_api_key' | 'actions_api_key' | 'mcp_oauth';

export interface AuthenticatedRouteContext {
  supabase: SupabaseClient;
  user: User;
  userId: string;
  authSource: AuthSource;
}

interface RouteAuthResult {
  context: AuthenticatedRouteContext | null;
  response: NextResponse | null;
}

type MachineAuthSource = Extract<AuthSource, 'legacy_api_key' | 'actions_api_key'>;

const ACTIONS_ROUTE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; methods: ReadonlyArray<string> }> = [
  { pattern: /^\/api\/calendar$/, methods: ['GET'] },
  { pattern: /^\/api\/briefing\/digest$/, methods: ['GET'] },
  { pattern: /^\/api\/briefing\/monthly-review$/, methods: ['GET'] },
  { pattern: /^\/api\/briefing\/render$/, methods: ['GET'] },
  { pattern: /^\/api\/briefing\/review-snapshots$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/briefing\/weekly-review$/, methods: ['GET'] },
  { pattern: /^\/api\/planner\/plan$/, methods: ['GET'] },
  { pattern: /^\/api\/planner\/sync-today$/, methods: ['POST'] },
  { pattern: /^\/api\/project-status-updates$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/tasks$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/tasks\/parse$/, methods: ['POST'] },
  { pattern: /^\/api\/tasks\/[^/]+$/, methods: ['GET', 'PATCH'] },
  { pattern: /^\/api\/tasks\/[^/]+\/comments$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/focus$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/focus\/clear$/, methods: ['POST'] },
  { pattern: /^\/api\/projects$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/projects\/[^/]+$/, methods: ['GET', 'PATCH'] },
  { pattern: /^\/api\/sprints$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/sprints\/[^/]+$/, methods: ['GET', 'PATCH'] },
  { pattern: /^\/api\/stakeholders$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/stakeholders\/[^/]+\/commitments$/, methods: ['POST'] },
  { pattern: /^\/api\/stakeholders\/[^/]+$/, methods: ['GET', 'PATCH'] },
  { pattern: /^\/api\/commitments$/, methods: ['GET'] },
  { pattern: /^\/api\/commitments\/[^/]+$/, methods: ['PATCH'] },
];

function corsJson(request: NextRequest, body: unknown, init?: ResponseInit): NextResponse {
  return withCorsHeaders(NextResponse.json(body, init), request);
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') {
    return pathname;
  }

  return pathname.replace(/\/+$/, '');
}

function isActionsKeyRouteAllowed(request: NextRequest): boolean {
  const pathname = normalizePathname(request.nextUrl.pathname);
  const method = request.method.toUpperCase();

  if (method === 'DELETE') {
    return false;
  }

  return ACTIONS_ROUTE_ALLOWLIST.some(
    (rule) => rule.methods.includes(method) && rule.pattern.test(pathname)
  );
}

async function requireMachineKeyRoute(request: NextRequest): Promise<RouteAuthResult | null> {
  const providedApiKey = request.headers.get('x-mission-control-key')?.trim();
  if (!providedApiKey) {
    return null;
  }

  const legacyApiKey = process.env.MISSION_CONTROL_API_KEY?.trim();
  const actionsApiKey = process.env.MISSION_CONTROL_ACTIONS_API_KEY?.trim();
  const apiUserId = process.env.MISSION_CONTROL_USER_ID?.trim();

  if (!apiUserId || (!legacyApiKey && !actionsApiKey)) {
    return {
      context: null,
      response: corsJson(
        request,
        { error: 'API key auth is not configured on this server' },
        { status: 503 }
      ),
    };
  }

  let authSource: MachineAuthSource | null = null;

  if (legacyApiKey && providedApiKey === legacyApiKey) {
    authSource = 'legacy_api_key';
  } else if (actionsApiKey && providedApiKey === actionsApiKey) {
    authSource = 'actions_api_key';
  }

  if (!authSource) {
    return {
      context: null,
      response: corsJson(request, { error: 'Invalid API key' }, { status: 401 }),
    };
  }

  if (authSource === 'actions_api_key' && !isActionsKeyRouteAllowed(request)) {
    return {
      context: null,
      response: corsJson(
        request,
        { error: 'The actions API key is not permitted for this route' },
        { status: 403 }
      ),
    };
  }

  const supabase = createSupabaseAdminClient();

  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(apiUserId);

  if (userError || !userData?.user) {
    return {
      context: null,
      response: corsJson(
        request,
        { error: 'API key user not found — check MISSION_CONTROL_USER_ID env var' },
        { status: 401 }
      ),
    };
  }

  return {
    context: {
      supabase,
      user: userData.user,
      userId: apiUserId,
      authSource,
    },
    response: null,
  };
}

/**
 * Authenticates a route request via either:
 *  1. X-Mission-Control-Key header (API key auth for Claude / external callers)
 *  2. Authorization: Bearer <token> header (Supabase JWT)
 *  3. Supabase session cookie (browser auth)
 */
export async function requireAuthenticatedRoute(
  request: NextRequest
): Promise<RouteAuthResult> {
  const internalContext = readInternalAuthContext<AuthenticatedRouteContext>(request);
  if (internalContext) {
    return {
      context: internalContext,
      response: null,
    };
  }

  const machineAuth = await requireMachineKeyRoute(request);
  if (machineAuth) {
    return machineAuth;
  }

  // --- Standard Supabase Auth (Bearer token or cookie) ---
  const supabase = await createSupabaseServerClient();

  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const {
    data: { user },
    error,
  } = bearerToken ? await supabase.auth.getUser(bearerToken) : await supabase.auth.getUser();

  if (error || !user) {
    return {
      context: null,
      response: corsJson(request, { error: 'Authentication required' }, { status: 401 }),
    };
  }

  return {
    context: {
      supabase,
      user,
      userId: user.id,
      authSource: bearerToken ? 'bearer' : 'session',
    },
    response: null,
  };
}

export async function requireMissionControlApiKeyRoute(
  request: NextRequest
): Promise<RouteAuthResult> {
  const internalContext = readInternalAuthContext<AuthenticatedRouteContext>(request);
  if (internalContext) {
    return {
      context: internalContext,
      response: null,
    };
  }

  const machineAuth = await requireMachineKeyRoute(request);
  if (machineAuth) {
    return machineAuth;
  }

  return {
    context: null,
    response: corsJson(
      request,
      { error: 'X-Mission-Control-Key header required' },
      { status: 401 }
    ),
  };
}
