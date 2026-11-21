-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:inReplyToId?
-- @param {String} $4:text
-- @param {String} $5:contentHtml
-- @param {String} $6:visibility
-- @param {Int} $7:sensitive
-- @param {String} $8:spoilerText
-- @param {String} $9:language?
-- @param {String} $10:createdAt
-- @param {String} $11:updatedAt
-- A reply to a local status answers the parent's author or, when the reply's
-- author wrote the parent and the parent is itself a reply, whom the parent
-- answers (Mastodon's `carried_over_reply_to_account_id`).
INSERT INTO statuses (
  id, account_id, kind, in_reply_to_id, content_text, content_html, visibility, sensitive,
  spoiler_text, language, created_at, updated_at, in_reply_to_account_id, in_reply_to_actor_uri
) VALUES (
  $1, $2, 'LocalNote', $3, $4, $5, $6, $7, $8, $9, $10, $11,
  (SELECT CASE
     WHEN p.account_id = $2 AND (p.in_reply_to_id IS NOT NULL OR p.in_reply_to_uri IS NOT NULL)
     THEN p.in_reply_to_account_id
     ELSE p.account_id
   END FROM statuses p WHERE p.id = $3),
  (SELECT CASE
     WHEN p.account_id = $2 AND (p.in_reply_to_id IS NOT NULL OR p.in_reply_to_uri IS NOT NULL)
     THEN p.in_reply_to_actor_uri
   END FROM statuses p WHERE p.id = $3)
)
