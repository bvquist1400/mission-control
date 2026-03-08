import { NextRequest, NextResponse } from 'next/server';
import { handleMcpUpstreamRequest } from '@/app/api/mcp/route';
import { requireMcpOauthRoute } from '@/lib/mcp/oauth';

async function handleRequest(request: NextRequest): Promise<Response> {
  const auth = await requireMcpOauthRoute(request, 'mcp.read');
  if (auth.response || !auth.context) {
    return auth.response as NextResponse;
  }

  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!bearerToken) {
    return NextResponse.json(
      {
        error: 'invalid_token',
        error_description: 'Bearer token required',
      },
      { status: 401 }
    );
  }

  return handleMcpUpstreamRequest(request, {
    bearerToken,
    userId: auth.context.userId,
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRequest(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRequest(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleRequest(request);
}
