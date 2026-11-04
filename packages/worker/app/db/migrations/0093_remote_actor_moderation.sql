-- An admin can limit (`Silenced`) or suspend (`Suspended`) one remote actor,
-- and mark its media sensitive, as Mastodon does for a remote account. The
-- row is keyed by actor URI with no foreign key to `remote_actors`, so the
-- decision outlives a purge and applies again if the actor is fetched anew.
-- A row exists only while the actor is not in the default state.

CREATE TABLE remote_actor_moderation (
    actor_uri TEXT PRIMARY KEY,
    moderation TEXT CHECK (moderation IS NULL OR moderation IN ('Silenced', 'Suspended')),
    sensitized INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_remote_actor_moderation_state
    ON remote_actor_moderation (moderation, actor_uri);

-- A report keeps the `user@domain` handle of each remote party, so the admin
-- views still say who it was after the actor is purged from `remote_actors`.
-- `NULL` for a local party and for reports filed before the snapshot.
ALTER TABLE reports ADD COLUMN reporter_acct TEXT;
ALTER TABLE reports ADD COLUMN target_acct TEXT;
