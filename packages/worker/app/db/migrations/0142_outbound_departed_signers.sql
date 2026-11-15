-- The `Delete` of a deleted account's actor is delivered after the account's
-- row, and its key with it, is gone. Its outbound activity has no account
-- (`account_id` NULL, so the delete of the account does not cascade to it);
-- this row keeps the name and the private key that sign it. The row is
-- deleted as soon as none of the activity's targets is still to be attempted
-- (`deleteSettledDepartedSigner.sql`); the cascade removes it with the
-- activity otherwise.
CREATE TABLE outbound_departed_signers (
    activity_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,
    FOREIGN KEY (activity_id) REFERENCES outbound_activities(id) ON DELETE CASCADE
);
