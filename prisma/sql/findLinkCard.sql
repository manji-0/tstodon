-- @param {String} $1:url
SELECT card_json, fetched_at FROM link_cards WHERE url = $1
