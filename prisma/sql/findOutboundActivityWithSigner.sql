-- @param {String} $1:id
-- An outbound activity with its signing account's username and key (NULL for
-- the instance actor, or when the account is gone).
SELECT o.id, o.account_id, o.kind, o.payload_json, o.created_at,
       a.username AS signer_username, a.private_key_jwk AS signer_private_key_jwk
FROM outbound_activities o LEFT JOIN accounts a ON a.id = o.account_id
WHERE o.id = $1
