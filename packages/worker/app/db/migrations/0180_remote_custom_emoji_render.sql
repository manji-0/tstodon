-- void:allow-destructive
-- (Void gate: the refresh bookkeeping of 0170, `remote_emoji_refreshes` with
-- its index and trigger, and the copies column `remote_statuses.emojis_json`
-- are dropped; nothing reads them any more.)
--
-- A remote post, version, poll or profile now shows the custom emoji of its
-- author's domain that `remote_custom_emojis` holds for each `:shortcode:` it
-- writes, read when it is rendered, as Mastodon's `CustomEmoji.from_text`
-- reads `custom_emojis` at each render. The copy of each emoji kept with a
-- post or profile, and the `RefreshRemoteEmoji` chain that rewrote the
-- copies, are gone.

-- Mastodon's `custom_emojis.disabled`: a disabled emoji is not shown anywhere
-- (`CustomEmoji.enabled` in `EntityCache#emoji`); an admin sets it from
-- `/admin/custom_emojis`, as the `enable` and `disable` batch actions.
ALTER TABLE remote_custom_emojis ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER remote_custom_emojis_replaced;
DROP INDEX idx_remote_emoji_refreshes_unfinished;
DROP TABLE remote_emoji_refreshes;

ALTER TABLE remote_statuses DROP COLUMN emojis_json;
