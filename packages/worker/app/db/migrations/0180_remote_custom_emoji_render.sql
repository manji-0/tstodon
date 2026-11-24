-- void:allow-destructive
-- (Void gate: the refresh bookkeeping of 0170, `remote_emoji_refreshes` with
-- its index and trigger, and the copies `remote_statuses.emojis_json` held,
-- are dropped once the copies are read into `remote_custom_emojis`; the
-- copies inside the profile and version JSON are removed with a WHERE.)
--
-- A remote post, version, poll or profile now shows the custom emoji of its
-- author's domain that `remote_custom_emojis` holds for each `:shortcode:` it
-- writes, read when it is rendered, as Mastodon's `CustomEmoji.from_text`
-- reads `custom_emojis` at each render. The copy of each emoji kept with the
-- post or profile, and the `RefreshRemoteEmoji` chain that rewrote the copies,
-- are no longer used.

-- Mastodon's `custom_emojis.disabled`: a disabled emoji is not shown anywhere
-- (`CustomEmoji.enabled` in `EntityCache#emoji`); an admin sets it from
-- `/admin/custom_emojis`, as the `enable` and `disable` batch actions.
ALTER TABLE remote_custom_emojis ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- The copies stored before 0170 name emoji `remote_custom_emojis` may not
-- hold, which Mastodon holds since it stored the post or profile. Each one
-- not held is read in, the newest copy of it first, from the posts, their
-- earlier versions and the profiles of an actor whose account domain does not
-- reject media (`skip_download?`; a suspension purges them). A copy names its
-- emoji's `updated`, else is dated as its document.
INSERT OR IGNORE INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
SELECT domain, shortcode, image_url, updated_at FROM (
  SELECT a.domain, json_extract(e.value, '$.shortcode') AS shortcode,
    json_extract(e.value, '$.url') AS image_url,
    coalesce(json_extract(e.value, '$.updated'), s.edited_at, s.published_at) AS updated_at
  FROM remote_statuses s
  JOIN remote_actors a ON a.actor_uri = s.actor_uri,
    json_each(CASE WHEN json_valid(s.emojis_json) THEN s.emojis_json ELSE '[]' END) e
  WHERE s.emojis_json <> '[]'
  UNION ALL
  SELECT a.domain, json_extract(e.value, '$.shortcode'), json_extract(e.value, '$.url'),
    coalesce(json_extract(e.value, '$.updated'), json_extract(v.snapshot_json, '$.at'), v.created_at)
  FROM remote_status_edits v
  JOIN remote_statuses s ON s.id = v.status_id
  JOIN remote_actors a ON a.actor_uri = s.actor_uri,
    json_each(CASE WHEN json_valid(v.snapshot_json)
      AND json_type(v.snapshot_json, '$.emojis') = 'array'
      THEN json_extract(v.snapshot_json, '$.emojis') ELSE '[]' END) e
  UNION ALL
  SELECT a.domain, json_extract(e.value, '$.shortcode'), json_extract(e.value, '$.url'),
    coalesce(json_extract(e.value, '$.updated'), a.fetched_at)
  FROM remote_actors a,
    json_each(CASE WHEN json_valid(a.profile_json)
      AND json_type(a.profile_json, '$.emojis') = 'array'
      THEN json_extract(a.profile_json, '$.emojis') ELSE '[]' END) e
) copies
WHERE typeof(shortcode) = 'text' AND shortcode <> ''
  AND typeof(image_url) = 'text' AND image_url <> ''
  AND domain NOT IN (
    SELECT a.domain FROM remote_actor_account_domain_rule r
    JOIN remote_actors a ON a.actor_uri = r.actor_uri
    JOIN domain_blocks d ON d.id = r.domain_block_id
    WHERE d.reject_media <> 0 OR d.severity = 'suspend'
  )
ORDER BY updated_at DESC;

DROP TRIGGER remote_custom_emojis_replaced;
DROP INDEX idx_remote_emoji_refreshes_unfinished;
DROP TABLE remote_emoji_refreshes;

ALTER TABLE remote_statuses DROP COLUMN emojis_json;

UPDATE remote_status_edits SET snapshot_json = json_remove(snapshot_json, '$.emojis')
WHERE CASE WHEN json_valid(snapshot_json)
  THEN json_type(snapshot_json, '$.emojis') IS NOT NULL ELSE 0 END;

UPDATE remote_actors SET profile_json = json_remove(profile_json, '$.emojis')
WHERE CASE WHEN json_valid(profile_json)
  THEN json_type(profile_json, '$.emojis') IS NOT NULL ELSE 0 END;
