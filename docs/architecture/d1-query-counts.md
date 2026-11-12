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
| `home(20)`                 |         37 / 8 |        30 / 7 |                       43 / 7 |       32 / 6 |
| `public local(20)`         |         32 / 8 |        25 / 7 |                       40 / 6 |       29 / 5 |
| `public(20)`               |         33 / 7 |        26 / 6 |                       41 / 6 |       30 / 5 |
| `tag(20)`                  |         35 / 8 |        28 / 7 |                       15 / 4 |       15 / 4 |
| `list(20)`                 |         39 / 9 |        32 / 8 |                       44 / 9 |       33 / 8 |
| `status`                   |         32 / 9 |        25 / 8 |                       15 / 6 |       15 / 6 |
| `context(10 replies)`      |        88 / 37 |       41 / 13 | 49 / 28 (500 below the root) |       20 / 9 |
| `account`                  |          8 / 2 |         6 / 3 |                        3 / 2 |        3 / 2 |
| `account statuses(20)`     |        37 / 11 |       30 / 10 |                       18 / 7 |       18 / 7 |
| `relationships(2)`         |         12 / 2 |        12 / 2 |                        5 / 2 |        5 / 2 |
| `notifications(20)`        |         45 / 8 |        35 / 7 |                       48 / 7 |       48 / 7 |
| `bookmarks(20)`            |         33 / 7 |        26 / 6 |                       25 / 6 |       25 / 6 |
| `favourites(20)`           |         33 / 7 |        26 / 6 |                       25 / 6 |       25 / 6 |
| `conversations`            |         48 / 9 |        38 / 8 |                       19 / 5 |       19 / 5 |
| `POST status(tag+mention)` |       133 / 43 |       58 / 27 |                      25 / 12 |      25 / 12 |
| `POST favourite`           |        87 / 28 |       41 / 17 |                       20 / 9 |       19 / 9 |
| `POST unfavourite`         |         31 / 8 |        24 / 7 |                       18 / 9 |       18 / 9 |
| `POST reblog`              |        96 / 35 |       50 / 24 |                      39 / 19 |      37 / 14 |
| `POST unreblog`            |        37 / 11 |       30 / 10 |                      21 / 12 |      21 / 12 |
| `POST bookmark`            |        34 / 11 |       27 / 10 |                       23 / 9 |       23 / 9 |
| `POST follow`              |        36 / 19 |       27 / 10 |                        6 / 5 |        7 / 5 |
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

## Billed quota usage

The tables above count round trips. What runs out first on Workers Paid is the included usage, so this section counts what each request bills.

| Meter                   | Included per month | What counts                                                                                          |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| D1 rows read            | 25 billion         | Every row a statement scans, index rows included. A query that returns 20 rows can read 40,000.      |
| D1 rows written         | 50 million         | Every inserted, updated or deleted row, plus each index entry and each row a trigger writes.         |
| Durable Object requests | 1 million          | Each stub fetch or RPC call, each alarm, and incoming WebSocket messages at 20:1.                    |
| Durable Object duration | 400,000 GB-s       | Wall time while a DO is in memory. A socket accepted without the Hibernation API keeps it in memory. |
| Queue operations        | 1 million          | Three per message (write, read, delete).                                                             |
| Workflow steps          | 500,000            | Each `step.do` and `step.sleep`.                                                                     |

### How it is measured

The query-count report (see [How the numbers are measured](#how-the-numbers-are-measured)) also reads `meta.rows_read` and `meta.rows_written` of every D1 result and counts calls on the Durable Object, Queue, KV and Workflow bindings. These totals include work that runs after the response, because that work is billed too. A second run seeds 20,000 unrelated public local statuses (each favourited) and 20,000 remote statuses, and reports which requests read more. A read path whose rows grow with unrelated data scans instead of seeking, and becomes the dominant cost as an instance grows.

Run it with `QUERY_COUNT_NOISE=20000` (tstodon) or `NOISE=20000 just query-count` (cfwdon).

### Results

"Before" is the branch after the round-trip changes above and before the quota work; each cell gives before → after when the value changed. DO / queue are Durable Object requests / Queue messages. Rate limiting is enabled in these runs.

| Request                    | tstodon rows read | tstodon rows read, noise | tstodon rows written | tstodon DO / queue | cfwdon rows read | cfwdon rows read, noise | cfwdon rows written | cfwdon DO / queue |
| -------------------------- | ----------------: | -----------------------: | -------------------: | -----------------: | ---------------: | ----------------------: | ------------------: | ----------------: |
| `verify_credentials`       |            18 → 9 |                   18 → 9 |                    0 |          1/0 → 0/0 |                4 |                       4 |                   0 |         1/0 → 0/0 |
| `home(20)`                 |        1250 → 918 |               1253 → 919 |                    0 |          1/0 → 0/0 |              741 |                     742 |                   0 |         1/0 → 0/0 |
| `public local(20)`         |        1070 → 757 |              21000 → 708 |                    0 |          1/0 → 0/0 |              554 |                     710 |                   0 |         1/0 → 0/0 |
| `public(20)`               |        1070 → 757 |                831 → 587 |                    0 |          1/0 → 0/0 |              554 |                     870 |                   0 |         1/0 → 0/0 |
| `tag(20)`                  |         377 → 228 |              40377 → 228 |                    0 |          1/0 → 0/0 |              147 |             40148 → 146 |                   0 |         1/0 → 0/0 |
| `list(20)`                 |        1286 → 981 |               1287 → 981 |                    0 |          1/0 → 0/0 |              704 |                     705 |                   0 |         1/0 → 0/0 |
| `status`                   |          108 → 57 |                 108 → 57 |                    0 |          1/0 → 0/0 |               26 |                      26 |                   0 |         1/0 → 0/0 |
| `context(10 replies)`      |         728 → 561 |                729 → 561 |                    0 |          1/0 → 0/0 |              354 |                     354 |                   3 |         1/0 → 0/0 |
| `account`                  |           49 → 14 |                  49 → 14 |                    0 |          1/0 → 0/0 |                2 |                       2 |                   0 |         1/0 → 0/0 |
| `account statuses(20)`     |        1033 → 752 |               1033 → 752 |                    0 |          1/0 → 0/0 |        448 → 449 |               449 → 448 |                   0 |         1/0 → 0/0 |
| `relationships(2)`         |                21 |                       21 |                    0 |          1/0 → 0/0 |                6 |                       6 |                   0 |         1/0 → 0/0 |
| `notifications(20)`        |         893 → 617 |              20894 → 617 |                    0 |          1/0 → 0/0 |        319 → 286 |             20320 → 286 |                   0 |         1/0 → 0/0 |
| `bookmarks(20)`            |         368 → 243 |                368 → 243 |                    0 |          1/0 → 0/0 |              142 |                     142 |                   0 |         1/0 → 0/0 |
| `favourites(20)`           |         369 → 244 |                369 → 244 |                    0 |          1/0 → 0/0 |              142 |                     142 |                   0 |         1/0 → 0/0 |
| `conversations`            |         350 → 240 |                350 → 240 |                    0 |          1/0 → 0/0 |        108 → 107 |               107 → 108 |                   0 |         1/0 → 0/0 |
| `POST status(tag+mention)` |         326 → 189 |                326 → 189 |              33 → 34 |          3/3 → 3/1 |          85 → 63 |                 88 → 62 |                  35 |        13/1 → 1/1 |
| `POST favourite`           |         271 → 139 |                271 → 139 |              11 → 12 |          2/0 → 1/0 |          34 → 29 |                 34 → 29 |                  11 |         2/0 → 0/0 |
| `POST unfavourite`         |          111 → 62 |                 111 → 62 |                1 → 2 |          1/0 → 0/0 |               30 |                      30 |                   2 |         1/0 → 0/0 |
| `POST reblog`              |         353 → 174 |                353 → 174 |              27 → 29 |          3/2 → 3/1 |          79 → 74 |                 79 → 74 |                  21 |         2/0 → 1/0 |
| `POST unreblog`            |          146 → 78 |                 146 → 78 |              11 → 13 |          2/2 → 1/1 |          57 → 58 |                      58 |                   4 |         1/0 → 0/0 |
| `POST bookmark`            |          114 → 64 |                 114 → 64 |                    4 |          1/0 → 0/0 |               30 |                      30 |                   6 |         1/0 → 0/0 |
| `POST follow`              |           69 → 39 |                  69 → 39 |              14 → 16 |          2/0 → 2/0 |            7 → 8 |                   7 → 8 |                  10 |         2/0 → 1/0 |
| `POST unfollow`            |           23 → 25 |                  24 → 26 |                2 → 4 |          1/0 → 0/0 |                7 |                       7 |                   3 |         1/0 → 0/0 |

The remaining DO requests on writes are the rate limiter's exact buckets (one per write, by design) and stream publishes to an account that has a stream open.

### Changes, by meter

**D1 rows read**

- **Tag timelines walk the tag index (both).** The query used to scan `statuses` and join tags; it now starts from the tag's index rows, newest first, and stops after a bounded walk. With noise: tstodon 40,377 → 228 and cfwdon 40,148 → 146.
- **Counters from trigger-kept tables (tstodon).** Rendering an account or status counted its statuses, followers, favourites and boosts with `COUNT(*)`, which read one row per counted item on every render. Migration 0138 adds `account_stats` and `status_stats`, kept by triggers as cfwdon already did. `replies_count` is now a real count. This is most of tstodon's drop on read paths. It also removes the growth with noise: rendering the noise account read its 20,000 statuses for `statuses_count`, so the local public timeline went 21,000 → 708 and notifications 20,894 → 617.
- **Notification collectors seek (cfwdon).** Collectors filtered on a joined column, so each read scanned every favourite. Migration 136 indexes the notified account and quoted account columns: 20,320 → 286 with noise.
- **Context, both ways.** One recursive CTE replaces the level-by-level walk (see above).

**D1 rows written**

- **Fewer write indexes (cfwdon).** Migration 137 drops indexes no query used, and 138 adds the seeks a status delete's cascade needs.
- **Trade-off (tstodon).** The counter triggers add one to two written rows per favourite, boost or follow. At the included ratio (500 rows read per row written), that pays for itself once the counted rows are read once.
- **Remote status retention (tstodon, as cfwdon already did).** A cron slice deletes remote statuses older than `REMOTE_STATUS_RETENTION_DAYS` that nothing local references. It keeps the tables, and every scan over them, from growing without bound. cfwdon's purge now walks a keyset cursor (`(published_at, id) > cursor`, migration 134) instead of rescanning from the start on each slice.

**Durable Object requests**

- **Local-first rate limiting (both).** Every API request used to ask the rate-limit DO. High-volume buckets (`api_ip`, `api_token`, `api_account`, the inbox and federation buckets) now count in the isolate first. They ask the DO only once an isolate's unsent count could cross a quarter of the remaining headroom, sending the whole unsent count at once. Write buckets (statuses, media, follows, reports, sign-in, OAuth) still ask the DO on every hit, so their limits stay exact. GET requests went from 1 DO request to 0. The DO keeps one alarm, an hour after its last window ends, which deletes its storage. The Workers Rate Limiting binding was rejected: it only supports 10 s and 60 s periods and cannot follow per-instance limit overrides.
- **Publish only to streams someone holds (both).** The stream hub records the open subscriptions in D1 (`stream_subscriptions`). A publisher reads that table before calling a hub, so a post nobody streams costs no DO request. cfwdon's `POST status` went from 13 DO requests to 1.

**Durable Object duration**

- **SSE over a hibernating socket (tstodon, as cfwdon already did).** The SSE route opens a WebSocket to the hub and writes the SSE response itself. The hub accepts that socket with the Hibernation API, so an idle SSE client no longer keeps the hub in memory. Before, one always-connected client used about 330,000 of the 400,000 GB-s per month.

**Queue operations (tstodon)**

- **Skip fan-outs with no listener, and run the first page after the response.** A post nobody streams sends no fan-out message. When someone does, the first fan-out page runs under `waitUntil`, and only later pages and failures are queued. Link cards are unfurled after the response and queued only on a transient failure. `POST status` went from 3 messages to 1, the delivery expansion.
- **Run cron jobs in the cron invocation.** Most maintenance jobs run one page inline and queue only their next page. Expired polls and scheduled posts are queued only when a one-row read finds work. The estimate is about 5,500 messages a month down to about 120.
- **Trade-off.** A stream opened through another isolate can miss up to 5 s of events, because the listener lookup is cached for 5 s per isolate.

**Workflow steps (tstodon)**

- **One Workflow per activity.** Delivery used to start one Workflow per inbox, with several steps each. One instance now delivers an activity, 10 inboxes per step. An activity to 25 inboxes went from 83 steps to 5.

### Guards

- tstodon: `packages/worker/server/d1-budget.test.ts` runs in the normal test suite. It reads 12 GET endpoints, seeds 3,000 unrelated rows, and fails when any endpoint reads 200 or more extra rows. Reverting the tag index walk makes it fail with 6,000 extra rows.
- cfwdon: `scripts/check_query_plans.py` runs 43 queries from the source and fails when a hot query scans instead of seeking.

## Where each server still pays more

<!-- derived-from #results -->

| Area                                                | Cheaper server | Why                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single status, tag, account statuses, conversations | cfwdon         | cfwdon renders through one two-wave preload. tstodon's `renderLocalStatuses` is still 7 to 8 serial rounds: reply and boost passes, then quotes, then two waves, then `presentedAccounts`, then move targets.              |
| Write paths                                         | cfwdon         | tstodon still screens and inserts a notification inline, and runs about 10 serial checks before the insert in `POST /statuses`. cfwdon builds notifications on read.                                                       |
| Auth                                                | tstodon        | One statement joins token, account, role and moderation, and the result is memoized per request. cfwdon also needs one statement but resolves the token again in the rate limiter (an isolate cache absorbs most of that). |
| Notifications                                       | about even     | cfwdon derives notifications from 13 collectors on every read. tstodon reads a table but loads the page's statuses twice.                                                                                                  |

Next steps, in order of expected payoff:

1. tstodon: flatten `renderLocalStatuses` into the two-wave shape cfwdon uses.
2. tstodon: move notification screening and insertion for favourites, boosts and follows after the response, as Mastodon does with its workers. Tests that read notifications right after the request would then need to wait for `waitUntil`.
3. cfwdon: fill the boost-target embed preloads in `notifications/status_preload.rs` and `streaming_home_batch.rs`, which still look up local targets one by one.
4. cfwdon: record deferred work's D1 time in its own bucket. It is currently charged to the next request on the isolate, which feeds the load-shed heuristic (see `api-latency.md`, Caveats).
