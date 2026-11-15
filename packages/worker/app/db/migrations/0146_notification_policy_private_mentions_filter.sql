-- `for_private_mentions` defaulted to `drop` here; Mastodon's default is
-- `filter`. A policy row holds all six categories, so an account that changed
-- any one of them stored `drop` for this one without choosing it. The policy
-- now applies to remote senders as well, where `drop` would discard a
-- stranger's direct message without a trace, so a stored `drop` becomes
-- `filter`: the message waits in a notification request. A `drop` chosen on
-- purpose becomes `filter` too, as the two cannot be told apart; the account
-- can set it again.
--
-- An account with no row reads the default from the code. The column's own
-- default stays `drop`: every insert writes the column.

UPDATE notification_policies SET for_private_mentions = 'filter'
WHERE for_private_mentions = 'drop';
