import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  buildPkceChallenge,
  findRegisteredMcpClient,
  issueTokenPair,
  jsonOauthError,
  rotateRefreshToken,
  consumeAuthorizationCode,
} from '@/lib/mcp/oauth';
import { isMcpDeployment } from '@/lib/mcp/config';

function maskValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function describeRedirectUri(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function logTokenEvent(event: string, requestId: string, payload: Record<string, unknown>) {
  console.info(`[mcp-oauth][token][${requestId}] ${event}`, payload);
}

function readFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function parseForm(request: NextRequest): Promise<FormData> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    return request.formData();
  }

  const text = await request.text();
  return new URLSearchParams(text) as unknown as FormData;
}

export async function POST(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requestId = randomUUID().slice(0, 8);
  const form = await parseForm(request);
  const grantType = readFormValue(form, 'grant_type');
  const clientId = readFormValue(form, 'client_id');
  const redirectUri = readFormValue(form, 'redirect_uri');

  logTokenEvent('request', requestId, {
    grantType,
    clientId: maskValue(clientId),
    redirectUri: describeRedirectUri(redirectUri),
    hasCode: Boolean(readFormValue(form, 'code')),
    hasCodeVerifier: Boolean(readFormValue(form, 'code_verifier')),
    hasRefreshToken: Boolean(readFormValue(form, 'refresh_token')),
    userAgent: request.headers.get('user-agent'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    contentType: request.headers.get('content-type'),
  });

  if (grantType === 'authorization_code') {
    const code = readFormValue(form, 'code');
    const codeVerifier = readFormValue(form, 'code_verifier');

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      logTokenEvent('invalid_authorization_code_request', requestId, {
        clientId: maskValue(clientId),
        redirectUri: describeRedirectUri(redirectUri),
      });
      return jsonOauthError('invalid_request', 'code, client_id, redirect_uri, and code_verifier are required');
    }

    const client = await findRegisteredMcpClient(clientId);
    if (!client) {
      logTokenEvent('unknown_client', requestId, {
        clientId: maskValue(clientId),
        grantType,
      });
      return jsonOauthError('invalid_client', 'Unknown client_id', 401);
    }

    if (!client.redirect_uris.includes(redirectUri)) {
      logTokenEvent('redirect_uri_mismatch', requestId, {
        clientId: maskValue(clientId),
        redirectUri: describeRedirectUri(redirectUri),
        registeredRedirectUris: client.redirect_uris.map(describeRedirectUri),
      });
      return jsonOauthError('invalid_grant', 'redirect_uri does not match registered client');
    }

    const authorizationCode = await consumeAuthorizationCode(code);
    if (!authorizationCode) {
      logTokenEvent('invalid_or_expired_code', requestId, {
        clientId: maskValue(clientId),
        redirectUri: describeRedirectUri(redirectUri),
        code: maskValue(code),
      });
      return jsonOauthError('invalid_grant', 'authorization code is invalid, expired, or already used');
    }

    if (authorizationCode.client_id !== clientId || authorizationCode.redirect_uri !== redirectUri) {
      logTokenEvent('code_client_or_redirect_mismatch', requestId, {
        clientId: maskValue(clientId),
        redirectUri: describeRedirectUri(redirectUri),
      });
      return jsonOauthError('invalid_grant', 'authorization code does not match client or redirect_uri');
    }

    if (buildPkceChallenge(codeVerifier) !== authorizationCode.code_challenge) {
      logTokenEvent('pkce_verifier_mismatch', requestId, {
        clientId: maskValue(clientId),
        redirectUri: describeRedirectUri(redirectUri),
        code: maskValue(code),
      });
      return jsonOauthError('invalid_grant', 'code_verifier is invalid');
    }

    const tokens = await issueTokenPair({
      clientId,
      userId: authorizationCode.user_id,
      scope: authorizationCode.scope,
    });

    logTokenEvent('issued_tokens', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
      scope: authorizationCode.scope,
      accessToken: maskValue(tokens.accessToken),
      refreshToken: maskValue(tokens.refreshToken),
    });

    return NextResponse.json({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: tokens.refreshToken,
      scope: authorizationCode.scope,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = readFormValue(form, 'refresh_token');

    if (!refreshToken || !clientId) {
      logTokenEvent('invalid_refresh_request', requestId, {
        clientId: maskValue(clientId),
      });
      return jsonOauthError('invalid_request', 'refresh_token and client_id are required');
    }

    const client = await findRegisteredMcpClient(clientId);
    if (!client) {
      logTokenEvent('unknown_refresh_client', requestId, {
        clientId: maskValue(clientId),
      });
      return jsonOauthError('invalid_client', 'Unknown client_id', 401);
    }

    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) {
      logTokenEvent('invalid_refresh_token', requestId, {
        clientId: maskValue(clientId),
        refreshToken: maskValue(refreshToken),
      });
      return jsonOauthError('invalid_grant', 'refresh_token is invalid or expired');
    }

    if (rotated.current.client_id !== clientId) {
      logTokenEvent('refresh_client_mismatch', requestId, {
        clientId: maskValue(clientId),
      });
      return jsonOauthError('invalid_grant', 'refresh_token does not belong to client_id');
    }

    logTokenEvent('rotated_tokens', requestId, {
      clientId: maskValue(clientId),
      scope: rotated.current.scope,
      accessToken: maskValue(rotated.issued.accessToken),
      refreshToken: maskValue(rotated.issued.refreshToken),
    });

    return NextResponse.json({
      access_token: rotated.issued.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.issued.refreshToken,
      scope: rotated.current.scope,
    });
  }

  logTokenEvent('unsupported_grant_type', requestId, {
    grantType,
    clientId: maskValue(clientId),
  });
  return jsonOauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
}
