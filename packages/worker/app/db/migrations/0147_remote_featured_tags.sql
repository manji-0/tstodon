-- The hashtags a remote actor features, in its order: read from its
-- `featuredTags` collection on a profile backfill, and changed by its `Add`
-- and `Remove` of a `Hashtag` (Mastodon's `FetchFeaturedTagsCollectionService`
-- and `Add#add_featured_tags`). `tag_name` is the normalized tag, `name` the
-- spelling the actor gave.
CREATE TABLE remote_featured_tags (
  actor_uri TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (actor_uri, tag_name),
  FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

ALTER TABLE remote_actors ADD COLUMN featured_tags_uri TEXT;
