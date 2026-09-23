# Open TODOs (post D1 design catch-up)

<!-- constrained-by ../architecture/d1-heavy-scenarios.md -->
<!-- constrained-by ../architecture/d1-write-strategy.md -->

Tracked leftovers so e2e work can proceed without losing them.

## D1 / heavy scenarios (deferred)

| ID   | Item                                                   | Notes                                                  |
| ---- | ------------------------------------------------------ | ------------------------------------------------------ |
| D1-1 | Fan-out / expand-CPU SLO for secondary queue chunking  | Open Question — needs `outbox.expand` metrics evidence |
| D1-2 | Hard API max on list member mutation size              | Open Question — do not invent a number                 |
| D1-3 | Promote hashtag rows / FTS                             | After search/`timeline.tag` p95 evidence (Doc B PR6)   |
| D1-4 | Timeline preload: `Promise.all` vs single `runD1Batch` | Defer until metrics show a success criterion           |
| D1-5 | Hot-key Durable Object for write serialization         | Only with evidence beyond D1 primary                   |

## Done recently (do not re-open)

- json_each membership; TypedSQL fixed SQL; wrangler migrations SoT ADRs
- `runTypedBatch`; ExpandFollowers remote-only + chunked targets
- Create saga mentions-before-notify; `enqueueLocalActivity` Result
- Expired-poll bulk `mastodonStatuses`
- Analytics indexes: `outbox.expand`, `outbox.enqueue`, `search`, `timeline.tag`

## Active track

| ID    | Item                                                            | Status                        |
| ----- | --------------------------------------------------------------- | ----------------------------- |
| E2E-1 | process-compose multi-instance harness                          | done                          |
| E2E-2 | Minimal 2-instance federation (WebFinger + Follow→Create)       | done (host-driven Create hop) |
| E2E-3 | Undo/Like/Announce (+ Undo Like) e2e                            | done                          |
| E2E-5 | Delete + shared-inbox-only fan-out e2e                          | later                         |
| E2E-4 | Remove host-driven Create hop when workerd loopback fetch works | later                         |
