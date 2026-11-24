-- @param {String} $1:id
-- An outbound activity with its signer's username and key: its account's, or
-- the ones kept for a deleted account's last activity. Both NULL for the
-- instance actor, or when the account is gone. The account's last key rotation
-- tells a Linked Data signature stored before it, made with the old key.
SELECT o.id, o.account_id, o.kind, o.payload_json, o.created_at, o.synchronize_followers,
       COALESCE(a.username, d.username) AS signer_username,
       COALESCE(a.private_key_jwk, d.private_key_jwk) AS signer_private_key_jwk,
       a.key_rotated_at AS signer_key_rotated_at
FROM outbound_activities o
LEFT JOIN accounts a ON a.id = o.account_id
LEFT JOIN outbound_departed_signers d ON d.activity_id = o.id
WHERE o.id = $1
