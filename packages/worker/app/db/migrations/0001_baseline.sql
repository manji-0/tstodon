-- void:allow-destructive
-- (Void gate: it splits trigger bodies at `;` and reads each counter
-- trigger's `INSERT ... ON CONFLICT ... DO UPDATE SET` as an UPDATE without
-- WHERE. This file drops, renames and rewrites nothing.)
--
-- tstodon's D1 schema, created in one migration. Wrangler applies the files
-- in this directory in name order and records each in `d1_migrations`; a
-- schema change is a new file numbered after the last one, never an edit of
-- an applied file.
--
-- Tables are grouped by concept, each followed by its indexes and triggers.
-- The counter triggers sit together under "Counters", and the rows every
-- instance starts with under "Seed rows" at the end.

-- ==========================================================================
-- Instance
-- ==========================================================================

CREATE TABLE instance_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE instance_actor_keys (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key_pem TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- When the instance actor's key pair was last replaced (NULL: never).
  rotated_at TEXT
);

-- The web UI's own preferences (`PUT /api/web/settings`), stored as it sends
-- them and handed back in its initial state.
CREATE TABLE web_settings (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_announcements_published
  ON announcements (published_at DESC, id DESC);

CREATE TABLE account_announcement_dismissals (
  account_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, announcement_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE account_announcement_reactions (
  account_id TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  reaction_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, announcement_id, reaction_name),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_announcement_reactions_group
  ON account_announcement_reactions (announcement_id, reaction_name);

CREATE TABLE custom_emojis (
  id TEXT PRIMARY KEY,
  shortcode TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  visible_in_picker INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  image_file_size INTEGER NOT NULL
);

CREATE INDEX idx_custom_emojis_shortcode
  ON custom_emojis (shortcode);

CREATE TABLE link_cards (
  url TEXT PRIMARY KEY,
  card_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The link card refresh (`listStaleLinkCards`), oldest first.
CREATE INDEX idx_link_cards_fetched ON link_cards (fetched_at);

CREATE TABLE trend_reviews (
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (kind, target)
);

CREATE INDEX idx_trend_reviews_state ON trend_reviews (kind, state);

-- The cursors of the jobs that walk a table a page at a time, where one
-- unbounded statement could pass D1's query limits on a large instance and
-- hold the writer. `after_id` is the last key a page read; a sweep
-- (`remote_status_retention`) goes back to '' once a page comes back short.
-- The rows are seeded at the end of this file.
CREATE TABLE backfill_cursors (
  name TEXT NOT NULL PRIMARY KEY,
  after_id TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

-- ==========================================================================
-- Authentication and OAuth
-- ==========================================================================

CREATE TABLE user (
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

CREATE TABLE session (
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

CREATE TABLE account (
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

CREATE TABLE verification (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE passkey (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Mastodon's web UI, served from this Worker, calls the API with an access
  -- token embedded in its HTML. That token belongs to the built-in web app and
  -- to one Better Auth session: it goes away with the session (sign-out or
  -- expiry), and `authenticate` refuses it once the session has expired.
  web_session_id TEXT REFERENCES "session" ("id") ON DELETE CASCADE
);

CREATE INDEX idx_oauth_access_tokens_application
  ON oauth_access_tokens (application_id);

CREATE INDEX idx_oauth_access_tokens_account
  ON oauth_access_tokens (account_id) WHERE account_id IS NOT NULL;

CREATE UNIQUE INDEX idx_oauth_access_tokens_web_session
  ON oauth_access_tokens (web_session_id) WHERE web_session_id IS NOT NULL;

-- The public, hashtag, and list streams some socket in a `StreamHub` holds.
-- `hub` is the account id, or 'anonymous' for the hub of sockets without a
-- token; `param` is the lowercased tag, the list id, or '' for public streams.
-- A hub writes its rows before a subscription takes effect and drops them
-- after it ends, so a fan-out reaches every subscribed hub and only those.
CREATE TABLE stream_subscriptions (
  hub TEXT NOT NULL,
  stream TEXT NOT NULL,
  param TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hub, stream, param)
);

CREATE TABLE push_subscriptions (
  -- Mastodon reports the subscription id as a JSON number, so it stays a small integer.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  standard INTEGER NOT NULL DEFAULT 0,
  alerts_json TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (access_token_id) REFERENCES oauth_access_tokens(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_subscriptions_account ON push_subscriptions (account_id, id);

-- ==========================================================================
-- Local accounts
-- ==========================================================================

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  access_email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  default_post_visibility TEXT NOT NULL DEFAULT 'public',
  default_quote_policy TEXT NOT NULL DEFAULT 'public',
  public_key_pem TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  bio_text TEXT NOT NULL DEFAULT '',
  avatar_object_key TEXT,
  header_object_key TEXT,
  default_language TEXT,
  default_sensitive INTEGER NOT NULL DEFAULT 0,
  -- The Better Auth user a local account signs in as. Accounts provisioned under
  -- Cloudflare Access have none until an admin links one.
  auth_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
  -- When the account's key pair was last replaced (NULL: never, the pair made
  -- at sign-up). A rotation (OPS-8) replaces the pair in place: the key id
  -- stays `<actor>#main-key`, as Mastodon's, and the old key is not kept. The
  -- bulk rotation job pages over the accounts not rotated since it started, so
  -- a retried page does not rotate the same account twice.
  key_rotated_at TEXT,
  -- Mastodon's `users.current_sign_in_at`: set by a request when it is unset
  -- or more than 24 hours old (`UserTrackingConcern`) and by a fresh sign-in
  -- (`update_sign_in!`). The fan-out and the `status` notification keep the
  -- followers whose time is within `USER_ACTIVE_DAYS` of now
  -- (`User.signed_in_recently`).
  current_sign_in_at TEXT
);

CREATE UNIQUE INDEX idx_accounts_auth_user ON accounts (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE TABLE account_profiles (
  account_id TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  bot INTEGER NOT NULL DEFAULT 0,
  discoverable INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  avatar_object_key TEXT,
  avatar_content_type TEXT,
  header_object_key TEXT,
  header_content_type TEXT,
  indexable INTEGER NOT NULL DEFAULT 1,
  hide_collections INTEGER NOT NULL DEFAULT 0,
  avatar_file_size INTEGER,
  header_file_size INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Mastodon's appearance preferences (`color_scheme` and `contrast` in its
-- user settings): the colour scheme and contrast the web app's HTML shell and
-- the Worker's own pages render as `data-color-scheme` / `data-contrast`.
-- An account without a row uses `auto` for both, as a signed-out visitor does.
CREATE TABLE account_appearance (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  color_scheme TEXT NOT NULL DEFAULT 'auto' CHECK (color_scheme IN ('auto', 'light', 'dark')),
  contrast TEXT NOT NULL DEFAULT 'auto' CHECK (contrast IN ('auto', 'high')),
  updated_at TEXT NOT NULL
);

CREATE TABLE account_flags (
  account_id TEXT PRIMARY KEY,
  sensitized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  pending INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE account_moderation (
  account_id TEXT PRIMARY KEY,
  moderation TEXT NOT NULL CHECK (moderation IN ('Silenced', 'Suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_moderation_state
  ON account_moderation (moderation, account_id);

CREATE TABLE account_notes (
  account_id TEXT NOT NULL,
  target_account_id TEXT,
  target_actor_uri TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, target_actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_notes_target_account_id
  ON account_notes (target_account_id);

CREATE INDEX idx_account_notes_target_actor_uri ON account_notes(target_actor_uri, account_id);

-- The accounts a local account says it moved from (Mastodon's
-- `account_aliases`), published as `alsoKnownAs` on its actor. `actor_uri` is
-- what the handle resolved to when the alias was added.
CREATE TABLE account_aliases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  acct TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Where a local account moved to (Mastodon's `moved_to_account` with its
-- latest `AccountMigration`): the target's actor URI and handle, and when.
-- One row per account; moving again after the cooldown replaces it.
CREATE TABLE account_moves (
  account_id TEXT PRIMARY KEY,
  acct TEXT NOT NULL,
  target_uri TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  -- A cancelled redirect keeps its `account_moves` row: the cooldown counts
  -- from `moved_at` whether or not the redirect still stands.
  cancelled_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE account_activity_days (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (account_id, day),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_account_activity_days_day ON account_activity_days (day);

CREATE TABLE account_ips (
  account_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (account_id, ip),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- The usernames of deleted local accounts. `GET /users/:username` answers
-- 410 Gone for one, as Mastodon does for a deleted account's actor, where an
-- unknown name answers 404: a remote server that asks after the `Delete` is
-- told the account is gone for good. A name registered again is found in
-- `accounts` first, so its row here is never read.
CREATE TABLE deleted_account_names (
  username TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);

CREATE TABLE statuses_cleanup_policies (
  account_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  min_status_age INTEGER NOT NULL DEFAULT 1209600,
  keep_pinned INTEGER NOT NULL DEFAULT 1,
  keep_direct INTEGER NOT NULL DEFAULT 1,
  keep_self_fav INTEGER NOT NULL DEFAULT 1,
  keep_self_bookmark INTEGER NOT NULL DEFAULT 1,
  keep_polls INTEGER NOT NULL DEFAULT 0,
  keep_media INTEGER NOT NULL DEFAULT 0,
  min_favs INTEGER,
  min_reblogs INTEGER,
  last_inspected_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_statuses_cleanup_policies_enabled
  ON statuses_cleanup_policies (account_id) WHERE enabled = 1;

CREATE TABLE featured_tags (
  account_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, tag_name),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_featured_tags_account_created
  ON featured_tags (account_id, created_at DESC);

CREATE TABLE endorsements (
  account_id TEXT NOT NULL,
  target_account_id TEXT,
  target_actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (account_id, target_actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_endorsements_owner_created
  ON endorsements (account_id, created_at DESC);

CREATE INDEX idx_endorsements_target_account_id
  ON endorsements (target_account_id);

CREATE INDEX idx_endorsements_id ON endorsements (id);

-- The `purgeRemoteActor*` deletes run when a remote actor is removed.
CREATE INDEX idx_endorsements_target_actor_uri ON endorsements (target_actor_uri);

CREATE TABLE suggestion_dismissals (
  account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, target_account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_suggestion_dismissals_target
  ON suggestion_dismissals (target_account_id);

CREATE TABLE markers (
  account_id TEXT NOT NULL,
  timeline TEXT NOT NULL CHECK (timeline IN ('home', 'notifications')),
  last_read_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, timeline),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- `notifications.from_account_id` may name a remote account (`r_…`), so it
-- has no foreign key to `accounts`; a deleted local account's sent
-- notifications go with it here instead.
CREATE TRIGGER notifications_sender_deleted AFTER DELETE ON accounts
BEGIN
    DELETE FROM notifications WHERE from_account_id = OLD.id;
END;

-- ==========================================================================
-- Statuses
-- ==========================================================================

CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ap_id TEXT UNIQUE,
  reblog_of_id TEXT,
  in_reply_to_id TEXT,
  content_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  spoiler_text TEXT NOT NULL DEFAULT '',
  language TEXT,
  content_html TEXT NOT NULL DEFAULT '',
  poll_id TEXT,
  card_json TEXT,
  card_url TEXT,
  in_reply_to_uri TEXT,
  -- A local boost of a cached remote status names it here instead of in
  -- `reblog_of_id`, and goes with it.
  reblog_of_remote_id TEXT
  REFERENCES remote_statuses(id) ON DELETE CASCADE,
  -- Who a reply answers, Mastodon's `in_reply_to_account_id`: a local account
  -- id or a remote actor URI, at most one of them set. Set when the reply is
  -- linked to its parent and not computed again (`Status#set_conversation`):
  -- a reply to its author's own reply takes that reply's, any other the
  -- parent's author. Both are NULL for a status that is no reply, and for a
  -- reply whose parent was not held when it was linked. `remote_statuses`
  -- carries the same pair; see `remote_statuses_link_replies`.
  in_reply_to_account_id TEXT,
  in_reply_to_actor_uri TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reblog_of_id) REFERENCES statuses(id) ON DELETE SET NULL,
  FOREIGN KEY (in_reply_to_id) REFERENCES statuses(id) ON DELETE SET NULL
);

CREATE INDEX idx_statuses_account_created_at
  ON statuses (account_id, created_at DESC);

CREATE INDEX idx_statuses_visibility_created_at
  ON statuses (visibility, created_at DESC);

CREATE INDEX idx_statuses_card_url ON statuses (card_url, id) WHERE card_url IS NOT NULL;

CREATE INDEX idx_statuses_in_reply_to_uri ON statuses (in_reply_to_uri);

-- Status rendering: boost counts and reblogged_by (`reblog_of_id = ?` / `IN`),
-- thread descendants (`in_reply_to_id IN`), and the SET NULL cascades a status
-- delete runs on both columns.
CREATE INDEX idx_statuses_reblog_of
  ON statuses (reblog_of_id, id) WHERE reblog_of_id IS NOT NULL;

CREATE INDEX idx_statuses_in_reply_to
  ON statuses (in_reply_to_id, id) WHERE in_reply_to_id IS NOT NULL;

CREATE INDEX idx_statuses_reblog_of_remote ON statuses (reblog_of_remote_id, id)
  WHERE reblog_of_remote_id IS NOT NULL;

CREATE INDEX idx_statuses_visibility_id ON statuses (visibility, id);

CREATE INDEX idx_statuses_account_id ON statuses (account_id, id);

CREATE INDEX idx_statuses_card_url_visibility
  ON statuses (card_url, visibility, id) WHERE card_url IS NOT NULL;

-- An account's boost of one status (`account_id = ? AND reblog_of_id = ?`, and
-- the remote twin), without reading every boost of a popular status.
CREATE INDEX idx_statuses_account_reblog
  ON statuses (account_id, reblog_of_id) WHERE reblog_of_id IS NOT NULL;

CREATE INDEX idx_statuses_account_reblog_remote
  ON statuses (account_id, reblog_of_remote_id) WHERE reblog_of_remote_id IS NOT NULL;

-- `listDirectStatusesForAccount`: the viewer's own direct notes in id order,
-- without walking every status they wrote or every direct note on the instance.
CREATE INDEX idx_statuses_direct_account_id
  ON statuses (account_id, id) WHERE visibility = 'direct';

-- An ActivityPub outbox page merges one index range per visibility its
-- fetcher may read (public and unlisted, followers-only for a follower), in
-- id order: a page reads its own rows, not the account's statuses of the
-- other visibilities between them.
CREATE INDEX idx_statuses_account_visibility_id
  ON statuses (account_id, visibility, id);

CREATE TABLE status_edits (
  id TEXT PRIMARY KEY,
  status_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_edits_status_created
  ON status_edits (status_id, created_at DESC, id DESC);

CREATE TABLE status_pins (
  account_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_pins_account_created
  ON status_pins (account_id, created_at DESC);

CREATE INDEX idx_status_pins_status ON status_pins (status_id);

CREATE TABLE status_mutes (
  account_id TEXT NOT NULL,
  thread_root_status_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, thread_root_status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_mutes_thread_root_status_id
  ON status_mutes (thread_root_status_id);

-- The accounts a local note mentions, and the remote actors in
-- `status_remote_mentions`. A `silent` row (Mastodon's `mentions.silent`)
-- lets the account or actor read the note without counting as a mention: a
-- quote writes one for the quoted author (`Quote#ensure_quoted_access`), and
-- an edit that drops a mention keeps it silent (`ProcessMentionsService`).
CREATE TABLE status_mentions (
  status_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  silent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (status_id, account_id),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_mentions_account
  ON status_mentions (account_id, status_id);

CREATE TABLE status_remote_mentions (
  status_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  silent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (status_id, actor_uri),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_status_remote_mentions_actor ON status_remote_mentions (actor_uri);

CREATE TABLE status_idempotency (
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- What an `Idempotency-Key` points at: `Pending` while the first request runs,
  -- then `Status` (status_id is a statuses id) or `ScheduledStatus` (status_id is
  -- a scheduled_statuses id), so a retry replays the right document.
  kind TEXT NOT NULL DEFAULT 'Status',
  PRIMARY KEY (account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_status_idempotency_created
  ON status_idempotency (account_id, created_at);

CREATE TABLE scheduled_statuses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_scheduled_statuses_account
  ON scheduled_statuses (account_id, id DESC);

CREATE INDEX idx_scheduled_statuses_due
  ON scheduled_statuses (scheduled_at);

-- A local status whose `Create`, or whose edit's `Update`, could not be built
-- when it was stored (its media or quote did not read back), so that the
-- `FederatePendingStatuses` job sends it later (FED-14). One row per status:
-- an owed `Create` stays a `Create` through later edits. `revision` changes
-- whenever the status changes while the row waits, so a retry that built an
-- older version stores nothing. `edited_at` is when the last change that
-- owes an `Update` was made, the `updated` the `Update` carries. The row goes
-- with its status.
CREATE TABLE pending_status_federations (
  status_id TEXT PRIMARY KEY REFERENCES statuses(id) ON DELETE CASCADE,
  activity TEXT NOT NULL CHECK (activity IN ('Create', 'Update')),
  revision INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT,
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_pending_status_federations_due
  ON pending_status_federations (next_attempt_at);

CREATE TABLE media_attachments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  focus_x REAL,
  focus_y REAL,
  -- A status lists its attachments in the order its media_ids gave them, as
  -- Mastodon's ordered_media_attachment_ids does.
  position INTEGER,
  -- What an image upload learns through the IMAGES binding: the original's
  -- dimensions, the `small` preview stored next to it under its own random key,
  -- and the preview's blurhash. All stay NULL when the binding is missing or the
  -- processing fails, and for video.
  width INTEGER,
  height INTEGER,
  preview_object_key TEXT,
  preview_width INTEGER,
  preview_height INTEGER,
  blurhash TEXT,
  -- The byte size of each object tstodon stores in the `MEDIA` bucket, as
  -- stored (uploads after metadata stripping), for the admin `space_usage`
  -- dimension, the `instance_media_attachments` measure and the export page's
  -- media storage. The upload path and the custom emoji forms write the size
  -- of what they store; a row's sizes go with the row, or with its key when
  -- an image is removed. `preview_file_size` is NULL without a preview.
  file_size INTEGER NOT NULL,
  preview_file_size INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE SET NULL
);

-- Media of the statuses being loaded, and an account's media on delete.
CREATE INDEX idx_media_attachments_status
  ON media_attachments (status_id) WHERE status_id IS NOT NULL;

CREATE INDEX idx_media_attachments_account
  ON media_attachments (account_id);

-- The media sweep (`deleteUnattachedMedia`) reads the oldest media no status
-- holds; idx_media_attachments_status only covers attached rows.
CREATE INDEX idx_media_attachments_unattached
  ON media_attachments (created_at) WHERE status_id IS NULL;

CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  status_id TEXT NOT NULL UNIQUE,
  multiple INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  options_json TEXT NOT NULL,
  expiry_notified_at TEXT,
  hide_totals INTEGER NOT NULL DEFAULT 0,
  -- Set while a `DistributePollUpdate` job is queued for the poll, so a burst
  -- of votes federates one `Update(Question)` instead of one per vote.
  update_queued_at TEXT,
  -- When the last `DistributePollUpdate` job of the poll started. A remote vote
  -- that is delivered again is distributed only when it was counted after that:
  -- the same vote under new activity ids cannot make the poll federate again.
  update_distributed_at TEXT,
  -- The end of a poll is queued once per poll (`AwaitPollEnd`, as Mastodon's
  -- `PollExpirationNotifyWorker` holds one job per poll): the instant queued is
  -- kept on the poll, a later schedule for the same instant queues nothing, and
  -- a queued job whose instant is no longer the poll's stops.
  end_queued_at TEXT,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_polls_expires_at
  ON polls (expires_at)
  WHERE expiry_notified_at IS NULL;

CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The moment a local voter was told a local poll they voted on had ended.
  -- Every row of one voter on one poll (one per chosen option) carries it.
  expiry_notified_at TEXT,
  PRIMARY KEY (poll_id, account_id, option_index),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_poll_votes_account ON poll_votes (account_id);

CREATE INDEX idx_poll_votes_unnotified
  ON poll_votes (poll_id, account_id) WHERE expiry_notified_at IS NULL;

CREATE TABLE status_quote_policies (
  status_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

-- Quote posts: the quoting status (local or remote) points at the quoted
-- status, and the quoted author's policy (who may quote it) is stored in
-- `status_quote_policies`. The quoted ids have no foreign key, so a deleted
-- original still leaves a quote row to report as `deleted`. A remote quote
-- may name a quoted note that could not be fetched yet, as Mastodon keeps a
-- quote with no `quoted_status`: its URI is `quoted_uri`, and only a remote
-- quoting status names one. `legacy` marks a quote named only by
-- `_misskey_quote`, `quoteUrl` or `quoteUri`, as Mastodon's `quotes.legacy`.
CREATE TABLE status_quotes (
  id TEXT PRIMARY KEY,
  status_id TEXT UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  remote_status_id TEXT UNIQUE REFERENCES remote_statuses(id) ON DELETE CASCADE,
  quoted_status_id TEXT,
  quoted_remote_status_id TEXT,
  quoted_uri TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'revoked', 'deleted')),
  approval_uri TEXT,
  activity_uri TEXT UNIQUE,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status_id IS NULL) <> (remote_status_id IS NULL)),
  CHECK (
    (quoted_status_id IS NOT NULL) + (quoted_remote_status_id IS NOT NULL) + (quoted_uri IS NOT NULL) = 1
  ),
  CHECK (quoted_uri IS NULL OR remote_status_id IS NOT NULL),
  CHECK (approval_uri IS NULL OR quoted_remote_status_id IS NOT NULL)
);

CREATE INDEX idx_status_quotes_quoted ON status_quotes (quoted_status_id, state)
  WHERE quoted_status_id IS NOT NULL;

CREATE INDEX idx_status_quotes_quoted_remote ON status_quotes (quoted_remote_status_id, state)
  WHERE quoted_remote_status_id IS NOT NULL;

CREATE INDEX idx_status_quotes_approval ON status_quotes (approval_uri)
  WHERE approval_uri IS NOT NULL;

CREATE TABLE conversation_reads (
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_read_status_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, conversation_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversation_reads_conversation_id
  ON conversation_reads (conversation_id);

CREATE TABLE conversation_hides (
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  hidden_status_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, conversation_id)
);

CREATE INDEX idx_conversation_hides_conversation_id
  ON conversation_hides (conversation_id);

-- A status that mentions an account in a notification the account's policy
-- held back as a request (INT-2). As Mastodon's `NotifyService`, which adds a
-- direct message to the recipient's conversations only when its notification
-- is not filtered, the account's conversations leave the status out while
-- the row stands. `held` is 1 while the request holds the notification:
-- accepting the sender deletes those rows, as Mastodon's
-- `UnfilterNotificationsWorker` adds the held direct messages then.
-- Dismissing the request sets it to 0, as Mastodon deletes the filtered
-- notifications, so a later accept does not add the status.
CREATE TABLE withheld_conversation_statuses (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, status_id)
);

CREATE INDEX idx_withheld_conversation_statuses_sender
  ON withheld_conversation_statuses (account_id, from_account_id);

CREATE TABLE favourites (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_status_id TEXT,
  remote_status_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (account_id, local_status_id),
  UNIQUE (account_id, remote_status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_favourites_status ON favourites (local_status_id, id)
  WHERE local_status_id IS NOT NULL;

CREATE INDEX idx_favourites_remote_status ON favourites (remote_status_id, id)
  WHERE remote_status_id IS NOT NULL;

CREATE INDEX idx_favourites_account_id ON favourites (account_id, id);

CREATE TABLE bookmarks (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  local_status_id TEXT,
  remote_status_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (account_id, local_status_id),
  UNIQUE (account_id, remote_status_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_bookmarks_status ON bookmarks (local_status_id)
  WHERE local_status_id IS NOT NULL;

CREATE INDEX idx_bookmarks_remote_status ON bookmarks (remote_status_id)
  WHERE remote_status_id IS NOT NULL;

CREATE INDEX idx_bookmarks_account_id ON bookmarks (account_id, id);

-- ==========================================================================
-- Tags
-- ==========================================================================

-- The hashtags this server knows, as Mastodon's `tags` table: a tag is
-- stored when a public or unlisted note, local or remote, uses it, or an
-- account follows or features it, and is never removed. A direct or
-- followers-only note's tags are left out, since search shows every name to
-- anyone. Names are stored as the tag timelines match them
-- (`normalizeHashtag`): lowercase, accents folded, without the `#`.
--
-- What an admin decides about a hashtag (`/api/v1/admin/tags`), as Mastodon's
-- columns: `usable` (posts may use it: its timeline lists posts and accounts
-- may feature it), `listable` (it appears in search and trends) and
-- `display_name` (another casing of the name). `trendable` lives in
-- `trend_reviews`.
CREATE TABLE tags (
  name TEXT NOT NULL PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usable INTEGER NOT NULL DEFAULT 1,
  listable INTEGER NOT NULL DEFAULT 1,
  display_name TEXT
) WITHOUT ROWID;

CREATE TABLE local_status_tags (
  status_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (status_id, tag),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_local_status_tags_tag
  ON local_status_tags (tag, status_id);

CREATE TABLE followed_tags (
  account_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (account_id, tag_name),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_followed_tags_account_created
  ON followed_tags (account_id, created_at DESC);

CREATE INDEX idx_followed_tags_account_id ON followed_tags (account_id, id);

-- Mastodon pages an account's followed tags (`TagFollow`) and domain blocks
-- (`AccountDomainBlock`) by the row's own id. A row written without an id
-- gets one shaped like `newEntityId()`: its `created_at` in milliseconds
-- above the low 16 bits, the rowid's low 16 bits under them, zero-padded to
-- 18 digits so string order is time order. No insert has to name one, and
-- none can leave a row out of the pages.
CREATE TRIGGER followed_tags_id AFTER INSERT ON followed_tags
WHEN NEW.id IS NULL
BEGIN
  UPDATE followed_tags
    SET id = printf(
      '%018d',
      (CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER) << 16)
        | (NEW.rowid & 65535)
    )
    WHERE rowid = NEW.rowid;
END;

-- ==========================================================================
-- Relationships
-- ==========================================================================

CREATE TABLE follows (
  id TEXT PRIMARY KEY,
  follower_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reblogs INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 0,
  languages_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (follower_account_id, target_account_id),
  FOREIGN KEY (follower_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_follows_target
  ON follows (target_account_id, kind);

-- The local follows of an account in id order, for moving them page by page.
CREATE INDEX idx_follows_target_id ON follows(target_account_id, id);

-- Following counts (`accountCounts`, `countFollowingByAccountIdsJson`) and the
-- followed-account lists: a covering search instead of a row read per follow.
CREATE INDEX idx_follows_follower_kind ON follows (follower_account_id, kind);

CREATE INDEX idx_follows_follower_id ON follows (follower_account_id, id);

CREATE TABLE blocks (
  blocker_account_id TEXT NOT NULL,
  target_account_id TEXT,
  target_actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (blocker_account_id, target_actor_uri),
  FOREIGN KEY (blocker_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_blocks_target_account_id
  ON blocks (target_account_id);

CREATE INDEX idx_blocks_id ON blocks (id);

-- The local accounts that blocked, muted or noted an account, in account id order,
-- for carrying them over to the account it moved to page by page. Local
-- targets are keyed by their actor URI like remote ones.
CREATE INDEX idx_blocks_target_actor_uri ON blocks(target_actor_uri, blocker_account_id);

CREATE TABLE mutes (
  account_id TEXT NOT NULL,
  target_account_id TEXT,
  target_actor_uri TEXT NOT NULL,
  notifications INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (account_id, target_actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_mutes_target_account_id
  ON mutes (target_account_id);

CREATE INDEX idx_mutes_account_created_at
  ON mutes (account_id, created_at DESC);

CREATE INDEX idx_mutes_id ON mutes (id);

CREATE INDEX idx_mutes_target_actor_uri ON mutes(target_actor_uri, account_id);

CREATE TABLE account_domain_blocks (
  account_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (account_id, domain),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_domain_blocks_account_created
  ON account_domain_blocks (account_id, created_at DESC);

-- Each page seeks the account's rows in id order. Not unique: a domain or tag
-- rename keeps the row's id, inserting the renamed row before it deletes the
-- old one.
CREATE INDEX idx_account_domain_blocks_account_id ON account_domain_blocks (account_id, id);

CREATE TABLE account_lists (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  replies_policy TEXT NOT NULL DEFAULT 'list'
  CHECK (replies_policy IN ('followed', 'list', 'none')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  exclusive INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_lists_owner
  ON account_lists (account_id, created_at DESC);

CREATE TABLE account_list_members (
  list_id TEXT NOT NULL,
  member_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (list_id, member_account_id),
  FOREIGN KEY (list_id) REFERENCES account_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (member_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_list_members_member
  ON account_list_members (member_account_id, list_id);

-- A remote actor on a local account's list. As in Mastodon, where a list
-- account belongs to the owner's follow, the member is the owner's accepted
-- follow of the actor: unfollowing, a `Reject`, or a `Move` deletes the
-- follow and with it every membership.
CREATE TABLE account_list_remote_members (
  list_id TEXT NOT NULL,
  outbound_follow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (list_id, outbound_follow_id),
  FOREIGN KEY (list_id) REFERENCES account_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (outbound_follow_id) REFERENCES outbound_follows(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_list_remote_members_follow
  ON account_list_remote_members (outbound_follow_id, list_id);

-- Severed relationships (`/severed_relationships`, the `severed_relationships`
-- notification). One `relationship_severance_events` row is a moderation
-- decision that removed follows: a suspended server (`domain_block`), a
-- suspended remote account (`account_suspension`), or a server a user blocked
-- (`user_domain_block`). `target_name` is the domain or the account address.
-- `purged` marks an event whose server an admin purged (nothing sets it yet).
--
-- `account_severance_events` is one local account's view of an event, the row
-- the notification and the CSV downloads point at, with the counts it lost.
-- `severed_relationships` lists the lost follows of an event. `direction` is
-- `active` for a follow by the local account and `passive` for a follow of it;
-- the remote account is kept as its address (`remote_acct`), so the list
-- outlives the cached actor. A follow row's id is reused as the row's id.
CREATE TABLE relationship_severance_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('domain_block', 'user_domain_block', 'account_suspension')),
  target_name TEXT NOT NULL,
  purged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE account_severance_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, account_id),
  FOREIGN KEY (event_id) REFERENCES relationship_severance_events(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_severance_events_account ON account_severance_events (account_id, id);

CREATE TABLE severed_relationships (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  local_account_id TEXT NOT NULL,
  remote_acct TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('active', 'passive')),
  show_reblogs INTEGER,
  notify INTEGER,
  languages_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES relationship_severance_events(id) ON DELETE CASCADE,
  FOREIGN KEY (local_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_severed_relationships_event
  ON severed_relationships (event_id, local_account_id, direction, id);

CREATE INDEX idx_severed_relationships_local_account
  ON severed_relationships (local_account_id);

-- The `Reject(Follow)` and `Undo(Follow)` a domain suspension owes the
-- suspended server, one row per accepted follow it removed, as Mastodon's
-- `DeleteAccountService` sends them (`reject_follows!`, `undo_follows!`).
-- The rows are written in the batch that removes the follows and deleted once
-- their activity is queued, by the `SendSeveranceNotices` pages, which claim
-- them first (`claimed_at`); a claim older than its page's time is taken again.
-- `id` is the notice's kind and the follow row's id, so a row is written once.
CREATE TABLE severance_notices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('Reject', 'Undo')),
  account_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  follow_activity_id TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_severance_notices_claimed_at ON severance_notices (claimed_at);

-- A local account on a list belongs to the owner's follow of it, as in
-- Mastodon, where `list_accounts` cascades from `follows` and
-- `follow_requests`: when the follow (accepted or requested) is deleted by an
-- unfollow, a block, a rejected request or a removed follower, the account
-- leaves every list of the follower. The owner's own membership has no follow
-- and stays.
CREATE TRIGGER account_list_members_leave_with_follow
AFTER DELETE ON follows
BEGIN
  DELETE FROM account_list_members
  WHERE member_account_id = OLD.target_account_id
    AND list_id IN (SELECT id FROM account_lists WHERE account_id = OLD.follower_account_id);
END;

CREATE TRIGGER follow_notifications_leave_with_follow
AFTER DELETE ON follows
BEGIN
  DELETE FROM notifications
  WHERE account_id = OLD.target_account_id
    AND from_account_id = OLD.follower_account_id
    AND kind IN ('follow', 'follow_request');
END;

CREATE TRIGGER follow_request_notification_leaves_when_authorized
AFTER UPDATE OF kind ON follows
WHEN OLD.kind = 'Pending' AND NEW.kind <> 'Pending'
BEGIN
  DELETE FROM notifications
  WHERE account_id = NEW.target_account_id
    AND from_account_id = NEW.follower_account_id
    AND kind = 'follow_request';
END;

-- The same id as `followed_tags_id` gives.
CREATE TRIGGER account_domain_blocks_id AFTER INSERT ON account_domain_blocks
WHEN NEW.id IS NULL
BEGIN
  UPDATE account_domain_blocks
    SET id = printf(
      '%018d',
      (CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER) << 16)
        | (NEW.rowid & 65535)
    )
    WHERE rowid = NEW.rowid;
END;

-- ==========================================================================
-- Filters
-- ==========================================================================

CREATE TABLE filters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  context_json TEXT NOT NULL,
  whole_word INTEGER NOT NULL DEFAULT 0,
  irreversible INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Per-account reads and account-delete cascades.
CREATE INDEX idx_filters_account ON filters (account_id, created_at);

CREATE TABLE filter_statuses (
  filter_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (filter_id, status_id),
  FOREIGN KEY (filter_id) REFERENCES filters(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_filter_statuses_id ON filter_statuses (id);

-- ==========================================================================
-- Notifications
-- ==========================================================================

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  from_actor_uri TEXT,
  kind TEXT NOT NULL,
  status_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The account a notification points at besides its sender: the new account of
  -- a `move` notification (Mastodon renders it as `target`).
  target_account_id TEXT,
  -- The report an `admin.report` notification points at.
  report_id TEXT,
  -- The event a `severed_relationships` notification reports.
  severance_event_id TEXT,
  -- Mastodon's group key (`Notification::Groups#set_group_key!`):
  -- `{type prefix}-{hour bucket}`, where a favourite or reblog's prefix is
  -- `{type}-{status id}` and a follow or `admin.sign_up`'s is its type. A
  -- notification of another type, or one the policy held, has none and is
  -- listed as `ungrouped-{id}`.
  group_key TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_account_created_at
  ON notifications (account_id, created_at DESC);

-- Notifications from a remote actor, removed when it undoes or deletes.
CREATE INDEX idx_notifications_from_actor
  ON notifications (from_actor_uri) WHERE from_actor_uri IS NOT NULL;

-- The local triggers look a notification up by recipient and sender.
CREATE INDEX idx_notifications_account_from ON notifications (account_id, from_account_id);

-- A user's domain block clears the blocker's notifications from the domain's
-- actors page by page (#67); this index serves the per-page listing and
-- delete by recipient and remote sender.
CREATE INDEX idx_notifications_account_actor ON notifications (account_id, from_actor_uri);

-- Grouped notification pages seek an account's notifications in id order
-- (`pageNotificationGroupsOlder` / `Newer`), and a group's members are found
-- by status (`summarizeNotificationGroups`, `dismissNotificationGroup`).
CREATE INDEX idx_notifications_account_id ON notifications (account_id, id);

CREATE INDEX idx_notifications_account_status ON notifications (account_id, status_id);

-- A group's members by key, newest first (`summarizeNotificationGroups`,
-- `dismissNotificationGroup`), and a type prefix's latest bucket
-- (`findNotificationGroupBucket`), as Mastodon's
-- `index_notifications_on_account_id_and_group_key`.
CREATE INDEX idx_notifications_account_group
  ON notifications (account_id, group_key, id)
  WHERE group_key IS NOT NULL;

CREATE TABLE notification_dismissals (
  account_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, notification_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_dismissals_notification_id
  ON notification_dismissals (notification_id);

CREATE TABLE notification_clear_markers (
  account_id TEXT PRIMARY KEY,
  cleared_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE notification_policies (
  account_id TEXT PRIMARY KEY,
  for_not_following TEXT NOT NULL DEFAULT 'accept',
  for_not_followers TEXT NOT NULL DEFAULT 'accept',
  for_new_accounts TEXT NOT NULL DEFAULT 'accept',
  for_private_mentions TEXT NOT NULL DEFAULT 'drop',
  for_limited_accounts TEXT NOT NULL DEFAULT 'filter',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  for_bots TEXT NOT NULL DEFAULT 'accept',
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE notification_requests (
  notification_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_id TEXT,
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_requests_account
  ON notification_requests (account_id, from_account_id);

CREATE TABLE notification_request_acceptances (
  account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, from_account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_request_acceptances_from_account_id
  ON notification_request_acceptances (from_account_id);

CREATE TABLE notification_request_groups (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, from_account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_request_groups_from_account_id
  ON notification_request_groups (from_account_id);

-- ==========================================================================
-- Remote actors
-- ==========================================================================

-- `domain` is the actor's authority, `host[:port]`, as Mastodon stores it,
-- so `@bob@peer.test:8792` and `@bob@peer.test` are two accounts and render
-- with their port.
CREATE TABLE remote_actors (
  actor_uri TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  domain TEXT NOT NULL,
  inbox_uri TEXT NOT NULL,
  shared_inbox_uri TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- What a remote actor shows on its profile (bio as text, avatar, header,
  -- profile URL, locked, bot, joined date), as RemoteActor.profile JSON.
  profile_json TEXT NOT NULL DEFAULT '{}',
  -- Where a remote actor announced it moved to, set only by a verified `Move`
  -- (the new actor lists the old one in `alsoKnownAs`). Refreshing the cached
  -- actor document leaves it alone, so an actor cannot claim a move itself.
  moved_to TEXT,
  -- A remote actor's `outbox` and `featured` collections, read from its actor
  -- document, and when its outbox was last fetched to backfill its profile.
  outbox_uri TEXT,
  featured_uri TEXT,
  outbox_fetched_at TEXT,
  -- The hostname of `remote_actors.domain` without its port: what domain blocks,
  -- suspensions and the allow list name, so a block on `peer.test` covers
  -- `peer.test:8792` too. Derived, so it cannot drift from `domain`.
  host TEXT GENERATED ALWAYS AS (
    lower(
      CASE
        WHEN substr(domain, 1, 1) = '[' THEN substr(domain, 1, instr(domain, ']'))
        WHEN instr(domain, ':') > 0 THEN substr(domain, 1, instr(domain, ':') - 1)
        ELSE domain
      END
    )
  ) VIRTUAL,
  -- The hostname of an actor URI, read as `Hostname.ofAuthority` reads the text
  -- between `://` and the first `/`: lower case, port and trailing dots dropped,
  -- IPv6 brackets kept. An instance rule (silence, suspension, reject_media,
  -- reject_reports, the allow list) and a user's domain block apply when they
  -- name this host or `host`, the account domain's, so an account domain
  -- elsewhere never lifts a rule on the host that serves the actor. Actor fetch
  -- refuses a URI whose authority is not ASCII or whose parsed host and port
  -- read otherwise (SQLite's `lower` folds ASCII only). Derived, so it cannot
  -- drift from `actor_uri`.
  uri_authority TEXT GENERATED ALWAYS AS (
    CASE
      WHEN instr(substr(actor_uri, instr(actor_uri, '://') + 3), '/') > 0
        THEN substr(
          substr(actor_uri, instr(actor_uri, '://') + 3),
          1,
          instr(substr(actor_uri, instr(actor_uri, '://') + 3), '/') - 1
        )
      ELSE substr(actor_uri, instr(actor_uri, '://') + 3)
    END
  ) VIRTUAL,
  uri_host TEXT GENERATED ALWAYS AS (
    rtrim(
      lower(
        CASE
          WHEN substr(uri_authority, 1, 1) = '[' THEN substr(uri_authority, 1, instr(uri_authority, ']'))
          WHEN instr(uri_authority, ':') > 0 THEN substr(uri_authority, 1, instr(uri_authority, ':') - 1)
          ELSE uri_authority
        END
      ),
      '.'
    )
  ) VIRTUAL,
  -- When WebFinger last confirmed the row's handle (Mastodon's
  -- `last_webfingered_at`); NULL while the handle is the URI's authority. A
  -- failed or skipped round trip (an outage, an actor's own `Update`) keeps it,
  -- so a handle lookup prefers the row confirmed last.
  last_webfingered_at TEXT,
  -- When the stale-actor refresh last tried this row. A row is due once both
  -- this and its last confirmation (its fetch, for a row WebFinger never
  -- confirmed) are a day old, oldest first, so an actor whose server never
  -- answers moves to the back instead of holding the head of the queue, and an
  -- actor's own `Update`s, which skip WebFinger, never keep its handle from
  -- being confirmed again.
  refresh_attempted_at TEXT,
  -- A remote actor's own `followers` and `following` collection URIs, as
  -- Mastodon's `accounts.followers_url` / `following_url`, so a note's
  -- `interactionPolicy.canQuote` names them by URI rather than by path. NULL:
  -- the actor document named none on its own host.
  followers_uri TEXT,
  following_uri TEXT,
  -- When a signature by this actor last failed to verify against its cached key
  -- and its document was fetched again for a new key. One refetch per actor per
  -- window (`claimRemoteActorKeyRefetch`), so forged signatures cannot make this
  -- server fetch an actor over and over.
  key_refetched_at TEXT,
  featured_tags_uri TEXT,
  -- The `fetched_at` of the actor's document whose profile field links were
  -- last looked at for a check (Mastodon's `VerifyAccountLinksWorker`, which
  -- each processing of the actor queues). NULL until the first look.
  links_checked_at TEXT,
  -- The keys of `host` and `uri_host` (see `host_keys`), kept by the
  -- `remote_actors_*_host_keys` triggers, so the domain rules covering an
  -- actor are one index range of each.
  host_key TEXT,
  uri_host_key TEXT
);

CREATE INDEX idx_remote_actors_domain_username
  ON remote_actors (domain, username);

-- Handle lookups compare case-insensitively.
CREATE INDEX idx_remote_actors_handle
  ON remote_actors (lower(domain), lower(username));

CREATE INDEX idx_remote_actors_host ON remote_actors (host);

CREATE INDEX idx_remote_actors_uri_host ON remote_actors (uri_host);

CREATE INDEX idx_remote_actors_refresh_due
  ON remote_actors (max(coalesce(last_webfingered_at, fetched_at), coalesce(refresh_attempted_at, '')));

-- `cancelRemoteActorDeliveries`: the queued deliveries to a gone actor's
-- inboxes, kept when another actor still shares the inbox.
CREATE INDEX idx_remote_actors_inbox ON remote_actors (inbox_uri);

CREATE INDEX idx_remote_actors_shared_inbox ON remote_actors (shared_inbox_uri);

CREATE INDEX idx_remote_actors_links_due
  ON remote_actors (fetched_at)
  WHERE links_checked_at IS NULL OR links_checked_at < fetched_at;

CREATE INDEX idx_remote_actors_host_key ON remote_actors (host_key);

CREATE INDEX idx_remote_actors_uri_host_key ON remote_actors (uri_host_key);

-- The public keys of remote actors, as Mastodon's `keypairs` (FED-8): each key
-- an actor document publishes (each `publicKey`, each FEP-521a
-- `assertionMethod` Multikey), under its id, so that a signature finds the key
-- its `keyId` names. A refetch of the actor replaces its keys. `type` is
-- Mastodon's (`rsa`, `ed25519`); `public_key_pem` is SPKI PEM.
CREATE TABLE remote_actor_keys (
  key_id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL REFERENCES remote_actors (actor_uri) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('rsa', 'ed25519')),
  public_key_pem TEXT NOT NULL
);

CREATE INDEX idx_remote_actor_keys_actor ON remote_actor_keys (actor_uri);

-- The notes a remote actor pinned (its `featured` collection), in its order.
-- Each outbox backfill replaces the actor's set.
CREATE TABLE remote_actor_pins (
  actor_uri TEXT NOT NULL,
  status_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (actor_uri, status_id),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

-- Cascades: a remote status delete into its pins, an account delete into its
-- remote poll votes and severed relationships.
CREATE INDEX idx_remote_actor_pins_status ON remote_actor_pins (status_id);

-- The hashtags a remote actor features, in its order: read from its
-- `featuredTags` collection on a profile backfill, and changed by its `Add`
-- and `Remove` of a `Hashtag` (Mastodon's `FetchFeaturedTagsCollectionService`
-- and `Add#add_featured_tags`). `tag_name` is the normalized tag, `name` the
-- spelling the actor gave.
CREATE TABLE remote_featured_tags (
  actor_uri TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (actor_uri, tag_name),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE TABLE remote_follows (
  id TEXT PRIMARY KEY,
  remote_actor_uri TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  remote_request_kind TEXT NOT NULL,
  follow_kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  follow_activity_id TEXT,
  UNIQUE (remote_actor_uri, target_account_id),
  FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_follows_target
  ON remote_follows (target_account_id, follow_kind);

CREATE INDEX idx_remote_follows_pending
  ON remote_follows (target_account_id, remote_request_kind);

-- `listFollowers` (remote branch) and `listFollowing` (both branches): each
-- branch searches `<owner> = ? AND id <cursor>` in id order, so the page
-- merges the two branches instead of sorting every follow. The local branch
-- of `listFollowers` already has `idx_follows_target_id`.
CREATE INDEX idx_remote_follows_target_id ON remote_follows (target_account_id, id);

-- The header's digest covers an account's followers on the inbox's host:
-- a range of follower URIs under one account.
CREATE INDEX idx_remote_follows_target_actor
  ON remote_follows (target_account_id, remote_actor_uri);

-- A local account following a remote actor. `state` is `Requested` until the
-- actor's `Accept` of `follow_activity_id` arrives, then `Accepted`; a
-- `Reject` or an unfollow deletes the row. Rows are keyed by their own `id`
-- (the following-list cursor), so a `Move` can re-point `actor_uri` to the
-- new actor without losing the follow's options.
CREATE TABLE outbound_follows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  follow_activity_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('Requested', 'Accepted')),
  reblogs INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 0,
  languages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, actor_uri),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_outbound_follows_actor ON outbound_follows (actor_uri, state);

-- Pages through the local follows of one actor in id order (a Move carries them over).
CREATE INDEX idx_outbound_follows_actor_id ON outbound_follows (actor_uri, id);

CREATE INDEX idx_outbound_follows_account_state
  ON outbound_follows (account_id, state);

CREATE INDEX idx_outbound_follows_account_id ON outbound_follows (account_id, id);

CREATE TABLE remote_blocks (
  actor_uri TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The id of the `Block` that made a remote actor's block, as Mastodon's
  -- `blocks.uri`: an `Undo` that names the `Block` by its id only finds the
  -- block by it (`try_undo_block`).
  activity_uri TEXT,
  PRIMARY KEY (actor_uri, account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_blocks_account
  ON remote_blocks (account_id, actor_uri);

CREATE TABLE remote_actor_moderation (
  actor_uri TEXT PRIMARY KEY,
  moderation TEXT CHECK (moderation IS NULL OR moderation IN ('Silenced', 'Suspended')),
  sensitized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_remote_actor_moderation_state
  ON remote_actor_moderation (moderation, actor_uri);

-- A `SynchronizeFollowers` job queued and not yet run, so the same one is not
-- queued twice meanwhile (`FollowersSynchronizationWorker`'s
-- `lock: :until_executed`). `digest` is '' when the header named none.
CREATE TABLE followers_synchronization_locks (
  actor_uri TEXT NOT NULL,
  url TEXT NOT NULL,
  digest TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (actor_uri, url, digest)
);

CREATE TRIGGER remote_actors_insert_host_keys AFTER INSERT ON remote_actors
BEGIN
  UPDATE remote_actors SET
    host_key = (SELECT key FROM host_keys WHERE source = 'host' AND id = NEW.actor_uri),
    uri_host_key = (SELECT key FROM host_keys WHERE source = 'uri_host' AND id = NEW.actor_uri)
  WHERE actor_uri = NEW.actor_uri;
END;

-- The upserts rewrite `domain` on every refresh; only a changed one is
-- spelled again.
CREATE TRIGGER remote_actors_update_host_keys AFTER UPDATE OF domain, actor_uri ON remote_actors
WHEN OLD.domain IS NOT NEW.domain OR OLD.actor_uri IS NOT NEW.actor_uri
BEGIN
  UPDATE remote_actors SET
    host_key = (SELECT key FROM host_keys WHERE source = 'host' AND id = NEW.actor_uri),
    uri_host_key = (SELECT key FROM host_keys WHERE source = 'uri_host' AND id = NEW.actor_uri)
  WHERE actor_uri = NEW.actor_uri;
END;

-- An actor first cached under a silence or suspension of its account domain
-- keeps it, a narrower rule made later notwithstanding, as
-- `ActivityPub::ProcessAccountService#create_account` sets `silenced_at` /
-- `suspended_at` from `DomainBlock.rule_for(@domain)`. Its host key is first
-- spelled by `remote_actors_insert_host_keys` right after the insert, so this
-- runs once per actor row; a re-fetch is an update and records nothing. A
-- fresh actor has no content to purge.
CREATE TRIGGER remote_actors_record_domain_limits AFTER UPDATE OF host_key ON remote_actors
WHEN OLD.host_key IS NULL AND NEW.host_key IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO remote_actor_domain_limits (domain_block_id, actor_uri)
  SELECT d.id, NEW.actor_uri FROM domain_blocks d
  WHERE d.id = (
    SELECT domain_block_id FROM remote_actor_account_domain_rule WHERE actor_uri = NEW.actor_uri
  ) AND d.severity IN ('silence', 'suspend');
END;

CREATE TRIGGER remote_follow_notifications_leave_with_follow
AFTER DELETE ON remote_follows
BEGIN
  DELETE FROM notifications
  WHERE account_id = OLD.target_account_id
    AND from_actor_uri = OLD.remote_actor_uri
    AND kind IN ('follow', 'follow_request');
END;

CREATE TRIGGER remote_follow_request_notification_leaves_when_authorized
AFTER UPDATE OF remote_request_kind ON remote_follows
WHEN OLD.remote_request_kind = 'Queued' AND NEW.remote_request_kind <> 'Queued'
BEGIN
  DELETE FROM notifications
  WHERE account_id = NEW.target_account_id
    AND from_actor_uri = NEW.remote_actor_uri
    AND kind = 'follow_request';
END;

-- ==========================================================================
-- Remote statuses
-- ==========================================================================

CREATE TABLE remote_statuses (
  id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  object_uri TEXT NOT NULL UNIQUE,
  url TEXT,
  content_html TEXT NOT NULL,
  spoiler_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  media_json TEXT NOT NULL DEFAULT '[]',
  card_json TEXT,
  tags_indexed INTEGER NOT NULL DEFAULT 0,
  card_url TEXT,
  in_reply_to_uri TEXT,
  -- When a remote author last edited a cached note (the `updated` of the
  -- `Update` that carried the edit). NULL for notes never edited since cached.
  edited_at TEXT,
  -- The poll a remote `Question` carries, as the JSON of the domain `RemotePoll`.
  -- NULL for a plain note.
  poll_json TEXT,
  -- When a cached remote status last had its thread (the notes above it and
  -- the replies under it) fetched from its origin. Opening the status claims
  -- it, as a profile view claims `remote_actors.outbox_fetched_at`, so the fetch
  -- runs once per TTL and off the request path.
  context_fetched_at TEXT,
  -- Who the remote author lets quote the note, parsed from
  -- `interactionPolicy.canQuote`: {"automatic":[...],"manual":[...]} with
  -- Mastodon's REST keys. NULL: the note advertised no policy, which Mastodon
  -- reads as nobody but the author.
  quote_policy_json TEXT,
  -- The end of a thread fetch, for Mastodon's async refresh of a context. The
  -- job copies the `context_fetched_at` claim it ran for into
  -- `context_refreshed_at`, so the two are equal once that pass has finished,
  -- and records how many statuses it stored in `context_refresh_count`.
  context_refreshed_at TEXT,
  context_refresh_count INTEGER,
  -- When the poll of a remote status was last read from its server, by an
  -- `Update` or by a client reading the poll (Mastodon's `polls.last_fetched_at`).
  -- NULL until the first: the `Create` that stored the poll does not count.
  poll_fetched_at TEXT,
  -- When the reply tree walk last read a cached remote status's `replies`, as
  -- Mastodon's `statuses.fetched_replies_at`: a walk skips a status read within
  -- the cooldown (`FETCH_REPLIES_COOLDOWN_MINUTES`).
  replies_fetched_at TEXT,
  -- When the thread job of a remote reply whose parent was not stored was
  -- queued (`ResolveRemoteThread`), as Mastodon's `Create#resolve_thread`
  -- queues one `ThreadResolveWorker` a reply: a redelivered `Create` or a chain
  -- that reaches the reply again queues no second job. A claim older than an
  -- hour counts as one whose job was lost.
  thread_resolve_queued_at TEXT,
  -- Who the reply answers, as `statuses.in_reply_to_account_id` /
  -- `in_reply_to_actor_uri`.
  in_reply_to_account_id TEXT,
  in_reply_to_actor_uri TEXT,
  -- The instant the end of the poll was queued for, as `polls.end_queued_at`.
  poll_end_queued_at TEXT,
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX idx_remote_statuses_visibility_published
  ON remote_statuses (visibility, published_at DESC);

CREATE INDEX idx_remote_statuses_actor_published
  ON remote_statuses (actor_uri, published_at DESC);

CREATE INDEX idx_remote_statuses_card_url ON remote_statuses (card_url, id)
  WHERE card_url IS NOT NULL;

-- The hourly tag backfill (`listUnindexedRemoteStatuses`): the few remote
-- statuses with `tags_indexed = 0`, without walking every one.
CREATE INDEX idx_remote_statuses_tags_pending
  ON remote_statuses (id) WHERE tags_indexed = 0;

-- Id-cursor pages (`<filter> AND id < ? ORDER BY id DESC LIMIT ?`) of the
-- public, direct, profile and remote actor timelines, without sorting every
-- match; also the statuses count of `accountCounts`.
CREATE INDEX idx_remote_statuses_visibility_id ON remote_statuses (visibility, id);

CREATE INDEX idx_remote_statuses_actor_id ON remote_statuses (actor_uri, id);

-- The link timelines (`card_url = ? AND visibility = 'public'`, id cursor).
-- Without these, the planner (with no table statistics) prefers the
-- visibility indexes above to the card_url ones and walks every public status.
CREATE INDEX idx_remote_statuses_card_url_visibility
  ON remote_statuses (card_url, visibility, id) WHERE card_url IS NOT NULL;

CREATE INDEX idx_remote_statuses_in_reply_to_uri_id
  ON remote_statuses (in_reply_to_uri, id);

-- Edit history of remote notes: the version an inbound `Update` replaced, one
-- snapshot JSON per edit.
CREATE TABLE remote_status_edits (
  id TEXT PRIMARY KEY,
  status_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_edits_status_created
  ON remote_status_edits (status_id, created_at DESC, id DESC);

CREATE TABLE remote_status_tags (
  status_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (status_id, tag),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_tags_tag
  ON remote_status_tags (tag, status_id);

-- The local accounts a cached remote note mentions, and the remote actors in
-- `remote_status_remote_mentions`. `silent` as in `status_mentions`.
CREATE TABLE remote_status_mentions (
  status_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  silent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (status_id, account_id),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_mentions_account
  ON remote_status_mentions (account_id, status_id DESC);

CREATE TABLE remote_status_remote_mentions (
  status_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  PRIMARY KEY (status_id, actor_uri),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

-- The late work a remote `Create` or `Update` still owes a stored note: its
-- mention rows and notifications, quote, link card and stream events run
-- after the batch that writes the row. A marker is written in that batch and
-- deleted when the late steps finish, so a delivery that failed in between
-- leaves one, and the sender's redelivery of the note finishes the work.
-- `kind` is what the write was: `Created` (a note stored by an inbox
-- activity) or `Edited` (an `Update` that changed its content). `token` names
-- the delivery that wrote the marker, which is the only one that deletes it.
-- The redelivery carries the document, so the only payload is
-- `mentions_json`: the local accounts an edit newly mentions, as a JSON array
-- of account ids on its `Edited` marker. The redelivery that finishes the
-- edit cannot work them out again, as the failed delivery may have written
-- their mention rows, which is how a first delivery tells a new mention from
-- one the note had. Empty for a `Created` marker, whose every mention is new.
-- A marker goes with its status (remote status retention deletes stale ones).
CREATE TABLE remote_status_owed (
  status_id TEXT NOT NULL REFERENCES remote_statuses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('Created', 'Edited')),
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  -- One delivery at a time runs the late steps a marker stands for, so a
  -- redelivery that arrives while the first delivery still runs them does not
  -- start the fan-out, the conversation update and the quote sync twice.
  -- `claimed_until` is the lease of the delivery that runs them: an instant, or
  -- NULL when nobody does. The delivery that writes the marker holds the lease
  -- from that batch. Another one takes it in one UPDATE, only when it is NULL
  -- or past, and goes without the steps when it does not get it. The holder
  -- clears it when it fails, so the redelivery resumes at once; a holder that
  -- was cut off leaves it to expire.
  claimed_until TEXT,
  PRIMARY KEY (status_id, kind)
);

-- The sweep deletes markers past their retention by age.
CREATE INDEX idx_remote_status_owed_created_at ON remote_status_owed (created_at);

-- The URIs of remote statuses their authors deleted, as Mastodon's
-- `Tombstone`: a `Create` of one, replayed with its Linked Data signature
-- or delivered late, is not stored again (`tombstone_exists?`). Kept, as
-- Mastodon keeps them.
CREATE TABLE remote_status_tombstones (
  object_uri TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE remote_favourites (
  remote_actor_uri TEXT NOT NULL,
  status_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (remote_actor_uri, status_id),
  FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_favourites_status
  ON remote_favourites (status_id);

CREATE INDEX idx_remote_favourites_id ON remote_favourites (id);

CREATE TABLE remote_announces (
  remote_actor_uri TEXT NOT NULL,
  status_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  id TEXT,
  PRIMARY KEY (remote_actor_uri, status_id),
  FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_announces_status
  ON remote_announces (status_id);

CREATE INDEX idx_remote_announces_id ON remote_announces (id);

-- A remote actor's boost (`Announce`) of a local or cached remote status, kept
-- as a home timeline entry for the actor's local followers. `id` comes from
-- the same sortable id space as statuses, so boosts page with them. Exactly
-- one of `local_status_id` / `remote_status_id` names the boosted status, and
-- the row goes with that status, with the booster, or with an `Undo` of
-- `activity_id`. One boost per actor and status, as in Mastodon.
CREATE TABLE remote_boosts (
  id TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  activity_id TEXT NOT NULL UNIQUE,
  local_status_id TEXT,
  remote_status_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((local_status_id IS NULL) <> (remote_status_id IS NULL)),
  UNIQUE (actor_uri, local_status_id),
  UNIQUE (actor_uri, remote_status_id),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
  FOREIGN KEY (local_status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (remote_status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE
);

-- The home timeline reads a followed actor's boosts in id order.
CREATE INDEX idx_remote_boosts_actor_id ON remote_boosts (actor_uri, id);

CREATE INDEX idx_remote_boosts_local_status ON remote_boosts (local_status_id);

CREATE INDEX idx_remote_boosts_remote_status ON remote_boosts (remote_status_id);

-- Votes that remote accounts cast on a local poll: one row per chosen option.
-- `object_uri` is the vote's `Note` URI, kept to tell a redelivery from a new vote.
CREATE TABLE remote_poll_votes (
  poll_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  object_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, actor_uri, option_index),
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

-- A local account's votes on a poll a remote `Question` carries. One row per
-- chosen option; `activity_id` is the `Create` that carried the vote to the
-- author. `optimistic` is 1 while the vote is added to the cached counts on
-- top of the author's own tally, and 0 once the author's next count refresh
-- has replaced them.
CREATE TABLE remote_poll_own_votes (
  status_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  choice_index INTEGER NOT NULL,
  activity_id TEXT NOT NULL,
  optimistic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_notified_at TEXT,
  PRIMARY KEY (status_id, account_id, choice_index),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_poll_own_votes_account
  ON remote_poll_own_votes (account_id);

-- Each run of `ProcessExpiredPolls` reads the votes whose voter has not been
-- told the poll ended, in (poll, voter) order; without these it scans every
-- vote ever cast.
CREATE INDEX idx_remote_poll_own_votes_unnotified
  ON remote_poll_own_votes (status_id, account_id) WHERE expiry_notified_at IS NULL;

-- The image this server last read for each custom emoji of a remote server,
-- as Mastodon keeps one `CustomEmoji` per shortcode and domain (the author's
-- account domain, `remote_actors.domain`). A remote post, version, poll or
-- profile shows the emoji this table holds for each `:shortcode:` it writes,
-- read when it is rendered, as Mastodon's `CustomEmoji.from_text`.
-- `updated_at` is the tag's `updated`, else the date of the document that
-- named it. A document that names another image replaces it unless it is
-- older, so a late or retried delivery does not bring back a replaced image.
CREATE TABLE remote_custom_emojis (
  domain TEXT NOT NULL,
  shortcode TEXT NOT NULL,
  image_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Mastodon's `custom_emojis.disabled`: a disabled emoji is not shown anywhere
  -- (`CustomEmoji.enabled` in `EntityCache#emoji`); an admin sets it from
  -- `/admin/custom_emojis`, as the `enable` and `disable` batch actions.
  disabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, shortcode)
);

-- An `Undo` that found nothing to undo, by its actor and the id of the
-- activity it names. That activity is dropped when it arrives within six
-- hours (Mastodon's `delete_later!` and `delete_arrived_first?`): a sender
-- that delivers an activity and its `Undo` at once can have the `Undo`
-- handled first. The activity vacuum deletes the rows past six hours.
CREATE TABLE undone_before_arrival (
  actor_uri TEXT NOT NULL,
  activity_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_uri, activity_uri)
);

CREATE INDEX idx_undone_before_arrival_created_at ON undone_before_arrival (created_at);

-- A remote note stored after its replies sets theirs, as Mastodon's
-- `ThreadResolveWorker` links a reply to a parent that arrives late.
CREATE TRIGGER remote_statuses_link_replies AFTER INSERT ON remote_statuses
BEGIN
    UPDATE remote_statuses SET
        in_reply_to_account_id = CASE
            WHEN actor_uri = NEW.actor_uri THEN NEW.in_reply_to_account_id
        END,
        in_reply_to_actor_uri = CASE
            WHEN actor_uri = NEW.actor_uri
             AND (NEW.in_reply_to_uri IS NOT NULL OR NEW.in_reply_to_account_id IS NOT NULL
                  OR NEW.in_reply_to_actor_uri IS NOT NULL)
            THEN NEW.in_reply_to_actor_uri
            ELSE NEW.actor_uri
        END
    WHERE in_reply_to_uri = NEW.object_uri
      AND in_reply_to_account_id IS NULL
      AND in_reply_to_actor_uri IS NULL;
END;

-- ==========================================================================
-- Federation delivery
-- ==========================================================================

CREATE TABLE outbox_deliveries (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason_kind TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  inbox_url TEXT,
  -- When a `Queued` target's next attempt is due: set by the delivery Workflow
  -- before it sleeps, and by the stuck-delivery sweep. NULL until the first
  -- attempt; the sweep reads `updated_at` (the row's creation) then.
  next_attempt_at TEXT
);

CREATE UNIQUE INDEX idx_outbox_deliveries_target
  ON outbox_deliveries (activity_id, inbox_url)
  WHERE inbox_url IS NOT NULL;

-- The per-activity fan-out row (`inbox_url IS NULL`), read and updated on
-- every delivery; idx_outbox_deliveries_target only covers target rows.
CREATE INDEX idx_outbox_deliveries_fanout
  ON outbox_deliveries (activity_id) WHERE inbox_url IS NULL;

-- The hourly stuck-delivery sweep: `Queued` targets whose attempt is overdue.
CREATE INDEX idx_outbox_deliveries_due
  ON outbox_deliveries (COALESCE(next_attempt_at, updated_at))
  WHERE kind = 'Queued' AND inbox_url IS NOT NULL;

-- Finished delivery rows by last change. The `kind` list is the one in
-- `prisma/sql/pruneTerminalDeliveries.sql`; SQLite uses a partial index only
-- when the query repeats its WHERE term.
CREATE INDEX idx_outbox_deliveries_finished
  ON outbox_deliveries (updated_at)
  WHERE kind IN ('Delivered', 'Failed', 'Expanded', 'Skipped');

CREATE INDEX idx_outbox_deliveries_queued_inbox
  ON outbox_deliveries (inbox_url) WHERE kind = 'Queued';

-- Outbox queue jobs that will not run again on their own: the dead-letter
-- queue `tstodon-outbox-dlq` (consumer `app/queues/tstodon-outbox-dlq.ts`)
-- stores each message it receives here. `id` is the SHA-256 (hex) of
-- `body_json`, so the same job dead-lettered again updates its row
-- (`dead_count`, `last_seen_at`, `attempts`, `error`) instead of adding one.
-- `reason` is why it died: `RetriesExhausted` (the job returned retry on its
-- last attempt and the handler sent it here), `HandlerFailed` (Queues
-- dead-lettered a valid job after `max_retries`: the handler threw or the
-- invocation failed) or `Unparseable` (the body is not an `OutboxJob`).
-- `job_kind` is the body's `kind` when it has one. The `RequeueDeadOutboxJobs`
-- job sends rows back to `tstodon-outbox-process` and deletes them.
CREATE TABLE outbox_dead_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  job_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  body_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  dead_count INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Inspection by kind and the requeue job's pages (oldest first).
CREATE INDEX idx_outbox_dead_jobs_kind
  ON outbox_dead_jobs (job_kind, first_seen_at);

CREATE INDEX idx_outbox_dead_jobs_first_seen
  ON outbox_dead_jobs (first_seen_at, id);

CREATE TABLE outbound_activities (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The id of the inbound activity an outbound one forwards: one forward per
  -- inbound activity, however often its handling is retried.
  forward_of TEXT,
  -- Whether each POST of the activity carries a `Collection-Synchronization`
  -- header (Mastodon's `synchronize_followers` delivery option): set for a
  -- followers-only status's `Create`, `Update` or `Announce` from an account
  -- with fewer than 25,000 followers.
  synchronize_followers INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_outbound_activities_account ON outbound_activities (account_id, id);

CREATE INDEX idx_outbound_activities_created
  ON outbound_activities (created_at);

CREATE UNIQUE INDEX idx_outbound_activities_forward_of
  ON outbound_activities (forward_of) WHERE forward_of IS NOT NULL;

-- The `Delete` of a deleted account's actor is delivered after the account's
-- row, and its key with it, is gone. Its outbound activity has no account
-- (`account_id` NULL, so the delete of the account does not cascade to it);
-- this row keeps the name and the private key that sign it. The row is
-- deleted as soon as none of the activity's targets is still to be attempted
-- (`deleteSettledDepartedSigner.sql`); the cascade removes it with the
-- activity otherwise.
CREATE TABLE outbound_departed_signers (
  activity_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  FOREIGN KEY (activity_id) REFERENCES outbound_activities(id) ON DELETE CASCADE
);

CREATE TABLE inbox_activities (
  activity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The inbox claims an activity id before it applies the activity, and marks
  -- the claim `Processed` only once the activity was applied or rejected. A
  -- failed apply deletes its claim, so the sender's retry applies it again
  -- instead of being answered as a duplicate.
  --
  -- `created_at` of a `Processing` row is when it was claimed: a claim older
  -- than 15 minutes belongs to an apply that never finished (the Worker was cut
  -- off), and the next delivery or the hourly cron takes it back.
  state TEXT NOT NULL DEFAULT 'Processed'
  CHECK (state IN ('Processing', 'Processed'))
);

CREATE INDEX idx_inbox_activities_created
  ON inbox_activities (created_at);

-- The open claims by age, for the hourly release of stale ones. SQLite uses a
-- partial index only when the query repeats its WHERE term.
CREATE INDEX idx_inbox_activities_processing
  ON inbox_activities (created_at)
  WHERE state = 'Processing';

-- Remote domains deliveries have been failing to: Mastodon's
-- `DeliveryFailureTracker` (distinct days with a failed delivery) and
-- `UnavailableDomain`, one row per domain (`DeliveryDomainHealth` in
-- packages/domain). `kind` is `Failing`, or `Unavailable` once failures were
-- recorded on 7 distinct UTC days with no success between; deliveries to an
-- unavailable domain are skipped. A successful delivery to the domain, a
-- verified inbound activity from it, or an admin's "Mark as available"
-- deletes the row.
CREATE TABLE delivery_domain_health (
  domain TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  failure_days INTEGER NOT NULL,
  last_failure_day TEXT NOT NULL,
  unavailable_since TEXT,
  updated_at TEXT NOT NULL
);

-- The key kept to sign a deleted account's `Delete`
-- (`outbound_departed_signers`) is needed only while a target
-- of the activity is still `Queued`. This trigger drops it when the last such
-- target leaves `Queued`, whatever writes the change: a delivery that settles
-- it, the stuck-delivery sweep that gives it up, or the purge of a remote
-- actor that fails its deliveries (`cancelRemoteActorDeliveries.sql`).
-- Targets are never deleted while `Queued` (the vacuum prunes settled ones),
-- so an update is the only way out of `Queued`.
CREATE TRIGGER outbound_departed_signers_leave_when_settled
AFTER UPDATE OF kind ON outbox_deliveries
WHEN OLD.kind = 'Queued' AND NEW.kind <> 'Queued' AND NEW.inbox_url IS NOT NULL
BEGIN
  DELETE FROM outbound_departed_signers
  WHERE activity_id = NEW.activity_id
    AND NOT EXISTS (
      SELECT 1 FROM outbox_deliveries
      WHERE activity_id = NEW.activity_id AND inbox_url IS NOT NULL AND kind = 'Queued'
    );
END;

-- ==========================================================================
-- Moderation
-- ==========================================================================

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  reporter_actor_uri TEXT,
  target_account_id TEXT,
  target_actor_uri TEXT,
  status_ids_json TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  assigned_account_id TEXT,
  rule_ids_json TEXT NOT NULL DEFAULT '[]',
  action_taken_at TEXT,
  action_taken_by_account_id TEXT,
  forwarded INTEGER NOT NULL DEFAULT 0,
  flag_uri TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  -- A report keeps the `user@domain` handle of each remote party, so the admin
  -- views still say who it was after the actor is purged from `remote_actors`.
  -- `NULL` for a local party.
  reporter_acct TEXT,
  target_acct TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK ((account_id IS NULL) <> (reporter_actor_uri IS NULL)),
  CHECK ((target_account_id IS NULL) <> (target_actor_uri IS NULL))
);

CREATE INDEX idx_reports_account ON reports (account_id);

CREATE INDEX idx_reports_reporter_actor ON reports (reporter_actor_uri);

CREATE INDEX idx_reports_target_account ON reports (target_account_id);

CREATE INDEX idx_reports_target_actor ON reports (target_actor_uri);

CREATE TABLE ip_blocks (
  id TEXT NOT NULL PRIMARY KEY,
  ip TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE canonical_email_blocks (
  id TEXT PRIMARY KEY,
  canonical_email_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE email_domain_blocks (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================================
-- Domain policy
-- ==========================================================================

-- An instance domain rule (silence, suspension, reject_media, reject_reports)
-- covers the domain it names and every subdomain of it, and a host follows
-- its most specific rule only, as Mastodon's `DomainBlock.rule_for`.
--
-- A host's key is its labels in reverse order, each followed by a dot:
-- `a.example.com` is `com.example.a.`. A rule on `example.com` (key
-- `com.example.`) covers exactly the hosts whose key starts with its key, so
-- the actors a rule covers are one index range, `[key, key with its last
-- '.' replaced by '/')`, and `x-example.com` (`com.x-example.`) stays out.
-- `domain_key` is kept by the `domain_blocks_*_domain_key` triggers.
CREATE TABLE domain_blocks (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK (severity IN ('silence', 'suspend', 'noop')),
  reject_media INTEGER NOT NULL DEFAULT 0,
  reject_reports INTEGER NOT NULL DEFAULT 0,
  obfuscate INTEGER NOT NULL DEFAULT 0,
  private_comment TEXT,
  public_comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  domain_key TEXT
);

CREATE INDEX idx_domain_blocks_severity
  ON domain_blocks (severity, domain);

CREATE INDEX idx_domain_blocks_domain_key ON domain_blocks (domain_key);

CREATE TABLE domain_allows (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- The domain policy revision: a token every write to `domain_blocks` or
-- `domain_allows` replaces with a fresh random one, in the same statement.
-- `readDomainPolicy` (server/domain-policy-revision.ts) keeps an isolate copy
-- of the suspended, media-rejected, and allowed domains with the token it
-- was read at, and reads only this row while the token still matches. A
-- migration that rebuilds either table must recreate its triggers. The row
-- is seeded at the end of this file.
CREATE TABLE domain_policy_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL
);

-- Every key, spelled in one place for the triggers.
-- A name is read as `Hostname.ofAuthority` reads it, so SQL and the Worker
-- agree on a row written by hand: lower case, port dropped (IPv6 brackets
-- kept), trailing dots dropped. SQLite has no string reversal, so a recursive
-- CTE moves one label per step.
CREATE VIEW host_keys AS
SELECT source, id, (
  WITH RECURSIVE k(rest, key) AS (
    SELECT rtrim(
      CASE
        WHEN substr(name, 1, 1) = '[' THEN substr(name, 1, instr(name, ']'))
        WHEN instr(name, ':') > 0 THEN substr(name, 1, instr(name, ':') - 1)
        ELSE name
      END,
      '.'
    ) || '.', ''
    UNION ALL
    SELECT substr(rest, instr(rest, '.') + 1), substr(rest, 1, instr(rest, '.')) || key
    FROM k WHERE rest <> ''
  )
  SELECT key FROM k WHERE rest = ''
) AS key
FROM (
  SELECT 'host' AS source, actor_uri AS id, lower(host) AS name FROM remote_actors
  UNION ALL
  SELECT 'uri_host', actor_uri, lower(uri_host) FROM remote_actors
  UNION ALL
  SELECT 'domain', id, lower(domain) FROM domain_blocks
);

-- The instance domain rules in force on each remote actor: the most specific
-- rule over its `host_key` and over its `uri_host_key`, and the silences and
-- suspensions recorded on it (`remote_actor_domain_limits`), less what an
-- admin lifted (`remote_actor_domain_lifts`).
CREATE VIEW remote_actor_domain_rules AS
SELECT r.actor_uri, d.id AS domain_block_id,
  d.severity, d.reject_media, d.reject_reports
FROM domain_blocks d
JOIN remote_actors r
  ON r.host_key >= d.domain_key
  AND r.host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
WHERE NOT EXISTS (
  SELECT 1 FROM domain_blocks n
  WHERE n.domain_key > d.domain_key
    AND n.domain_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
    AND substr(r.host_key, 1, length(n.domain_key)) = n.domain_key
)
AND NOT EXISTS (
  SELECT 1 FROM remote_actor_domain_lifts x
  WHERE x.domain_block_id = d.id AND x.actor_uri = r.actor_uri AND x.severity = d.severity
)
UNION ALL
SELECT r.actor_uri, d.id AS domain_block_id,
  d.severity, d.reject_media, d.reject_reports
FROM domain_blocks d
JOIN remote_actors r
  ON r.uri_host_key >= d.domain_key
  AND r.uri_host_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
WHERE NOT EXISTS (
  SELECT 1 FROM domain_blocks n
  WHERE n.domain_key > d.domain_key
    AND n.domain_key < substr(d.domain_key, 1, length(d.domain_key) - 1) || '/'
    AND substr(r.uri_host_key, 1, length(n.domain_key)) = n.domain_key
)
AND NOT EXISTS (
  SELECT 1 FROM remote_actor_domain_lifts x
  WHERE x.domain_block_id = d.id AND x.actor_uri = r.actor_uri AND x.severity = d.severity
)
UNION ALL
SELECT l.actor_uri, d.id AS domain_block_id, d.severity, 0, 0
FROM remote_actor_domain_limits l
JOIN domain_blocks d ON d.id = l.domain_block_id
WHERE d.severity IN ('silence', 'suspend')
  AND NOT EXISTS (
    SELECT 1 FROM remote_actor_domain_lifts x
    WHERE x.domain_block_id = l.domain_block_id AND x.actor_uri = l.actor_uri AND x.severity = d.severity
  );

-- Making an instance domain block silences or suspends every actor cached at
-- or under its domain then, a narrower rule notwithstanding, as Mastodon's
-- `BlockDomainService` sets `silenced_at` / `suspended_at` over
-- `Account.by_domain_and_subdomains`: an actor known before a narrower `noop`
-- stays limited there, while one first seen later follows its most specific
-- rule alone. A row names the block that limited the actor, which the
-- `RecordDomainBlockLimits` job writes in pages. The limitation is the
-- block's current severity, read through the join, so changing the block's
-- severity or removing it lifts what it set at once, as
-- `process_retroactive_updates!` and `UnblockDomainService` do; the job then
-- deletes the rows a `noop` or a removed block left. No foreign key: the rows
-- of a removed block go in pages, not in the request that removes it.
CREATE TABLE remote_actor_domain_limits (
  domain_block_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  PRIMARY KEY (domain_block_id, actor_uri)
);

CREATE INDEX idx_remote_actor_domain_limits_actor
  ON remote_actor_domain_limits (actor_uri, domain_block_id);

-- An admin's per-account unsilence or unsuspend of a remote actor lifts the
-- silence or suspension an instance domain block holds on it, as Mastodon's
-- `Account#unsilence!` / `#unsuspend!` clear the `silenced_at` /
-- `suspended_at` that `BlockDomainService` set. A lift names the block and the
-- severity it lifted; it holds only while the block keeps that severity, and
-- applying the block again (`DomainBlockWorker` after an edit) deletes it, as
-- `process_domain_block!` limits the account again.
CREATE TABLE remote_actor_domain_lifts (
  domain_block_id TEXT NOT NULL,
  actor_uri TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('silence', 'suspend')),
  PRIMARY KEY (domain_block_id, actor_uri)
);

CREATE INDEX idx_remote_actor_domain_lifts_actor
  ON remote_actor_domain_lifts (actor_uri);

-- The most specific instance domain block on each actor's account domain,
-- whatever its severity: the host key's parent domains, longest first, each
-- one seek of `idx_domain_blocks_domain_key`.
CREATE VIEW remote_actor_account_domain_rule AS
SELECT r.actor_uri, (
  WITH RECURSIVE prefixes(prefix, rest) AS (
    SELECT '', r.host_key
    UNION ALL
    SELECT prefix || substr(rest, 1, instr(rest, '.')), substr(rest, instr(rest, '.') + 1)
    FROM prefixes WHERE instr(rest, '.') > 0
  )
  SELECT d.id FROM prefixes p JOIN domain_blocks d ON d.domain_key = p.prefix
  WHERE p.prefix <> ''
  ORDER BY length(p.prefix) DESC
  LIMIT 1
) AS domain_block_id
FROM remote_actors r;

-- The remote actors a fetch of their own document finds suspended: an
-- admin's suspension, or one an instance domain block recorded and no admin
-- lifted (`remote_actor_domain_limits`). The writes of a fetched actor keep
-- the cached profile of these, as Mastodon's `ProcessAccountService` skips
-- `set_immediate_attributes!` and `set_fetchable_attributes!` for a
-- suspended account. A suspension that covers an actor's host now is left
-- out: a fetch of such an actor is refused before it writes.
CREATE VIEW suspended_remote_actors AS
SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended'
UNION ALL
SELECT l.actor_uri FROM remote_actor_domain_limits l
JOIN domain_blocks d ON d.id = l.domain_block_id
WHERE d.severity = 'suspend'
  AND NOT EXISTS (
    SELECT 1 FROM remote_actor_domain_lifts x
    WHERE x.domain_block_id = l.domain_block_id AND x.actor_uri = l.actor_uri
      AND x.severity = 'suspend'
  );

-- The actors a domain suspension suspended whose content has yet to go, as
-- Mastodon's `BlockDomainService#suspend_accounts!` runs `DeleteAccountService`
-- with `reserve_username` on each: their statuses (with what cascades from
-- them, the local boosts of them included), their own boosts, favourites and
-- announces, and the notifications they sent. A `RecordDomainBlockLimits`
-- page of a suspension writes a row for each actor it records, and the
-- `PurgeSuspendedActorContent` pages delete what was stored by `before`, then
-- the row, whatever the block has become since: changing the suspension to a
-- silence or a `noop`, or removing it, brings none of it back, and what the
-- actor sends after the change stays.
CREATE TABLE remote_actor_content_purges (
  actor_uri TEXT PRIMARY KEY NOT NULL,
  before TEXT NOT NULL
);

-- The one chain of `PurgeSuspendedActorContent` pages that runs: each page
-- stamps `stamped_at`, the last one deletes the row, and a chain starts only
-- when the row is missing or no page stamped it for ten minutes.
CREATE TABLE remote_actor_content_purge_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stamped_at TEXT NOT NULL
);

CREATE TRIGGER domain_blocks_insert_revision AFTER INSERT ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER domain_blocks_update_revision AFTER UPDATE ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER domain_blocks_delete_revision AFTER DELETE ON domain_blocks
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER domain_blocks_insert_domain_key AFTER INSERT ON domain_blocks
BEGIN
  UPDATE domain_blocks SET
    domain_key = (SELECT key FROM host_keys WHERE source = 'domain' AND id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER domain_blocks_update_domain_key AFTER UPDATE OF domain ON domain_blocks
WHEN OLD.domain IS NOT NEW.domain
BEGIN
  UPDATE domain_blocks SET
    domain_key = (SELECT key FROM host_keys WHERE source = 'domain' AND id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER domain_allows_insert_revision AFTER INSERT ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER domain_allows_update_revision AFTER UPDATE ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

CREATE TRIGGER domain_allows_delete_revision AFTER DELETE ON domain_allows
BEGIN
  UPDATE domain_policy_revision SET token = lower(hex(randomblob(16))) WHERE id = 1;
END;

-- ==========================================================================
-- Imports
-- ==========================================================================

-- Data import (`/settings/import`): one row per uploaded file, and one row
-- per line of it with the line's outcome. `type` is the `ImportType` kind and
-- `mode` the `ImportMode` kind; `state` is `Queued` until the last page of
-- the job has run, then `Finished`; `Failed` when the queue gave up on the job
-- or it was lost. A line that is not a row of the type is
-- stored `Failed` at upload; the others are `Pending` until the queue job
-- applies them. `row_json` holds the parsed `ImportRow` of a line that
-- passed, `key` what it names (to compare with existing entries in an
-- overwrite). `resolved` is the account (actor URI; for a list row, title and
-- actor URI) the row resolved to, set once it did: an overwrite keeps the
-- entries that match it, whatever the handle text. `reason` is the `RowFailure` kind of a `Failed` line.
CREATE TABLE csv_imports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Queued', 'Finished', 'Failed')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_csv_imports_account ON csv_imports (account_id, id);

CREATE TABLE csv_import_rows (
  import_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  input TEXT NOT NULL,
  row_json TEXT,
  key TEXT NOT NULL DEFAULT '',
  resolved TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('Pending', 'Applied', 'Failed')),
  reason TEXT,
  PRIMARY KEY (import_id, position),
  FOREIGN KEY (import_id) REFERENCES csv_imports(id) ON DELETE CASCADE
);

CREATE INDEX idx_csv_import_rows_key ON csv_import_rows (import_id, key);

CREATE INDEX idx_csv_import_rows_resolved ON csv_import_rows (import_id, resolved);

-- ==========================================================================
-- Counters
-- ==========================================================================

-- Counters that triggers keep, so rendering an account or a status reads one
-- row instead of counting every status, follow, favourite or boost it has.
-- A missing row counts 0. Each row holds what these queries would count:
--
-- `account_stats` (local accounts):
--   statuses_count  the account's `statuses` rows (notes and boosts) that are
--                   not direct, as Mastodon's `Status#increment_counter_caches`,
--   followers_count accepted local `follows` and accepted `remote_follows` of it,
--   following_count accepted local `follows` by it and accepted `outbound_follows`.
-- `status_stats` (local and remote statuses: their ids never collide):
--   favourites_count local `favourites` and `remote_favourites`,
--   reblogs_count    local boosts (`LocalReblog` statuses) and `remote_announces`,
--   quotes_count     accepted `status_quotes` quoting it,
--   replies_count    public and unlisted replies, as Mastodon counts them: local
--                    notes by `in_reply_to_id`, or by `in_reply_to_uri` for a
--                    remote parent, and remote statuses by `in_reply_to_uri`
--                    (a local parent's URI ends in
--                    `/users/<username>/statuses/<id>`; the instance's origin
--                    is configuration, so it is not compared).
--
-- One row per account or status keeps the writes at one per counted change.
-- A migration that rebuilds a counted table must recreate its triggers.
CREATE TABLE account_stats (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  statuses_count INTEGER NOT NULL DEFAULT 0,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE status_stats (
  status_id TEXT PRIMARY KEY,
  favourites_count INTEGER NOT NULL DEFAULT 0,
  reblogs_count INTEGER NOT NULL DEFAULT 0,
  quotes_count INTEGER NOT NULL DEFAULT 0,
  replies_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TRIGGER statuses_insert_reblogs_count AFTER INSERT ON statuses
WHEN NEW.kind = 'LocalReblog' AND COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) IS NOT NULL
BEGIN
    INSERT INTO status_stats (status_id, reblogs_count)
    VALUES (COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER statuses_delete_reblogs_count AFTER DELETE ON statuses
WHEN OLD.kind = 'LocalReblog' AND COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id) IS NOT NULL
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id);
END;

CREATE TRIGGER statuses_update_reblogs_count
AFTER UPDATE OF kind, reblog_of_id, reblog_of_remote_id ON statuses
WHEN (CASE WHEN OLD.kind = 'LocalReblog' THEN COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id) END)
  IS NOT (CASE WHEN NEW.kind = 'LocalReblog' THEN COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) END)
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE OLD.kind = 'LocalReblog'
      AND status_id = COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id);
    INSERT INTO status_stats (status_id, reblogs_count)
    SELECT COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id), 1
    WHERE NEW.kind = 'LocalReblog' AND COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) IS NOT NULL
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER statuses_insert_replies_count AFTER INSERT ON statuses
WHEN NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted')
  AND (NEW.in_reply_to_id IS NOT NULL OR NEW.in_reply_to_uri IS NOT NULL)
BEGIN
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        NEW.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER statuses_delete_replies_count AFTER DELETE ON statuses
WHEN OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted')
  AND (OLD.in_reply_to_id IS NOT NULL OR OLD.in_reply_to_uri IS NOT NULL)
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE status_id = COALESCE(
        OLD.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri)
    );
END;

CREATE TRIGGER statuses_update_replies_count
AFTER UPDATE OF kind, visibility, in_reply_to_id, in_reply_to_uri ON statuses
WHEN (OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted'))
       IS NOT (NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted'))
  OR OLD.in_reply_to_id IS NOT NEW.in_reply_to_id
  OR OLD.in_reply_to_uri IS NOT NEW.in_reply_to_uri
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          OLD.in_reply_to_id,
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri)
      );
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        NEW.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER remote_statuses_insert_replies_count AFTER INSERT ON remote_statuses
BEGIN
    INSERT INTO status_stats (status_id, replies_count)
    SELECT NEW.id, replies
    FROM (SELECT
        (SELECT COUNT(*) FROM remote_statuses
         WHERE in_reply_to_uri = NEW.object_uri AND id <> NEW.id
           AND visibility IN ('public', 'unlisted'))
        + (SELECT COUNT(*) FROM statuses
           WHERE in_reply_to_uri = NEW.object_uri AND in_reply_to_id IS NULL
             AND kind = 'LocalNote' AND visibility IN ('public', 'unlisted')) AS replies)
    WHERE replies > 0
    ON CONFLICT (status_id) DO UPDATE SET replies_count = excluded.replies_count;
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri AND id <> NEW.id),
        (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = substr(NEW.in_reply_to_uri, -18)
           AND substr(NEW.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
               = '/users/' || a.username || '/statuses/' || s.id)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.in_reply_to_uri IS NOT NULL AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER remote_statuses_delete_stats AFTER DELETE ON remote_statuses
BEGIN
    DELETE FROM status_stats WHERE status_id = OLD.id;
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.in_reply_to_uri IS NOT NULL AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri),
          (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
           WHERE s.id = substr(OLD.in_reply_to_uri, -18)
             AND substr(OLD.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
                 = '/users/' || a.username || '/statuses/' || s.id)
      );
END;

CREATE TRIGGER remote_statuses_update_replies_count
AFTER UPDATE OF visibility, in_reply_to_uri ON remote_statuses
WHEN (OLD.visibility IN ('public', 'unlisted')) IS NOT (NEW.visibility IN ('public', 'unlisted'))
  OR OLD.in_reply_to_uri IS NOT NEW.in_reply_to_uri
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.in_reply_to_uri IS NOT NULL AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri AND id <> OLD.id),
          (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
           WHERE s.id = substr(OLD.in_reply_to_uri, -18)
             AND substr(OLD.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
                 = '/users/' || a.username || '/statuses/' || s.id)
      );
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri AND id <> NEW.id),
        (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = substr(NEW.in_reply_to_uri, -18)
           AND substr(NEW.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
               = '/users/' || a.username || '/statuses/' || s.id)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.in_reply_to_uri IS NOT NULL AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER follows_insert_stats AFTER INSERT ON follows
WHEN NEW.kind = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, followers_count) VALUES (NEW.target_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
    INSERT INTO account_stats (account_id, following_count) VALUES (NEW.follower_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER follows_delete_stats AFTER DELETE ON follows
WHEN OLD.kind = 'Accepted'
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE account_id = OLD.target_account_id;
    UPDATE account_stats SET following_count = following_count - 1
    WHERE account_id = OLD.follower_account_id;
END;

CREATE TRIGGER follows_update_stats
AFTER UPDATE OF kind, follower_account_id, target_account_id ON follows
WHEN (OLD.kind = 'Accepted') IS NOT (NEW.kind = 'Accepted')
  OR (NEW.kind = 'Accepted' AND (OLD.follower_account_id IS NOT NEW.follower_account_id
                                 OR OLD.target_account_id IS NOT NEW.target_account_id))
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE OLD.kind = 'Accepted' AND account_id = OLD.target_account_id;
    UPDATE account_stats SET following_count = following_count - 1
    WHERE OLD.kind = 'Accepted' AND account_id = OLD.follower_account_id;
    INSERT INTO account_stats (account_id, followers_count)
    SELECT NEW.target_account_id, 1 WHERE NEW.kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
    INSERT INTO account_stats (account_id, following_count)
    SELECT NEW.follower_account_id, 1 WHERE NEW.kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER remote_follows_insert_stats AFTER INSERT ON remote_follows
WHEN NEW.follow_kind = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, followers_count) VALUES (NEW.target_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
END;

CREATE TRIGGER remote_follows_delete_stats AFTER DELETE ON remote_follows
WHEN OLD.follow_kind = 'Accepted'
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE account_id = OLD.target_account_id;
END;

CREATE TRIGGER remote_follows_update_stats
AFTER UPDATE OF follow_kind, target_account_id ON remote_follows
WHEN (CASE WHEN OLD.follow_kind = 'Accepted' THEN OLD.target_account_id END)
  IS NOT (CASE WHEN NEW.follow_kind = 'Accepted' THEN NEW.target_account_id END)
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE OLD.follow_kind = 'Accepted' AND account_id = OLD.target_account_id;
    INSERT INTO account_stats (account_id, followers_count)
    SELECT NEW.target_account_id, 1 WHERE NEW.follow_kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
END;

CREATE TRIGGER outbound_follows_insert_stats AFTER INSERT ON outbound_follows
WHEN NEW.state = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, following_count) VALUES (NEW.account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER outbound_follows_delete_stats AFTER DELETE ON outbound_follows
WHEN OLD.state = 'Accepted'
BEGIN
    UPDATE account_stats SET following_count = following_count - 1
    WHERE account_id = OLD.account_id;
END;

CREATE TRIGGER outbound_follows_update_stats
AFTER UPDATE OF state, account_id ON outbound_follows
WHEN (CASE WHEN OLD.state = 'Accepted' THEN OLD.account_id END)
  IS NOT (CASE WHEN NEW.state = 'Accepted' THEN NEW.account_id END)
BEGIN
    UPDATE account_stats SET following_count = following_count - 1
    WHERE OLD.state = 'Accepted' AND account_id = OLD.account_id;
    INSERT INTO account_stats (account_id, following_count)
    SELECT NEW.account_id, 1 WHERE NEW.state = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER favourites_insert_count AFTER INSERT ON favourites
BEGIN
    INSERT INTO status_stats (status_id, favourites_count)
    VALUES (COALESCE(NEW.local_status_id, NEW.remote_status_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER favourites_delete_count AFTER DELETE ON favourites
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = COALESCE(OLD.local_status_id, OLD.remote_status_id);
END;

CREATE TRIGGER favourites_update_count
AFTER UPDATE OF local_status_id, remote_status_id ON favourites
WHEN COALESCE(OLD.local_status_id, OLD.remote_status_id)
  IS NOT COALESCE(NEW.local_status_id, NEW.remote_status_id)
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = COALESCE(OLD.local_status_id, OLD.remote_status_id);
    INSERT INTO status_stats (status_id, favourites_count)
    VALUES (COALESCE(NEW.local_status_id, NEW.remote_status_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER remote_favourites_insert_count AFTER INSERT ON remote_favourites
BEGIN
    INSERT INTO status_stats (status_id, favourites_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER remote_favourites_delete_count AFTER DELETE ON remote_favourites
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = OLD.status_id;
END;

CREATE TRIGGER remote_favourites_update_count
AFTER UPDATE OF status_id ON remote_favourites
WHEN OLD.status_id IS NOT NEW.status_id
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = OLD.status_id;
    INSERT INTO status_stats (status_id, favourites_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER remote_announces_insert_count AFTER INSERT ON remote_announces
BEGIN
    INSERT INTO status_stats (status_id, reblogs_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER remote_announces_delete_count AFTER DELETE ON remote_announces
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = OLD.status_id;
END;

CREATE TRIGGER remote_announces_update_count
AFTER UPDATE OF status_id ON remote_announces
WHEN OLD.status_id IS NOT NEW.status_id
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = OLD.status_id;
    INSERT INTO status_stats (status_id, reblogs_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER status_quotes_insert_count AFTER INSERT ON status_quotes
WHEN NEW.state = 'accepted'
  AND COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id) IS NOT NULL
BEGIN
    INSERT INTO status_stats (status_id, quotes_count)
    SELECT COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id), 1
    WHERE EXISTS (SELECT 1 FROM statuses WHERE id = NEW.quoted_status_id)
       OR EXISTS (SELECT 1 FROM remote_statuses WHERE id = NEW.quoted_remote_status_id)
    ON CONFLICT (status_id) DO UPDATE SET quotes_count = quotes_count + 1;
END;

CREATE TRIGGER status_quotes_delete_count AFTER DELETE ON status_quotes
WHEN OLD.state = 'accepted'
  AND COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id) IS NOT NULL
BEGIN
    UPDATE status_stats SET quotes_count = quotes_count - 1
    WHERE status_id = COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id);
END;

CREATE TRIGGER status_quotes_update_count
AFTER UPDATE OF state, quoted_status_id, quoted_remote_status_id ON status_quotes
WHEN (CASE WHEN OLD.state = 'accepted' THEN COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id) END)
  IS NOT (CASE WHEN NEW.state = 'accepted' THEN COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id) END)
BEGIN
    UPDATE status_stats SET quotes_count = quotes_count - 1
    WHERE OLD.state = 'accepted'
      AND status_id = COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id);
    INSERT INTO status_stats (status_id, quotes_count)
    SELECT COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id), 1
    WHERE NEW.state = 'accepted'
      AND (EXISTS (SELECT 1 FROM statuses WHERE id = NEW.quoted_status_id)
           OR EXISTS (SELECT 1 FROM remote_statuses WHERE id = NEW.quoted_remote_status_id))
    ON CONFLICT (status_id) DO UPDATE SET quotes_count = quotes_count + 1;
END;

CREATE TRIGGER statuses_insert_stats AFTER INSERT ON statuses
BEGIN
    INSERT INTO account_stats (account_id, statuses_count)
    VALUES (NEW.account_id, CASE WHEN NEW.visibility = 'direct' THEN 0 ELSE 1 END)
    ON CONFLICT (account_id) DO UPDATE
    SET statuses_count = statuses_count + CASE WHEN NEW.visibility = 'direct' THEN 0 ELSE 1 END;
END;

CREATE TRIGGER statuses_delete_stats AFTER DELETE ON statuses
BEGIN
    UPDATE account_stats SET statuses_count = statuses_count - 1
    WHERE account_id = OLD.account_id AND OLD.visibility <> 'direct';
    DELETE FROM status_stats WHERE status_id = OLD.id;
END;

-- An edit stores the visibility again (`updateLocalNote`); a change into or
-- out of direct moves the status out of or into the count.
CREATE TRIGGER statuses_update_visibility_stats
AFTER UPDATE OF visibility ON statuses
WHEN (OLD.visibility = 'direct') <> (NEW.visibility = 'direct')
BEGIN
    UPDATE account_stats
    SET statuses_count = statuses_count + CASE WHEN NEW.visibility = 'direct' THEN -1 ELSE 1 END
    WHERE account_id = NEW.account_id;
END;

-- ==========================================================================
-- Seed rows
-- ==========================================================================

INSERT INTO domain_policy_revision (id, token) VALUES (1, lower(hex(randomblob(16))));

-- The cursor of the paged sweep (see `backfill_cursors`):
-- `remote_status_retention` (server/remote-status-retention.ts).
INSERT INTO backfill_cursors (name) VALUES ('remote_status_retention');
