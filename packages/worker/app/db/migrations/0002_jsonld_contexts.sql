-- The JSON-LD contexts a forwarded activity names that tstodon does not ship
-- (`server/jsonld-contexts.ts`), as Mastodon's `load_jsonld_context` keeps
-- them (`jsonld:context:<url>` in its cache, 30 days): the body as fetched.
-- A context older than that is fetched again; storing one deletes those past
-- it (`fetched_at`), so the table holds only what forwards named in the last
-- 30 days.
CREATE TABLE jsonld_contexts (
  url TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX idx_jsonld_contexts_fetched_at ON jsonld_contexts (fetched_at);
