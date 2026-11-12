# D1 Query Counts: tstodon and cfwdon

<!-- constrained-by ./d1-heavy-scenarios.md -->
<!-- constrained-by ./d1-write-strategy.md -->

This note compares tstodon (TypeScript) and cfwdon (Rust), two Mastodon-compatible servers on Cloudflare Workers and D1. It records how many D1 statements and serial D1 rounds each API use case costs, which ideas each server took from the other, and what is still expensive. Both repositories carry the same copy of this note.

## How the numbers are measured

Both servers run one identical scenario and count D1 work per request:

- Nine local accounts. Alice follows Bob and Carol, and six accounts follow Alice.
- Bob writes 15 statuses. Every third one has a hashtag and mentions Alice.
- Carol boosts 3 of Bob's statuses and favourites 5. Alice favourites and bookmarks 5.
- A thread of 10 replies hangs under one of Alice's statuses.
- Bob sends Alice 3 direct messages, and Alice has a list with Bob and Carol.

Each row gives the D1 statements that ran before the response was returned, then the serial rounds those statements formed. A round starts when a statement starts while no other statement is in flight, so N concurrent statements count as one round. A `db.batch` counts as one round, and each statement inside it counts separately. Work that runs after the response (`waitUntil`) is not in the table.

| Server  | Command                                                                                    | Where it counts                                                                                   |
| ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| tstodon | `pnpm build && QUERY_COUNT=1 pnpm vp test run --project worker query-count --silent=false` | `packages/worker/server/query-count.bench.test.ts` patches the D1 binding inside the test isolate |
| cfwdon  | build the worker, then `just query-count`                                                  | `scripts/query_count/` wraps the built entry and runs `wrangler dev` on a seeded local D1         |

Setting `QUERY_COUNT_SQL=<label>` (tstodon) or passing the label as an argument (cfwdon) also lists each statement. On tstodon, a `+` marks a statement that starts a new round. The numbers come from local runs (Miniflare / `wrangler dev`), so they count round trips and do not time them. On the deployed Worker each serial round costs one D1 round trip.

## Results

Each cell gives statements / serial rounds before the response. "Before" is the branch base and "after" is this branch.

| Request                    | tstodon before | tstodon after |                cfwdon before | cfwdon after |
| -------------------------- | -------------: | ------------: | ---------------------------: | -----------: |
| `verify_credentials`       |          6 / 3 |         5 / 2 |                        6 / 2 |        6 / 2 |
| `home(20)`                 |         37 / 8 |        36 / 7 |                       43 / 7 |       32 / 6 |
| `public local(20)`         |         32 / 8 |        31 / 7 |                       40 / 6 |       29 / 5 |
| `public(20)`               |         33 / 7 |        32 / 6 |                       41 / 6 |       30 / 5 |
| `tag(20)`                  |         35 / 8 |        34 / 7 |                       15 / 4 |       15 / 4 |
| `list(20)`                 |         39 / 9 |        38 / 8 |                       44 / 9 |       33 / 8 |
| `status`                   |         32 / 9 |        31 / 8 |                       15 / 6 |       15 / 6 |
| `context(10 replies)`      |        88 / 37 |       47 / 13 | 49 / 28 (500 below the root) |       20 / 9 |
| `account`                  |          8 / 2 |         7 / 2 |                        3 / 2 |        3 / 2 |
| `account statuses(20)`     |        37 / 11 |       36 / 10 |                       18 / 7 |       18 / 7 |
| `relationships(2)`         |         12 / 2 |        12 / 2 |                        5 / 2 |        5 / 2 |
| `notifications(20)`        |         45 / 8 |        43 / 7 |                       48 / 7 |       48 / 7 |
| `bookmarks(20)`            |         33 / 7 |        32 / 6 |                       25 / 6 |       25 / 6 |
| `favourites(20)`           |         33 / 7 |        32 / 6 |                       25 / 6 |       25 / 6 |
| `conversations`            |         48 / 9 |        46 / 8 |                       19 / 5 |       19 / 5 |
| `POST status(tag+mention)` |       133 / 43 |       64 / 27 |                      25 / 12 |      25 / 12 |
| `POST favourite`           |        87 / 28 |       47 / 17 |                       20 / 9 |       20 / 9 |
| `POST unfavourite`         |         31 / 8 |        30 / 7 |                       18 / 9 |       18 / 9 |
| `POST reblog`              |        96 / 35 |       56 / 24 |                      39 / 19 |      38 / 14 |
| `POST unreblog`            |        37 / 11 |       36 / 10 |                      21 / 12 |      21 / 12 |
| `POST bookmark`            |        34 / 11 |       33 / 10 |                       23 / 9 |       23 / 9 |
| `POST follow`              |        36 / 19 |       27 / 10 |                        6 / 5 |        6 / 5 |
| `POST unfollow`            |         14 / 4 |        14 / 4 |                        5 / 5 |        5 / 5 |

On cfwdon's base, `GET /api/v1/statuses/:id/context` answered 500 for every status below a thread root, because of an ambiguous `id` column in the ancestor query. This branch fixes that.

## Changes on this branch

### New in both servers: one recursive query for the reply tree

Both servers used to walk a thread's descendants one level at a time. tstodon spent about 3 serial rounds per level and cfwdon spent 3. Both now run one recursive CTE that walks local replies (by `in_reply_to_id`) and remote replies (by `in_reply_to_uri`) together. The statuses then load in one concurrent round.

- tstodon. `prisma/sql/listThreadDescendantIds.sql` keeps the old breadth-first order, sorted by id within each level. Ancestors and descendants now load concurrently. A plan test checks that the query seeks `statuses` and `remote_statuses`.
- cfwdon. `LOCAL_REPLY_TREE_CTE` lives in `statuses/store_local.rs`. The existing level-by-level walk now runs in memory, so a hidden status still hides its replies. `scripts/check_query_plans.py` runs the ancestor and tree queries as they appear in the source file, on a mixed local and remote thread.

### Taken by tstodon from cfwdon

- **Work after the response.** cfwdon queues side effects with `deferred.rs` and drains them under `wait_until`. tstodon now does the same with `afterResponse` (`server/after-response.ts`). The queue is an AsyncLocalStorage scope that the first middleware opens and starts under `waitUntil` from `cloudflare:workers` once the handler returns. Notification stream renders, Web Push fan-out, a new note's stream event and its fan-out sends now run there. A new note is also rendered once instead of twice.
- **Isolate cache for custom emojis.** Like cfwdon's `custom_emojis/store.rs`, the emoji rows stay in the isolate for 60 s, and the store's own writes clear them. This removes one serial round from almost every rendering request.
- **Concurrent independent reads.** cfwdon's notification collectors read in concurrent waves. tstodon's notification screening read one row at a time, and each independent group now runs as one round.

### Taken by cfwdon from tstodon

- **Render embedded targets from the batch.** tstodon renders a page's boost and reply targets from batched preloads. cfwdon's preload covered remote boost targets, but each local boost target was looked up again one statement at a time: owner, media, reply author, poll, mentions and quote count. The second preload wave now loads those for all local targets at once. This saves one serial round and 11 statements on a home page with boosts, and 5 rounds on `POST reblog`.

### Measurement in both servers

Both repositories now include the same scenario and row format. Run either one before and after a change to a hot path.

## Where each server still pays more

<!-- derived-from #results -->

| Area                                                | Cheaper server | Why                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interaction counts                                  | cfwdon         | Triggers maintain `status_counts` and `account_stats`. tstodon runs `COUNT(*)` on every render (7 statements for interactions, 3 for account counts), and its `replies_count` is always 0.                                 |
| Single status, tag, account statuses, conversations | cfwdon         | cfwdon renders through one two-wave preload. tstodon's `renderLocalStatuses` is still 7 to 8 serial rounds: reply and boost passes, then quotes, then two waves, then `presentedAccounts`, then move targets.              |
| Write paths                                         | cfwdon         | tstodon still screens and inserts a notification inline, and runs about 10 serial checks before the insert in `POST /statuses`. cfwdon builds notifications on read.                                                       |
| Auth                                                | tstodon        | One statement joins token, account, role and moderation, and the result is memoized per request. cfwdon also needs one statement but resolves the token again in the rate limiter (an isolate cache absorbs most of that). |
| Notifications                                       | about even     | cfwdon derives notifications from 13 collectors on every read. tstodon reads a table but loads the page's statuses twice.                                                                                                  |

Next steps, in order of expected payoff:

1. tstodon: add trigger-maintained counter tables, which is the cfwdon design, and fill in `replies_count`.
2. tstodon: flatten `renderLocalStatuses` into the two-wave shape cfwdon uses.
3. tstodon: move notification screening and insertion for favourites, boosts and follows after the response, as Mastodon does with its workers. Tests that read notifications right after the request would then need to wait for `waitUntil`.
4. cfwdon: fill the boost-target embed preloads in `notifications/status_preload.rs` and `streaming_home_batch.rs`, which still look up local targets one by one.
5. cfwdon: record deferred work's D1 time in its own bucket. It is currently charged to the next request on the isolate, which feeds the load-shed heuristic (see `api-latency.md`, Caveats).
