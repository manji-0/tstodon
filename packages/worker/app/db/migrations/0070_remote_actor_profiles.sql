-- What a remote actor shows on its profile (bio as text, avatar, header,
-- profile URL, locked, bot, joined date), as RemoteActor.profile JSON. Rows
-- fetched before this keep the empty profile until they are fetched again.
ALTER TABLE remote_actors ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}';
