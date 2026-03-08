import { NextRequest, NextResponse } from 'next/server';
import { isMcpDeployment } from '@/lib/mcp/config';
import { buildProtectedResourcePayload } from '@/app/.well-known/oauth-protected-resource/route';

export async function GET(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(buildProtectedResourcePayload(request.nextUrl.origin));
}
