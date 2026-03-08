import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server.js';
import {
  ALL_MCP_SCOPES,
  buildPublicClientRegistrationResponse,
  canUseMcpOauthPath,
  DEFAULT_MCP_SCOPES,
  hasRequiredScopes,
  type McpScope,
  normalizeMcpScopeString,
  parseScopeString,
  type RegisteredMcpClient,
  validateScopeInput,
} from '@/lib/mcp/shared';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { AuthenticatedRouteContext } from '@/lib/supabase/route-auth';

export {
  ALL_MCP_SCOPES,
  buildPublicClientRegistrationResponse,
  canUseMcpOauthPath,
  DEFAULT_MCP_SCOPES,
  hasRequiredScopes,
  normalizeMcpScopeString,
  parseScopeString,
  validateScopeInput,
};
export type { McpScope, RegisteredMcpClient };
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface McpAccessTokenRecord {
  id: string;
  client_id: string;
  user_id: string;
  scope: string;
  expires_at: string;
}

interface AuthorizationCodeInsert {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

interface StoredAuthorizationCode {
  id: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  expires_at: string;
  used_at: string | null;
}

interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function buildPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isValidRedirectUri(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === 'https:') {
      return true;
    }

    if (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function buildOauthErrorRedirect(
  redirectUri: string,
  error: string,
  state?: string | null,
  description?: string | null
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) {
    url.searchParams.set('error_description', description);
  }
  if (state) {
    url.searchParams.set('state', state);
  }
  return NextResponse.redirect(url, 302);
}

export function jsonOauthError(
  error: string,
  description: string,
  status = 400
): NextResponse {
  return NextResponse.json(
    {
      error,
      error_description: description,
    },
    { status }
  );
}


export async function createRegisteredMcpClient(input: {
  clientName: string | null;
  redirectUris: string[];
  scope: string;
  metadata?: Record<string, unknown>;
}): Promise<RegisteredMcpClient> {
  const supabase = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const clientId = generateOpaqueToken('mcp_client');
  const metadata = input.metadata ?? {};

  const payload = {
    client_id: clientId,
    client_name: input.clientName,
    redirect_uris: input.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: input.scope,
    metadata,
    created_at: nowIso,
  };

  const { data, error } = await supabase
    .from('oauth_mcp_clients')
    .insert(payload)
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Unable to register MCP OAuth client: ${error?.message ?? 'unknown error'}`);
  }

  return data as RegisteredMcpClient;
}

export async function findRegisteredMcpClient(clientId: string): Promise<RegisteredMcpClient | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('oauth_mcp_clients')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to load MCP OAuth client: ${error.message}`);
  }

  return (data as RegisteredMcpClient | null) ?? null;
}

export async function issueAuthorizationCode(input: AuthorizationCodeInsert): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const code = generateOpaqueToken('mcp_code');
  const codeHash = hashOpaqueToken(code);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString();

  const { error } = await supabase.from('oauth_mcp_authorization_codes').insert({
    code_hash: codeHash,
    client_id: input.clientId,
    user_id: input.userId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Unable to issue MCP authorization code: ${error.message}`);
  }

  return code;
}

export async function consumeAuthorizationCode(
  code: string
): Promise<StoredAuthorizationCode | null> {
  const supabase = createSupabaseAdminClient();
  const codeHash = hashOpaqueToken(code);

  const { data, error } = await supabase
    .from('oauth_mcp_authorization_codes')
    .select('*')
    .eq('code_hash', codeHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to load MCP authorization code: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  if (data.used_at) {
    return null;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const { error: updateError } = await supabase
    .from('oauth_mcp_authorization_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('used_at', null);

  if (updateError) {
    throw new Error(`Unable to consume MCP authorization code: ${updateError.message}`);
  }

  return data as StoredAuthorizationCode;
}

export async function issueTokenPair(input: {
  clientId: string;
  userId: string;
  scope: string;
}): Promise<IssuedTokenPair> {
  const supabase = createSupabaseAdminClient();
  const accessToken = generateOpaqueToken('mcp_at');
  const refreshToken = generateOpaqueToken('mcp_rt');
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  const { error: accessError } = await supabase.from('oauth_mcp_access_tokens').insert({
    token_hash: hashOpaqueToken(accessToken),
    client_id: input.clientId,
    user_id: input.userId,
    scope: input.scope,
    expires_at: accessTokenExpiresAt.toISOString(),
  });

  if (accessError) {
    throw new Error(`Unable to issue MCP access token: ${accessError.message}`);
  }

  const { error: refreshError } = await supabase.from('oauth_mcp_refresh_tokens').insert({
    token_hash: hashOpaqueToken(refreshToken),
    client_id: input.clientId,
    user_id: input.userId,
    scope: input.scope,
    expires_at: refreshTokenExpiresAt.toISOString(),
  });

  if (refreshError) {
    throw new Error(`Unable to issue MCP refresh token: ${refreshError.message}`);
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  };
}

export async function rotateRefreshToken(
  refreshToken: string
): Promise<{ current: Record<string, unknown>; issued: IssuedTokenPair } | null> {
  const supabase = createSupabaseAdminClient();
  const tokenHash = hashOpaqueToken(refreshToken);
  const { data, error } = await supabase
    .from('oauth_mcp_refresh_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to load MCP refresh token: ${error.message}`);
  }

  if (!data || data.revoked_at || new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const issued = await issueTokenPair({
    clientId: data.client_id,
    userId: data.user_id,
    scope: data.scope,
  });

  const { error: revokeError } = await supabase
    .from('oauth_mcp_refresh_tokens')
    .update({
      revoked_at: new Date().toISOString(),
      replaced_by_token_hash: hashOpaqueToken(issued.refreshToken),
    })
    .eq('id', data.id)
    .is('revoked_at', null);

  if (revokeError) {
    throw new Error(`Unable to rotate MCP refresh token: ${revokeError.message}`);
  }

  return { current: data, issued };
}

export async function validateMcpAccessToken(
  token: string
): Promise<McpAccessTokenRecord | null> {
  const supabase = createSupabaseAdminClient();
  const tokenHash = hashOpaqueToken(token);
  const { data, error } = await supabase
    .from('oauth_mcp_access_tokens')
    .select('id, client_id, user_id, scope, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to validate MCP access token: ${error.message}`);
  }

  if (!data || data.revoked_at || new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data as McpAccessTokenRecord;
}

export async function requireMcpOauthRoute(
  request: NextRequest,
  requiredScopes: readonly McpScope[] | McpScope
): Promise<{ context: AuthenticatedRouteContext | null; response: NextResponse | null; scope: string | null }> {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return {
      context: null,
      response: jsonOauthError('invalid_token', 'Bearer token required', 401),
      scope: null,
    };
  }

  const tokenRecord = await validateMcpAccessToken(token);
  if (!tokenRecord) {
    return {
      context: null,
      response: jsonOauthError('invalid_token', 'Access token is invalid or expired', 401),
      scope: null,
    };
  }

  if (!hasRequiredScopes(tokenRecord.scope, requiredScopes)) {
    return {
      context: null,
      response: jsonOauthError('insufficient_scope', 'Access token does not include the required scope', 403),
      scope: tokenRecord.scope,
    };
  }

  const supabase = createSupabaseAdminClient();
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(tokenRecord.user_id);

  if (userError || !userData?.user) {
    return {
      context: null,
      response: jsonOauthError('invalid_token', 'Access token user could not be resolved', 401),
      scope: tokenRecord.scope,
    };
  }

  return {
    context: {
      supabase,
      user: userData.user,
      userId: tokenRecord.user_id,
      authSource: 'mcp_oauth',
    },
    response: null,
    scope: tokenRecord.scope,
  };
}
