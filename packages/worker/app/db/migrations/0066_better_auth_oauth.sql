-- Sign-in moves from Cloudflare Access to Void's Better Auth (passkeys + the
-- admin plugin), and Mastodon clients get a real OAuth 2 authorization server.
--
-- The first five tables are Better Auth's schema as `void build` emits it in
-- `.void/better-auth-schema.ts`; `void deploy` checks that these migrations
-- produce it. Column names are Better Auth's (camelCase); timestamps are epoch
-- milliseconds and booleans 0/1, as its Drizzle SQLite adapter writes them.

CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  -- admin plugin: `admin` makes the linked local account an instance admin.
  "role" TEXT,
  "banned" INTEGER,
  "banReason" TEXT,
  "banExpires" INTEGER
);

CREATE TABLE "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "impersonatedBy" TEXT
);
CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE "passkey" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT,
  "createdAt" INTEGER,
  "aaguid" TEXT
);
CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");

-- The Better Auth user a local account signs in as. Accounts provisioned under
-- Cloudflare Access have none until an admin links one.
ALTER TABLE accounts ADD COLUMN auth_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_accounts_auth_user ON accounts (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- Mastodon OAuth: apps registered through `POST /api/v1/apps`. Secrets and
-- tokens are stored as SHA-256 hex digests, never in the clear.
CREATE TABLE oauth_applications (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  -- Newline-separated, in registration order.
  redirect_uris TEXT NOT NULL,
  -- Space-separated, as in OAuth.
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  application_id TEXT NOT NULL REFERENCES oauth_applications (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_oauth_authorization_codes_application
  ON oauth_authorization_codes (application_id);
CREATE INDEX idx_oauth_authorization_codes_account
  ON oauth_authorization_codes (account_id);

-- `account_id` is NULL for a client_credentials (app-only) token.
CREATE TABLE oauth_access_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL REFERENCES oauth_applications (id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_oauth_access_tokens_application
  ON oauth_access_tokens (application_id);
CREATE INDEX idx_oauth_access_tokens_account
  ON oauth_access_tokens (account_id) WHERE account_id IS NOT NULL;
