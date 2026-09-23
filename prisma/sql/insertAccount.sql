-- @param {String} $1:id
-- @param {String} $2:username
-- @param {String} $3:accessEmail
-- @param {String} $4:displayName
-- @param {Int} $5:locked
-- @param {String} $6:defaultPostVisibility
-- @param {String} $7:defaultQuotePolicy
-- @param {String} $8:publicKeyPem
-- @param {String} $9:privateKeyJwk
-- @param {String} $10:createdAt
-- @param {String} $11:updatedAt
-- @param {String} $12:bioText
INSERT INTO accounts (
  id, username, access_email, display_name, locked,
  default_post_visibility, default_quote_policy,
  public_key_pem, private_key_jwk, created_at, updated_at, bio_text
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
