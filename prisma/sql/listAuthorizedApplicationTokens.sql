-- The tokens an account gave to apps. The web app's own tokens
-- (`web_session_id`) belong to browser sessions and are not apps.
-- @param {String} $1:accountId
SELECT t.application_id, a.name, a.website, t.scopes, t.created_at
FROM oauth_access_tokens t
JOIN oauth_applications a ON a.id = t.application_id
WHERE t.account_id = $1 AND t.web_session_id IS NULL
ORDER BY t.created_at DESC, t.id
