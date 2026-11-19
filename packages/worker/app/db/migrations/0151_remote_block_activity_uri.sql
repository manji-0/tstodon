-- The id of the `Block` that made a remote actor's block, as Mastodon's
-- `blocks.uri`: an `Undo` that names the `Block` by its id only finds the
-- block by it (`try_undo_block`). Blocks recorded before have none.
ALTER TABLE remote_blocks ADD COLUMN activity_uri TEXT;
