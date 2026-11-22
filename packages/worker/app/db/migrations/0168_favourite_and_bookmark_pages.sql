-- Mastodon pages an account's favourites and bookmarks by the `Favourite` and
-- `Bookmark` row id (`index_favourites_on_account_id_and_id`,
-- `index_bookmarks_on_account_id_and_id`). Every row here has an id shaped
-- like `newEntityId()` (migrations 0051 and 0092 gave the older rows theirs),
-- so the pages need only the index to walk them in id order.

CREATE INDEX IF NOT EXISTS idx_favourites_account_id ON favourites (account_id, id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_account_id ON bookmarks (account_id, id);
