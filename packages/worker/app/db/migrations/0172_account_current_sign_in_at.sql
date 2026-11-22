-- A local account's sign-in time, Mastodon's `users.current_sign_in_at`: set
-- by a request when it is unset or more than 24 hours old
-- (`UserTrackingConcern`) and by a fresh sign-in (`update_sign_in!`). The
-- fan-out and the `status` notification keep the followers whose time is
-- within `USER_ACTIVE_DAYS` of now (`User.signed_in_recently`).
--
-- Filled from the last UTC day each account was active (migration 0124), at
-- its start: Mastodon's time would be within the 24 hours before that day's
-- last request, and so is that day's start. One primary-key seek per local
-- account.

ALTER TABLE accounts ADD COLUMN current_sign_in_at TEXT;

UPDATE accounts SET current_sign_in_at = (
    SELECT MAX(d.day) FROM account_activity_days d WHERE d.account_id = accounts.id
) || 'T00:00:00.000Z';
