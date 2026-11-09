-- Mastodon 4.6's `for_bots` notification policy: what happens to a
-- notification from an automated account (a local account marked `bot`, a
-- remote actor of type `Service` or `Application`). Mastodon's default is
-- `accept`.

ALTER TABLE notification_policies ADD COLUMN for_bots TEXT NOT NULL DEFAULT 'accept';
