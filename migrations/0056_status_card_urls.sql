-- The link a status's preview card was unfurled from, so the link timeline
-- (`GET /api/v1/timelines/link?url=`) can find the statuses carrying a card.
-- A stored card's `url` is that link, so existing cards backfill from it.

ALTER TABLE statuses ADD COLUMN card_url TEXT;
ALTER TABLE remote_statuses ADD COLUMN card_url TEXT;

UPDATE statuses SET card_url = json_extract(card_json, '$.url') WHERE card_json IS NOT NULL;
UPDATE remote_statuses SET card_url = json_extract(card_json, '$.url') WHERE card_json IS NOT NULL;

CREATE INDEX idx_statuses_card_url ON statuses (card_url, id) WHERE card_url IS NOT NULL;
CREATE INDEX idx_remote_statuses_card_url ON remote_statuses (card_url, id)
  WHERE card_url IS NOT NULL;
