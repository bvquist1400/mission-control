import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { withCorsHeaders } from '@/lib/cors';
import { secureCompare } from '@/lib/secure-compare';
import { readInternalAuthContext } from '@/lib/supabase/internal-auth';
import { isFamcalKeyRouteAllowed } from '@/lib/famcal-api-key';
import { isRefusedCollidingMachineKey, readMachineApiKeys, type MachineApiKeys } from '@/lib/machine-keys';

export type AuthSource =
  | 'session'
  | 'bearer'
  | 'legacy_api_key'
  | 'actions_api_key'
  | 'famcal_api_key'
  | 'mcp_oauth';

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

export type MachineAuthSource = Extract<AuthSource, 'legacy_api_key' | 'actions_api_key' | 'famcal_api_key'>;

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
  { pattern: /^\/api\/notes$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/notes\/meeting$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+$/, methods: ['GET', 'PATCH'] },
  { pattern: /^\/api\/notes\/[^/]+\/archive$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/links$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/links\/unlink$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/tasks$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/tasks\/create$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/decisions$/, methods: ['POST'] },
  { pattern: /^\/api\/notes\/[^/]+\/decisions\/[^/]+$/, methods: ['PATCH'] },
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

function isActionsKeyRouteAllowed(method: string, pathname: string): boolean {
  if (method === 'DELETE') {
    return false;
  }

  return ACTIONS_ROUTE_ALLOWLIST.some(
    (rule) => rule.methods.includes(method) && rule.pattern.test(pathname)
  );
}

export type { MachineApiKeys } from '@/lib/machine-keys';
export { famcalKeyCollisions, isRefusedCollidingMachineKey, readMachineApiKeys } from '@/lib/machine-keys';

/**
 * Which machine key the caller presented. Checked in a fixed order (legacy,
 * actions, FamCal) so the two existing keys behave exactly as before when every
 * key has its own value. A value shared with the FamCal key resolves to nothing
 * (see isRefusedCollidingMachineKey).
 */
export function resolveMachineKeySource(
  providedApiKey: string,
  keys: MachineApiKeys
): MachineAuthSource | null {
  if (isRefusedCollidingMachineKey(providedApiKey, keys)) {
    return null;
  }
  if (keys.legacy && secureCompare(providedApiKey, keys.legacy)) {
    return 'legacy_api_key';
  }
  if (keys.actions && secureCompare(providedApiKey, keys.actions)) {
    return 'actions_api_key';
  }
  if (keys.famcal && secureCompare(providedApiKey, keys.famcal)) {
    return 'famcal_api_key';
  }
  return null;
}

/** Legacy: every route. Actions: its allowlist, no DELETE. FamCal: personal-task routes only. */
export function isMachineKeyRouteAllowed(
  authSource: MachineAuthSource,
  method: string,
  pathname: string
): boolean {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizePathname(pathname);

  if (authSource === 'actions_api_key') {
    return isActionsKeyRouteAllowed(normalizedMethod, normalizedPath);
  }
  if (authSource === 'famcal_api_key') {
    return isFamcalKeyRouteAllowed(normalizedMethod, normalizedPath);
  }
  return true;
}

const MACHINE_KEY_FORBIDDEN_MESSAGES: Record<Exclude<MachineAuthSource, 'legacy_api_key'>, string> = {
  actions_api_key: 'The actions API key is not permitted for this route',
  famcal_api_key: 'The FamCal API key is not permitted for this route',
};

async function requireMachineKeyRoute(request: NextRequest): Promise<RouteAuthResult | null> {
  const providedApiKey = request.headers.get('x-mission-control-key')?.trim();
  if (!providedApiKey) {
    return null;
  }

  const keys = readMachineApiKeys();
  const apiUserId = process.env.MISSION_CONTROL_USER_ID?.trim();

  if (!apiUserId || (!keys.legacy && !keys.actions && !keys.famcal)) {
    return {
      context: null,
      response: corsJson(
        request,
        { error: 'API key auth is not configured on this server' },
        { status: 503 }
      ),
    };
  }

  const authSource = resolveMachineKeySource(providedApiKey, keys);

  if (!authSource) {
    return {
      context: null,
      response: corsJson(request, { error: 'Invalid API key' }, { status: 401 }),
    };
  }

  if (
    authSource !== 'legacy_api_key'
    && !isMachineKeyRouteAllowed(authSource, request.method, request.nextUrl.pathname)
  ) {
    return {
      context: null,
      response: corsJson(
        request,
        { error: MACHINE_KEY_FORBIDDEN_MESSAGES[authSource] },
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
