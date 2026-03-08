export type DeploymentRole = 'main' | 'mcp';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getDeploymentRole(): DeploymentRole {
  const raw = process.env.DEPLOYMENT_ROLE?.trim().toLowerCase();
  return raw === 'mcp' ? 'mcp' : 'main';
}

export function isMcpDeployment(): boolean {
  return getDeploymentRole() === 'mcp';
}

export function getCanonicalAppUrl(fallbackOrigin?: string): string {
  const configured = process.env.MCP_CANONICAL_APP_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  if (fallbackOrigin) {
    return trimTrailingSlash(fallbackOrigin);
  }

  return 'http://localhost:3000';
}

export function getUpstreamApiUrl(): string {
  const configured = process.env.MCP_UPSTREAM_API_URL?.trim();
  if (!configured) {
    throw new Error('Missing MCP_UPSTREAM_API_URL');
  }

  return trimTrailingSlash(configured);
}
