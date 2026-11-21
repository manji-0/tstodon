-- Mastodon pages an account's domain blocks (`AccountDomainBlock`) and its
-- followed tags (`TagFollow`) by the row's own id: `max_id` / `since_id` in
-- the query, and in the `Link` header the controller sends. The rows here had
-- no id, so each gets one shaped like `newEntityId()`: its `created_at` in
-- milliseconds above the low 16 bits, the rowid's low 16 bits under them,
-- zero-padded to 18 digits so string order is time order.
--
-- A trigger gives every row written without an id the same id, so no insert
-- (a block, a follow, a domain or tag rename that moves a row) has to name
-- one, and none can leave a row out of the pages.

ALTER TABLE account_domain_blocks ADD COLUMN id TEXT;
ALTER TABLE followed_tags ADD COLUMN id TEXT;

UPDATE account_domain_blocks
  SET id = printf(
    '%018d',
    (CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER) << 16) | (rowid & 65535)
  )
  WHERE id IS NULL;

UPDATE followed_tags
  SET id = printf(
    '%018d',
    (CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER) << 16) | (rowid & 65535)
  )
  WHERE id IS NULL;

CREATE TRIGGER account_domain_blocks_id AFTER INSERT ON account_domain_blocks
WHEN NEW.id IS NULL
BEGIN
  UPDATE account_domain_blocks
    SET id = printf(
      '%018d',
      (CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER) << 16)
        | (NEW.rowid & 65535)
    )
    WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER followed_tags_id AFTER INSERT ON followed_tags
WHEN NEW.id IS NULL
BEGIN
  UPDATE followed_tags
    SET id = printf(
      '%018d',
      (CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER) << 16)
        | (NEW.rowid & 65535)
    )
    WHERE rowid = NEW.rowid;
END;

-- Each page seeks the account's rows in id order.
CREATE UNIQUE INDEX idx_account_domain_blocks_account_id ON account_domain_blocks (account_id, id);
CREATE UNIQUE INDEX idx_followed_tags_account_id ON followed_tags (account_id, id);
