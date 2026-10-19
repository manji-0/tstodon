-- Remote statuses carry link previews too.

ALTER TABLE remote_statuses ADD COLUMN card_json TEXT;
