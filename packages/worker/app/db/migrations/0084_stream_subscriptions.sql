-- The public, hashtag, and list streams some socket in a `StreamHub` holds.
-- `hub` is the account id, or 'anonymous' for the hub of sockets without a
-- token; `param` is the lowercased tag, the list id, or '' for public streams.
-- A hub writes its rows before a subscription takes effect and drops them
-- after it ends, so a fan-out reaches every subscribed hub and only those.
CREATE TABLE stream_subscriptions (
  hub TEXT NOT NULL,
  stream TEXT NOT NULL,
  param TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hub, stream, param)
);
