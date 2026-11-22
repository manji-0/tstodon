-- A local account's sign-in time, Mastodon's `users.current_sign_in_at`: set
-- by a request when it is unset or more than 24 hours old
-- (`UserTrackingConcern`) and by a fresh sign-in (`update_sign_in!`). The
-- fan-out and the `status` notification keep the followers whose time is
-- within `USER_ACTIVE_DAYS` of now (`User.signed_in_recently`).
--
-- Filled from the last UTC day each account was active (migration 0124):
-- the latest `account_ips.used_at` on that day when there is one, else the
-- day's start. Both lie between the day's start and its last request, so
-- within the 24 hours before that request, as Mastodon's own value does.
-- `used_at` is written as `Date#toISOString()`, the format compared here.
-- One primary-key seek per local account for each statement.

ALTER TABLE accounts ADD COLUMN current_sign_in_at TEXT;

UPDATE accounts SET current_sign_in_at = (
    SELECT MAX(d.day) FROM account_activity_days d WHERE d.account_id = accounts.id
) || 'T00:00:00.000Z';

UPDATE accounts SET current_sign_in_at = (
    SELECT MAX(i.used_at) FROM account_ips i
    WHERE i.account_id = accounts.id AND substr(i.used_at, 1, 10) = substr(accounts.current_sign_in_at, 1, 10)
)
WHERE current_sign_in_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM account_ips i
    WHERE i.account_id = accounts.id AND substr(i.used_at, 1, 10) = substr(accounts.current_sign_in_at, 1, 10)
);
