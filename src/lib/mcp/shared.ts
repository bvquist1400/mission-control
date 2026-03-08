export type McpScope = 'mcp.read' | 'mcp.write' | 'mcp.delete';

export const ALL_MCP_SCOPES: readonly McpScope[] = ['mcp.read', 'mcp.write', 'mcp.delete'] as const;
export const DEFAULT_MCP_SCOPES: readonly McpScope[] = ['mcp.read', 'mcp.write'] as const;

export interface RegisteredMcpClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
  scope: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

function scopeSortOrder(scope: McpScope): number {
  return ALL_MCP_SCOPES.indexOf(scope);
}

export function parseScopeString(input: string | null | undefined): McpScope[] {
  if (!input) {
    return [];
  }

  const values = input
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return values.filter((value): value is McpScope => ALL_MCP_SCOPES.includes(value as McpScope));
}

export function normalizeMcpScopeString(
  input: string | null | undefined,
  defaults: readonly McpScope[] = DEFAULT_MCP_SCOPES
): string {
  const parsed = parseScopeString(input);
  const scopes = parsed.length > 0 ? parsed : [...defaults];
  const unique = [...new Set(scopes)].sort((left, right) => scopeSortOrder(left) - scopeSortOrder(right));
  return unique.join(' ');
}

export function validateScopeInput(
  input: string | null | undefined,
  defaults: readonly McpScope[] = DEFAULT_MCP_SCOPES
): { scope: string; invalidScopes: string[] } {
  const rawValues = (input || '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const invalidScopes = rawValues.filter((value) => !ALL_MCP_SCOPES.includes(value as McpScope));
  return {
    scope: normalizeMcpScopeString(input, defaults),
    invalidScopes,
  };
}

export function hasRequiredScopes(
  grantedScope: string,
  requiredScopes: readonly McpScope[] | McpScope
): boolean {
  const granted = new Set(parseScopeString(grantedScope));
  const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  return required.every((scope) => granted.has(scope));
}

export function getRequiredMcpScopesForMethod(method: string): readonly McpScope[] {
  const normalized = method.toUpperCase();
  if (normalized === 'DELETE') {
    return ['mcp.delete'] as const;
  }

  if (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') {
    return ['mcp.read'] as const;
  }

  return ['mcp.write'] as const;
}

export function canUseMcpOauthPath(pathname: string): boolean {
  return pathname === '/api/mcp-upstream' || pathname.startsWith('/api/mcp-upstream/');
}

export function buildPublicClientRegistrationResponse(client: RegisteredMcpClient): Record<string, unknown> {
  const issuedAt = Math.floor(new Date(client.created_at).getTime() / 1000);
  return {
    client_id: client.client_id,
    client_id_issued_at: issuedAt,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    scope: client.scope,
    ...client.metadata,
  };
}
