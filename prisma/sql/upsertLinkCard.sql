-- @param {String} $1:url
-- @param {String} $2:cardJson
-- @param {String} $3:now
INSERT INTO link_cards (url, card_json, fetched_at) VALUES ($1, $2, $3)
ON CONFLICT(url) DO UPDATE SET card_json = $2, fetched_at = $3
