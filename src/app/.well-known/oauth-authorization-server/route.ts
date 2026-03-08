import { NextRequest, NextResponse } from 'next/server';
import { ALL_MCP_SCOPES } from '@/lib/mcp/oauth';
import { isMcpDeployment } from '@/lib/mcp/config';

export async function GET(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const origin = request.nextUrl.origin;

  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ALL_MCP_SCOPES,
  });
}
