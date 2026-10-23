-- Approval state for registrations that require it: a local account is pending
-- until an admin approves it, which is the one `account_flags.pending` bit.
-- Accounts without a row (and every account created before this migration) are
-- approved.

ALTER TABLE account_flags ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
