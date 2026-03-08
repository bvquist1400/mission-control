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

  const form = await parseForm(request);
  const grantType = readFormValue(form, 'grant_type');

  if (grantType === 'authorization_code') {
    const code = readFormValue(form, 'code');
    const clientId = readFormValue(form, 'client_id');
    const redirectUri = readFormValue(form, 'redirect_uri');
    const codeVerifier = readFormValue(form, 'code_verifier');

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return jsonOauthError('invalid_request', 'code, client_id, redirect_uri, and code_verifier are required');
    }

    const client = await findRegisteredMcpClient(clientId);
    if (!client) {
      return jsonOauthError('invalid_client', 'Unknown client_id', 401);
    }

    if (!client.redirect_uris.includes(redirectUri)) {
      return jsonOauthError('invalid_grant', 'redirect_uri does not match registered client');
    }

    const authorizationCode = await consumeAuthorizationCode(code);
    if (!authorizationCode) {
      return jsonOauthError('invalid_grant', 'authorization code is invalid, expired, or already used');
    }

    if (authorizationCode.client_id !== clientId || authorizationCode.redirect_uri !== redirectUri) {
      return jsonOauthError('invalid_grant', 'authorization code does not match client or redirect_uri');
    }

    if (buildPkceChallenge(codeVerifier) !== authorizationCode.code_challenge) {
      return jsonOauthError('invalid_grant', 'code_verifier is invalid');
    }

    const tokens = await issueTokenPair({
      clientId,
      userId: authorizationCode.user_id,
      scope: authorizationCode.scope,
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
    const clientId = readFormValue(form, 'client_id');

    if (!refreshToken || !clientId) {
      return jsonOauthError('invalid_request', 'refresh_token and client_id are required');
    }

    const client = await findRegisteredMcpClient(clientId);
    if (!client) {
      return jsonOauthError('invalid_client', 'Unknown client_id', 401);
    }

    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) {
      return jsonOauthError('invalid_grant', 'refresh_token is invalid or expired');
    }

    if (rotated.current.client_id !== clientId) {
      return jsonOauthError('invalid_grant', 'refresh_token does not belong to client_id');
    }

    return NextResponse.json({
      access_token: rotated.issued.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.issued.refreshToken,
      scope: rotated.current.scope,
    });
  }

  return jsonOauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
}
