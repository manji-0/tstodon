-- @param {String} $1:createdBefore
-- @param {Int} $2:keepPerAccount
-- @param {Int} $3:limit
-- Up to `limit` of the oldest outbound activities created before
-- `createdBefore` that nothing reads any more. An activity stays while:
-- - a delivery row of it is unfinished (any state but `Delivered`, `Failed`,
--   `Expanded`): the delivery Workflow and `ExpandFollowers` read its JSON;
--   a missing activity would fail the delivery as a 404;
-- - it is one of its account's newest `keepPerAccount` Creates and
--   Announces addressed to Public, which `listPublicOutboxActivities` lists
--   as the ActivityPub outbox (the same filter, by id).
-- Nothing else reads a stored activity: `Undo` and `Delete` are built from
-- `outbound_follows`, the statuses and the interaction tables, not from here.
DELETE FROM outbound_activities
WHERE id IN (
    SELECT o.id FROM outbound_activities o
    WHERE o.created_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM outbox_deliveries d
        WHERE d.activity_id = o.id AND d.inbox_url IS NULL
          AND d.kind NOT IN ('Delivered', 'Failed', 'Expanded', 'Skipped')
      )
      AND NOT EXISTS (
        SELECT 1 FROM outbox_deliveries d
        WHERE d.activity_id = o.id AND d.inbox_url IS NOT NULL
          AND d.kind NOT IN ('Delivered', 'Failed', 'Expanded', 'Skipped')
      )
      AND NOT (
        o.account_id IS NOT NULL
        AND o.kind IN ('Create', 'Announce')
        AND EXISTS (
          SELECT 1 FROM json_each(o.payload_json, CASE o.kind WHEN 'Create' THEN '$.object.to' ELSE '$.to' END)
          WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
          UNION ALL
          SELECT 1 FROM json_each(o.payload_json, CASE o.kind WHEN 'Create' THEN '$.object.cc' ELSE '$.cc' END)
          WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
        )
        AND (
          SELECT n.id FROM outbound_activities n
          WHERE n.account_id = o.account_id
            AND n.id > o.id
            AND n.kind IN ('Create', 'Announce')
            AND EXISTS (
              SELECT 1 FROM json_each(n.payload_json, CASE n.kind WHEN 'Create' THEN '$.object.to' ELSE '$.to' END)
              WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
              UNION ALL
              SELECT 1 FROM json_each(n.payload_json, CASE n.kind WHEN 'Create' THEN '$.object.cc' ELSE '$.cc' END)
              WHERE value = 'https://www.w3.org/ns/activitystreams#Public'
            )
          ORDER BY n.id
          LIMIT 1 OFFSET ($2 - 1)
        ) IS NULL
      )
    ORDER BY o.created_at
    LIMIT $3
  )
