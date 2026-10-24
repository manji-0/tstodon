-- @param {String} $1:tokenHash
SELECT t.id AS token_id, t.application_id, t.scopes, t.account_id,
  a.id, a.username, a.access_email, a.display_name, a.locked, a.default_post_visibility,
  a.default_quote_policy, a.public_key_pem, a.private_key_jwk, a.created_at,
  COALESCE(a.bio_text, '') AS bio_text,
  u.role AS auth_role, m.moderation, COALESCE(f.disabled, 0) AS disabled,
  t.web_session_id, s.expiresAt AS web_session_expires_at
FROM oauth_access_tokens t
LEFT JOIN accounts a ON a.id = t.account_id
LEFT JOIN "user" u ON u.id = a.auth_user_id
LEFT JOIN account_moderation m ON m.account_id = t.account_id
LEFT JOIN account_flags f ON f.account_id = t.account_id
LEFT JOIN "session" s ON s.id = t.web_session_id
WHERE t.token_hash = $1
