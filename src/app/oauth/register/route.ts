import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  buildPublicClientRegistrationResponse,
  createRegisteredMcpClient,
  isValidRedirectUri,
  validateScopeInput,
} from '@/lib/mcp/oauth';
import { isMcpDeployment } from '@/lib/mcp/config';

function describeRedirectUri(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function maskValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function logRegisterEvent(event: string, requestId: string, payload: Record<string, unknown>) {
  console.info(`[mcp-oauth][register][${requestId}] ${event}`, payload);
}

interface RegistrationRequestBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
  software_id?: unknown;
  software_version?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

export async function POST(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requestId = randomUUID().slice(0, 8);
  let body: RegistrationRequestBody = {};
  try {
    body = (await request.json()) as RegistrationRequestBody;
  } catch {
    body = {};
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  logRegisterEvent('request', requestId, {
    clientName: asString(body.client_name),
    redirectUris: redirectUris.map(describeRedirectUri),
    tokenEndpointAuthMethod: asString(body.token_endpoint_auth_method),
    scope: asString(body.scope),
    softwareId: asString(body.software_id),
    softwareVersion: asString(body.software_version),
    userAgent: request.headers.get('user-agent'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
  });

  if (redirectUris.length === 0) {
    logRegisterEvent('invalid_redirect_uris', requestId, {
      redirectUris,
    });
    return NextResponse.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris must be a non-empty array',
      },
      { status: 400 }
    );
  }

  if (!redirectUris.every((uri) => isValidRedirectUri(uri))) {
    logRegisterEvent('invalid_redirect_uri_format', requestId, {
      redirectUris: redirectUris.map(describeRedirectUri),
    });
    return NextResponse.json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'Every redirect URI must be https:// or localhost loopback',
      },
      { status: 400 }
    );
  }

  const tokenEndpointAuthMethod = asString(body.token_endpoint_auth_method) || 'none';
  if (tokenEndpointAuthMethod !== 'none') {
    logRegisterEvent('invalid_token_endpoint_auth_method', requestId, {
      tokenEndpointAuthMethod,
    });
    return NextResponse.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Only token_endpoint_auth_method=none is supported',
      },
      { status: 400 }
    );
  }

  const scopeValidation = validateScopeInput(asString(body.scope));
  if (scopeValidation.invalidScopes.length > 0) {
    logRegisterEvent('invalid_scope', requestId, {
      invalidScopes: scopeValidation.invalidScopes,
      scope: asString(body.scope),
    });
    return NextResponse.json(
      {
        error: 'invalid_scope',
        error_description: `Invalid MCP scope(s): ${scopeValidation.invalidScopes.join(', ')}`,
      },
      { status: 400 }
    );
  }

  const client = await createRegisteredMcpClient({
    clientName: asString(body.client_name),
    redirectUris,
    scope: scopeValidation.scope,
    metadata: {
      software_id: asString(body.software_id),
      software_version: asString(body.software_version),
    },
  });

  logRegisterEvent('registered_client', requestId, {
    clientId: maskValue(client.client_id),
    redirectUris: client.redirect_uris.map(describeRedirectUri),
    scope: client.scope,
  });

  return NextResponse.json(buildPublicClientRegistrationResponse(client), { status: 201 });
}
