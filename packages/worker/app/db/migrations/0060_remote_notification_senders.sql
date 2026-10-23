-- void:allow-destructive
-- (Void gate: the DROP TABLEs belong to a SQLite table rebuild; rows are copied first.)
-- Remote actors can send notifications: `from_account_id` may now be a
-- remote account id (`r_…`), so it loses its foreign key to `accounts`, and
-- `from_actor_uri` records the actor URI so blocks and mutes keyed by URI can
-- hide a remote sender's notifications.
--
-- `notification_requests` cascades from `notifications`, and dropping a parent
-- table fires that cascade, so the requests are parked in a scratch table and
-- restored once `notifications` has been rebuilt.

CREATE TABLE notification_requests_scratch AS SELECT * FROM notification_requests;
DROP TABLE notification_requests;

CREATE TABLE notifications_new (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    from_actor_uri TEXT,
    kind TEXT NOT NULL,
    status_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT INTO notifications_new (id, account_id, from_account_id, kind, status_id, created_at)
  SELECT id, account_id, from_account_id, kind, status_id, created_at FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_account_created_at
    ON notifications (account_id, created_at DESC);

CREATE TABLE notification_requests (
    notification_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    from_account_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status_id TEXT,
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT INTO notification_requests (notification_id, account_id, from_account_id, created_at, status_id)
  SELECT notification_id, account_id, from_account_id, created_at, status_id
  FROM notification_requests_scratch;

DROP TABLE notification_requests_scratch;

CREATE INDEX idx_notification_requests_account
    ON notification_requests (account_id, from_account_id);

-- Without the foreign key, a purged local account's sent notifications are
-- removed by trigger, as the cascade used to do.
CREATE TRIGGER notifications_sender_deleted AFTER DELETE ON accounts
BEGIN
    DELETE FROM notifications WHERE from_account_id = OLD.id;
END;
