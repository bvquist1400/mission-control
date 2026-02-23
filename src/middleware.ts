import { NextRequest, NextResponse } from 'next/server';
import { applyCorsHeaders, getAllowedCorsOrigin } from '@/lib/cors';

export function middleware(request: NextRequest) {
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
  matcher: ['/api/:path*'],
};
