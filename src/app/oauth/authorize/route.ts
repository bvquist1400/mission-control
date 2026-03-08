import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  buildOauthErrorRedirect,
  findRegisteredMcpClient,
  isValidRedirectUri,
  issueAuthorizationCode,
  validateScopeInput,
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

function logAuthorizeEvent(event: string, requestId: string, payload: Record<string, unknown>) {
  console.info(`[mcp-oauth][authorize][${requestId}] ${event}`, payload);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRequestedValue(searchParams: URLSearchParams | FormData, key: string): string | null {
  const raw = searchParams.get(key);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

type OAuthAuthorizeResponseMode = 'query' | 'form_post';

function getAuthorizeResponseMode(value: string | null): OAuthAuthorizeResponseMode | null {
  if (!value || value === 'query') {
    return 'query';
  }

  if (value === 'form_post') {
    return 'form_post';
  }

  return null;
}

function resolveAuthorizeResponseMode(
  _redirectUri: string,
  requestedResponseMode: string | null
): OAuthAuthorizeResponseMode | null {
  if (!requestedResponseMode) {
    return 'query';
  }

  return getAuthorizeResponseMode(requestedResponseMode);
}

function buildFormPostHtml(redirectUri: string, values: Record<string, string>): string {
  const inputs = Object.entries(values)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Completing authorization</title>
  </head>
  <body>
    <form id="oauth-form-post" method="POST" action="${escapeHtml(redirectUri)}">
        ${inputs}
    </form>
    <script>
      document.getElementById('oauth-form-post')?.submit();
    </script>
  </body>
</html>`;
}

function buildAuthorizeSuccessResponse(
  redirectUri: string,
  code: string,
  state: string | null,
  responseMode: OAuthAuthorizeResponseMode
): NextResponse {
  if (responseMode === 'form_post') {
    const values: Record<string, string> = { code };
    if (state) {
      values.state = state;
    }

    return new NextResponse(buildFormPostHtml(redirectUri, values), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  }

  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) {
    url.searchParams.set('state', state);
  }

  // Use 302 (not Next.js default 307) so the browser switches from POST to GET
  // when following the redirect to the OAuth callback.
  return NextResponse.redirect(url, 302);
}

function buildAuthorizeErrorResponse(
  redirectUri: string,
  error: string,
  state: string | null,
  description: string,
  responseMode: OAuthAuthorizeResponseMode
): NextResponse {
  if (responseMode === 'form_post') {
    const values: Record<string, string> = {
      error,
      error_description: description,
    };
    if (state) {
      values.state = state;
    }

    return new NextResponse(buildFormPostHtml(redirectUri, values), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  }

  return buildOauthErrorRedirect(redirectUri, error, state, description);
}

function buildAuthorizeHtml(input: {
  clientName: string;
  userEmail: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  responseMode: OAuthAuthorizeResponseMode;
}): string {
  const deleteRequested = input.scope.split(/\s+/).includes('mcp.delete');
  const dangerNote = deleteRequested
    ? '<p style="color:#a11;font-weight:600;">This request includes destructive delete access.</p>'
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize MCP Client</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f2ea; color: #1d1d1d; margin: 0; }
      main { max-width: 640px; margin: 5rem auto; background: white; border: 1px solid #d9d4c8; border-radius: 16px; padding: 2rem; }
      h1 { margin-top: 0; }
      code { background: #f6f4ee; padding: 0.125rem 0.3rem; border-radius: 4px; }
      .actions { display: flex; gap: 0.75rem; margin-top: 2rem; }
      button { border: 0; border-radius: 999px; padding: 0.75rem 1rem; font-weight: 600; cursor: pointer; }
      .approve { background: #1d6b4d; color: white; }
      .deny { background: #ece7dc; color: #1d1d1d; }
      ul { padding-left: 1.25rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Authorize MCP client</h1>
      <p><strong>${escapeHtml(input.clientName)}</strong> wants access to Mission Control for <strong>${escapeHtml(input.userEmail)}</strong>.</p>
      <p>Requested scopes: <code>${escapeHtml(input.scope)}</code></p>
      ${dangerNote}
      <ul>
        <li><code>mcp.read</code> allows read/search/fetch operations.</li>
        <li><code>mcp.write</code> allows non-destructive changes.</li>
        <li><code>mcp.delete</code> allows destructive deletes.</li>
      </ul>
      <form method="POST">
        <input type="hidden" name="client_id" value="${escapeHtml(input.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${escapeHtml(input.redirectUri)}" />
        <input type="hidden" name="scope" value="${escapeHtml(input.scope)}" />
        <input type="hidden" name="code_challenge" value="${escapeHtml(input.codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="response_mode" value="${escapeHtml(input.responseMode)}" />
        ${input.state ? `<input type="hidden" name="state" value="${escapeHtml(input.state)}" />` : ''}
        <div class="actions">
          <button class="approve" type="submit" name="decision" value="approve">Approve</button>
          <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>
    </main>
  </body>
</html>`;
}

async function getSignedInUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const loginUrl = new URL('/login', request.nextUrl.origin);
  loginUrl.searchParams.set('next', next);
  return NextResponse.redirect(loginUrl);
}

function validateAuthorizeRequest(values: {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  responseMode: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scope: string | null;
}) {
  if (!values.clientId || !values.redirectUri || !values.responseType || !values.codeChallenge) {
    return { error: 'invalid_request', description: 'Missing required OAuth parameters' };
  }

  if (values.responseType !== 'code') {
    return { error: 'unsupported_response_type', description: 'Only response_type=code is supported' };
  }

  const responseMode = resolveAuthorizeResponseMode(values.redirectUri, values.responseMode);
  if (!responseMode) {
    return { error: 'invalid_request', description: 'Only response_mode=query or form_post is supported' };
  }

  if (values.codeChallengeMethod && values.codeChallengeMethod !== 'S256') {
    return { error: 'invalid_request', description: 'Only code_challenge_method=S256 is supported' };
  }

  if (!isValidRedirectUri(values.redirectUri)) {
    return { error: 'invalid_redirect_uri', description: 'redirect_uri is invalid' };
  }

  const scopeValidation = validateScopeInput(values.scope);
  if (scopeValidation.invalidScopes.length > 0) {
    return {
      error: 'invalid_scope',
      description: `Invalid MCP scope(s): ${scopeValidation.invalidScopes.join(', ')}`,
    };
  }

  return {
    error: null,
    description: null,
    responseMode,
    normalizedScope: scopeValidation.scope,
  };
}

export async function GET(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requestId = randomUUID().slice(0, 8);
  const user = await getSignedInUser();
  if (!user) {
    logAuthorizeEvent('redirect_to_login', requestId, {
      pathname: request.nextUrl.pathname,
      userAgent: request.headers.get('user-agent'),
    });
    return redirectToLogin(request);
  }

  const clientId = getRequestedValue(request.nextUrl.searchParams, 'client_id');
  const redirectUri = getRequestedValue(request.nextUrl.searchParams, 'redirect_uri');
  const responseType = getRequestedValue(request.nextUrl.searchParams, 'response_type');
  const responseMode = getRequestedValue(request.nextUrl.searchParams, 'response_mode');
  const scope = getRequestedValue(request.nextUrl.searchParams, 'scope');
  const state = getRequestedValue(request.nextUrl.searchParams, 'state');
  const codeChallenge = getRequestedValue(request.nextUrl.searchParams, 'code_challenge');
  const codeChallengeMethod = getRequestedValue(request.nextUrl.searchParams, 'code_challenge_method');

  const validation = validateAuthorizeRequest({
    clientId,
    redirectUri,
    responseType,
    responseMode,
    codeChallenge,
    codeChallengeMethod,
    scope,
  });

  logAuthorizeEvent('request', requestId, {
    clientId: maskValue(clientId),
    redirectUri: describeRedirectUri(redirectUri),
    responseType,
    requestedResponseMode: responseMode,
    resolvedResponseMode: validation.responseMode ?? null,
    scope: validation.normalizedScope ?? scope,
    statePresent: Boolean(state),
    codeChallengeMethod,
    userId: user.id,
    userAgent: request.headers.get('user-agent'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
  });

  if (validation.error || !redirectUri) {
    logAuthorizeEvent('invalid_request', requestId, {
      error: validation.error ?? 'invalid_request',
      description: validation.description ?? 'Missing redirect_uri',
    });
    return NextResponse.json(
      {
        error: validation.error ?? 'invalid_request',
        error_description: validation.description ?? 'Missing redirect_uri',
      },
      { status: 400 }
    );
  }

  const client = await findRegisteredMcpClient(clientId!);
  if (!client) {
    logAuthorizeEvent('unknown_client', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
      responseMode: validation.responseMode || 'query',
    });
    return buildAuthorizeErrorResponse(
      redirectUri,
      'invalid_client',
      state,
      'Unknown client_id',
      validation.responseMode || 'query'
    );
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    logAuthorizeEvent('redirect_uri_mismatch', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
      registeredRedirectUris: client.redirect_uris.map(describeRedirectUri),
      responseMode: validation.responseMode || 'query',
    });
    return buildAuthorizeErrorResponse(
      redirectUri,
      'invalid_grant',
      state,
      'redirect_uri mismatch',
      validation.responseMode || 'query'
    );
  }

  logAuthorizeEvent('render_consent', requestId, {
    clientId: maskValue(client.client_id),
    redirectUri: describeRedirectUri(redirectUri),
    responseMode: validation.responseMode || 'query',
    scope: validation.normalizedScope || client.scope,
  });

  return new NextResponse(
    buildAuthorizeHtml({
      clientName: client.client_name || client.client_id,
      userEmail: user.email || user.id,
      clientId: client.client_id,
      redirectUri,
      scope: validation.normalizedScope || client.scope,
      state,
      codeChallenge: codeChallenge!,
      responseMode: validation.responseMode || 'query',
    }),
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    }
  );
}

export async function POST(request: NextRequest) {
  if (!isMcpDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const requestId = randomUUID().slice(0, 8);
  const user = await getSignedInUser();
  if (!user) {
    logAuthorizeEvent('post_redirect_to_login', requestId, {
      pathname: request.nextUrl.pathname,
      userAgent: request.headers.get('user-agent'),
    });
    return redirectToLogin(request);
  }

  const formData = await request.formData();
  const decision = getRequestedValue(formData, 'decision');
  const clientId = getRequestedValue(formData, 'client_id');
  const redirectUri = getRequestedValue(formData, 'redirect_uri');
  const scope = getRequestedValue(formData, 'scope');
  const state = getRequestedValue(formData, 'state');
  const responseMode = getRequestedValue(formData, 'response_mode');
  const codeChallenge = getRequestedValue(formData, 'code_challenge');
  const codeChallengeMethod = getRequestedValue(formData, 'code_challenge_method');

  const validation = validateAuthorizeRequest({
    clientId,
    redirectUri,
    responseType: 'code',
    responseMode,
    codeChallenge,
    codeChallengeMethod,
    scope,
  });

  logAuthorizeEvent('decision', requestId, {
    clientId: maskValue(clientId),
    redirectUri: describeRedirectUri(redirectUri),
    decision,
    requestedResponseMode: responseMode,
    resolvedResponseMode: validation.responseMode ?? null,
    scope: validation.normalizedScope ?? scope,
    statePresent: Boolean(state),
    userId: user.id,
    userAgent: request.headers.get('user-agent'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
  });

  if (validation.error || !redirectUri) {
    logAuthorizeEvent('post_invalid_request', requestId, {
      error: validation.error ?? 'invalid_request',
      description: validation.description ?? 'Missing redirect_uri',
    });
    return NextResponse.json(
      {
        error: validation.error ?? 'invalid_request',
        error_description: validation.description ?? 'Missing redirect_uri',
      },
      { status: 400 }
    );
  }

  const client = await findRegisteredMcpClient(clientId!);
  if (!client) {
    logAuthorizeEvent('post_unknown_client', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
    });
    return buildAuthorizeErrorResponse(
      redirectUri,
      'invalid_client',
      state,
      'Unknown client_id',
      validation.responseMode || 'query'
    );
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    logAuthorizeEvent('post_redirect_uri_mismatch', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
      registeredRedirectUris: client.redirect_uris.map(describeRedirectUri),
    });
    return buildAuthorizeErrorResponse(
      redirectUri,
      'invalid_grant',
      state,
      'redirect_uri mismatch',
      validation.responseMode || 'query'
    );
  }

  if (decision !== 'approve') {
    logAuthorizeEvent('access_denied', requestId, {
      clientId: maskValue(clientId),
      redirectUri: describeRedirectUri(redirectUri),
      responseMode: validation.responseMode || 'query',
    });
    return buildAuthorizeErrorResponse(
      redirectUri,
      'access_denied',
      state,
      'Authorization was denied',
      validation.responseMode || 'query'
    );
  }

  const code = await issueAuthorizationCode({
    clientId: client.client_id,
    userId: user.id,
    redirectUri,
    scope: validation.normalizedScope || client.scope,
    codeChallenge: codeChallenge!,
    codeChallengeMethod: 'S256',
  });

  logAuthorizeEvent('issued_code', requestId, {
    clientId: maskValue(client.client_id),
    redirectUri: describeRedirectUri(redirectUri),
    responseMode: validation.responseMode || 'query',
    statePresent: Boolean(state),
    code: maskValue(code),
  });

  return buildAuthorizeSuccessResponse(
    redirectUri,
    code,
    state,
    validation.responseMode || 'query'
  );
}
