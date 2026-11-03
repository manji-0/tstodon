-- Pages through the local follows of one actor in id order (a Move carries them over).
CREATE INDEX idx_outbound_follows_actor_id ON outbound_follows (actor_uri, id);
