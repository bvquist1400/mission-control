import { NextRequest, NextResponse } from 'next/server';
import { applyCorsHeaders, getAllowedCorsOrigin } from '@/lib/cors';
import { getDeploymentRole } from '@/lib/mcp/config';

const MCP_ALLOWED_PREFIXES = [
  '/api/mcp',
  '/oauth',
  '/.well-known',
  '/login',
  '/auth/callback',
  '/_next',
];

const MCP_ALLOWED_EXACT_PATHS = new Set([
  '/favicon.ico',
]);

const CORS_ENABLED_PREFIXES = [
  '/api/',
  '/oauth',
  '/.well-known',
];

function isAllowedMcpPath(pathname: string): boolean {
  if (MCP_ALLOWED_EXACT_PATHS.has(pathname)) {
    return true;
  }

  return MCP_ALLOWED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isCorsEnabledPath(pathname: string): boolean {
  return CORS_ENABLED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export function middleware(request: NextRequest) {
  if (getDeploymentRole() === 'mcp' && !isAllowedMcpPath(request.nextUrl.pathname)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  if (!isCorsEnabledPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const allowedOrigin = getAllowedCorsOrigin(request.headers.get('origin'));

  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 200 });
    applyCorsHeaders(response.headers, allowedOrigin);
    return response;
  }

  const response = NextResponse.next();
  applyCorsHeaders(response.headers, allowedOrigin);
  return response;
}

export const config = {
  matcher: ['/:path*'],
};
