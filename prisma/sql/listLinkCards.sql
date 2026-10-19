-- @param {String} $1:urlsJson
SELECT url, card_json FROM link_cards WHERE url IN (SELECT value FROM json_each($1))
