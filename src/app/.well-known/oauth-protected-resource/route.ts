import { NextRequest, NextResponse } from 'next/server';
import { ALL_MCP_SCOPES } from '@/lib/mcp/oauth';
import { isMcpDeployment } from '@/lib/mcp/config';

function buildPayload(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ALL_MCP_SCOPES,
  };
}

export async function GET(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(buildPayload(request.nextUrl.origin));
}

export { buildPayload as buildProtectedResourcePayload };
