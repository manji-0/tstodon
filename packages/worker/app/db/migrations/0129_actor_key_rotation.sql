-- Actor key rotation (OPS-8). A rotation replaces the key pair in place: the
-- key id stays `<actor>#main-key`, as Mastodon's, and the old key is not kept.
--
-- `accounts.key_rotated_at` is when the account's key pair was last replaced
-- (NULL: never, the pair made at sign-up). The bulk rotation job pages over
-- the accounts not rotated since it started, so a retried page does not
-- rotate the same account twice.
ALTER TABLE accounts ADD COLUMN key_rotated_at TEXT;

-- When the instance actor's key pair was last replaced (NULL: never).
ALTER TABLE instance_actor_keys ADD COLUMN rotated_at TEXT;

-- When a signature by this actor last failed to verify against its cached key
-- and its document was fetched again for a new key. One refetch per actor per
-- window (`claimRemoteActorKeyRefetch`), so forged signatures cannot make this
-- server fetch an actor over and over.
ALTER TABLE remote_actors ADD COLUMN key_refetched_at TEXT;
