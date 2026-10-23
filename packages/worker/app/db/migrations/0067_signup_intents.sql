-- Sign-up verifies the email address before a passkey is created: the form
-- stores an intent and mails a link carrying its token; the passkey ceremony
-- on that link consumes the intent and creates the account. Only the token's
-- SHA-256 digest is stored.
CREATE TABLE signup_intents (
  token_hash TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_signup_intents_email ON signup_intents (email);
