-- @param {String} $1:pairsJson
-- The enabled emoji of each `[domain, shortcode]` of `pairsJson`, one seek of
-- the primary key each, as Mastodon's `EntityCache#emoji` reads
-- `CustomEmoji.enabled.where(shortcode:, domain:)`.
SELECT r.domain, r.shortcode, r.image_url
FROM json_each($1) w
JOIN remote_custom_emojis r
  ON r.domain = json_extract(w.value, '$[0]') AND r.shortcode = json_extract(w.value, '$[1]')
WHERE r.disabled = 0
