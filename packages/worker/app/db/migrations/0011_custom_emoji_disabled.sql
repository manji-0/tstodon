-- Mastodon's `custom_emojis.disabled` for this instance's own emoji: a
-- disabled emoji is not listed by `GET /api/v1/custom_emojis`, shown on a
-- post or profile, or tagged on a federated document (`CustomEmoji.enabled`
-- in `CustomEmoji.listed` and `EntityCache#emoji`). An admin sets it from
-- `/admin/custom_emojis`, as the `enable` and `disable` batch actions.
ALTER TABLE custom_emojis ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
