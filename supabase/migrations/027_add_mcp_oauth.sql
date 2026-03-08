-- MCP OAuth persistence for remote public integrations.

CREATE TABLE IF NOT EXISTS oauth_mcp_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL,
  grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  response_types TEXT[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope TEXT NOT NULL DEFAULT 'mcp.read mcp.write',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_mcp_clients_token_endpoint_auth_method_check
    CHECK (token_endpoint_auth_method = 'none')
);

CREATE TABLE IF NOT EXISTS oauth_mcp_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_mcp_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_mcp_authorization_codes_code_challenge_method_check
    CHECK (code_challenge_method = 'S256')
);

CREATE TABLE IF NOT EXISTS oauth_mcp_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_mcp_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_mcp_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_mcp_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_mcp_authorization_codes_client
  ON oauth_mcp_authorization_codes(client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oauth_mcp_access_tokens_user
  ON oauth_mcp_access_tokens(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_oauth_mcp_refresh_tokens_user
  ON oauth_mcp_refresh_tokens(user_id, created_at DESC);

ALTER TABLE oauth_mcp_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_mcp_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_mcp_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_mcp_refresh_tokens ENABLE ROW LEVEL SECURITY;
