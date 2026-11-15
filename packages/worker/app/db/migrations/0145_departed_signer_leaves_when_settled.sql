-- The key kept to sign a deleted account's `Delete`
-- (`outbound_departed_signers`, migration 0142) is needed only while a target
-- of the activity is still `Queued`. This trigger drops it when the last such
-- target leaves `Queued`, whatever writes the change: a delivery that settles
-- it, the stuck-delivery sweep that gives it up, or the purge of a remote
-- actor that fails its deliveries (`cancelRemoteActorDeliveries.sql`).
-- Targets are never deleted while `Queued` (the vacuum prunes settled ones),
-- so an update is the only way out of `Queued`.
CREATE TRIGGER outbound_departed_signers_leave_when_settled
AFTER UPDATE OF kind ON outbox_deliveries
WHEN OLD.kind = 'Queued' AND NEW.kind <> 'Queued' AND NEW.inbox_url IS NOT NULL
BEGIN
  DELETE FROM outbound_departed_signers
  WHERE activity_id = NEW.activity_id
    AND NOT EXISTS (
      SELECT 1 FROM outbox_deliveries
      WHERE activity_id = NEW.activity_id AND inbox_url IS NOT NULL AND kind = 'Queued'
    );
END;

-- The keys whose activity had no `Queued` target before the trigger: one
-- whose targets were cancelled, or one stored without targets.
DELETE FROM outbound_departed_signers
WHERE NOT EXISTS (
  SELECT 1 FROM outbox_deliveries
  WHERE outbox_deliveries.activity_id = outbound_departed_signers.activity_id
    AND inbox_url IS NOT NULL AND kind = 'Queued'
);
