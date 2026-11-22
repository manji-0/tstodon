-- @param {String} $1:accountId
-- @param {String} $2:now
-- @param {String} $3:dueBefore
-- @param {String} $4:signedInAt
-- Mastodon's `update_sign_in!`: a sign-in at `$4` (empty when the request
-- carries none) moves `current_sign_in_at` to it, and a request at `$2`
-- moves it to `$2` when it is unset or older than `$3`, 24 hours before
-- (`UserTrackingConcern`). A row that neither moves is not written.
UPDATE accounts SET current_sign_in_at = CASE
    WHEN MAX(COALESCE(current_sign_in_at, ''), $4) < $3 THEN $2
    ELSE MAX(COALESCE(current_sign_in_at, ''), $4)
  END
WHERE id = $1
  AND (COALESCE(current_sign_in_at, '') < $3 OR COALESCE(current_sign_in_at, '') < $4)
