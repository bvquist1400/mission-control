import { NextRequest, NextResponse } from 'next/server';
import {
  buildPublicClientRegistrationResponse,
  createRegisteredMcpClient,
  isValidRedirectUri,
  validateScopeInput,
} from '@/lib/mcp/oauth';
import { isMcpDeployment } from '@/lib/mcp/config';

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

  let body: RegistrationRequestBody = {};
  try {
    body = (await request.json()) as RegistrationRequestBody;
  } catch {
    body = {};
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  if (redirectUris.length === 0) {
    return NextResponse.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris must be a non-empty array',
      },
      { status: 400 }
    );
  }

  if (!redirectUris.every((uri) => isValidRedirectUri(uri))) {
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

  return NextResponse.json(buildPublicClientRegistrationResponse(client), { status: 201 });
}
