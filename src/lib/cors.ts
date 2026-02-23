import { NextRequest, NextResponse } from 'next/server';

const CORS_ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS = 'Content-Type, X-Mission-Control-Key';

function isAllowedClaudeOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
  } catch {
    return false;
  }
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }

  const parts = existing.split(',').map((item) => item.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`);
  }
}

export function getAllowedCorsOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }

  return isAllowedClaudeOrigin(origin) ? origin : null;
}

export function applyCorsHeaders(headers: Headers, origin: string | null): void {
  headers.set('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  appendVaryHeader(headers, 'Origin');

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
}

export function withCorsHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const allowedOrigin = getAllowedCorsOrigin(request.headers.get('origin'));
  applyCorsHeaders(response.headers, allowedOrigin);
  return response;
}
