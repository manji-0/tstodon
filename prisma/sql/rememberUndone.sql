-- @param {String} $1:actorUri
-- @param {String} $2:activityUri
-- @param {String} $3:createdAt
-- Remember `actorUri`'s `Undo` of the activity `activityUri` (a `Like`, an
-- `Announce`, a `Block`, or one named by its id only), so that activity is
-- dropped if it comes after: each statement that stores one checks this
-- table. Written before the `Undo` deletes what it ends, so an activity
-- stored at the same time is either deleted or dropped.
INSERT INTO undone_before_arrival (actor_uri, activity_uri, created_at)
VALUES ($1, $2, $3)
ON CONFLICT (actor_uri, activity_uri) DO UPDATE SET created_at = excluded.created_at
