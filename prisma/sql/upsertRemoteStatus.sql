-- @param {String} $1:id
-- @param {String} $2:actorUri
-- @param {String} $3:objectUri
-- @param {String} $4:url?
-- @param {String} $5:contentHtml
-- @param {String} $6:spoilerText
-- @param {String} $7:visibility
-- @param {Int} $8:sensitive
-- @param {String} $9:language?
-- @param {String} $10:publishedAt
-- @param {String} $11:mediaJson
-- @param {String} $12:createdAt
-- @param {String} $13:updatedAt
-- @param {String} $14:inReplyToUri?
-- @param {String} $15:editedAt?
-- @param {String} $16:pollJson?
-- @param {String} $17:quotePolicyJson?
-- @param {String} $18:inReplyToLocalId?
-- The reply's `in_reply_to_account_id`: a local parent's author, or a held
-- remote parent's, or, when the note's author wrote that parent and it is
-- itself a reply, whom the parent answers (Mastodon's
-- `carried_over_reply_to_account_id`). `inReplyToLocalId` is the local
-- status `inReplyToUri` names, if it names one.
INSERT INTO remote_statuses (
  id, actor_uri, object_uri, url, content_html, spoiler_text,
  visibility, sensitive, language, published_at, media_json, created_at, updated_at, in_reply_to_uri, edited_at, poll_json, quote_policy_json,
  in_reply_to_account_id, in_reply_to_actor_uri
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
  CASE WHEN $18 IS NOT NULL
    THEN (SELECT l.account_id FROM statuses l WHERE l.id = $18)
    ELSE (SELECT p.in_reply_to_account_id FROM remote_statuses p
          WHERE p.object_uri = $14 AND p.actor_uri = $2)
  END,
  CASE WHEN $18 IS NULL
    THEN (SELECT CASE WHEN p.actor_uri = $2
                       AND (p.in_reply_to_uri IS NOT NULL OR p.in_reply_to_account_id IS NOT NULL
                            OR p.in_reply_to_actor_uri IS NOT NULL)
                      THEN p.in_reply_to_actor_uri ELSE p.actor_uri END
          FROM remote_statuses p WHERE p.object_uri = $14)
  END
)
ON CONFLICT(object_uri) DO UPDATE SET
  card_json = CASE WHEN content_html = excluded.content_html THEN card_json ELSE NULL END,
  card_url = CASE WHEN content_html = excluded.content_html THEN card_url ELSE NULL END,
  content_html = excluded.content_html,
  spoiler_text = excluded.spoiler_text,
  visibility = excluded.visibility,
  sensitive = excluded.sensitive,
  language = excluded.language,
  published_at = excluded.published_at,
  url = excluded.url,
  media_json = excluded.media_json,
  poll_json = excluded.poll_json,
  quote_policy_json = excluded.quote_policy_json,
  edited_at = coalesce(excluded.edited_at, edited_at),
  updated_at = excluded.updated_at
WHERE remote_statuses.actor_uri = excluded.actor_uri
