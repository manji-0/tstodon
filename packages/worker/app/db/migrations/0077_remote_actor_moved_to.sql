-- Where a remote actor announced it moved to, set only by a verified `Move`
-- (the new actor lists the old one in `alsoKnownAs`). Refreshing the cached
-- actor document leaves it alone, so an actor cannot claim a move itself.
ALTER TABLE remote_actors ADD COLUMN moved_to TEXT;
