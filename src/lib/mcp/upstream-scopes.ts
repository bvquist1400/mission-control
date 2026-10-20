/**
 * OAuth scopes the MCP upstream router (src/app/api/mcp-upstream/[...path]) needs
 * for an API path and method. Reads need mcp.read, writes mcp.write, real deletes
 * mcp.delete; a few POSTs are reads and a few DELETEs are really updates.
 */
export function getRequiredScopesForPath(pathSegments: string[], method: string): readonly ('mcp.read' | 'mcp.write' | 'mcp.delete')[] {
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

  // remove_task_dependency: the DELETE only marks the link resolved (an UPDATE;
  // the row and its "recently unblocked" history stay), so it needs write, like
  // adding one. Connector tokens are often granted read + write only.
  if (
    normalizedMethod === 'DELETE' &&
    pathSegments[0] === 'tasks' &&
    pathSegments[2] === 'dependencies'
  ) {
    return ['mcp.write'] as const;
  }

  if (
    normalizedMethod === 'POST'
    && pathSegments[0] === 'tasks'
    && pathSegments[1] === 'lookup-external'
  ) {
    return ['mcp.read'] as const;
  }

  if (normalizedMethod === 'DELETE') {
    return ['mcp.delete'] as const;
  }

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') {
    return ['mcp.read'] as const;
  }

  return ['mcp.write'] as const;
}
