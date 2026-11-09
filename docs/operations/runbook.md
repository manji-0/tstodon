# Operations Runbook

<!-- constrained-by ./cloudflare-deploy.md -->
<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

Day-2 operations for a tstodon instance on Cloudflare: backups and restore, monitoring and alerting, incident playbooks, and upgrades. Going live the first time is the [launch checklist](./launch-checklist.md); provisioning and the first deploy are the [Cloudflare deploy checklist](./cloudflare-deploy.md).

Conventions in this document:

- `wrangler` means `pnpm -C packages/worker exec wrangler`, run from the repository root, so it reads `packages/worker/wrangler.jsonc`.
- Resource names are the ones this repository ships: Worker `tstodon`, D1 database `tstodon` (binding `DB`), R2 bucket `tstodon-media` (`MEDIA`), Queue `tstodon-outbox-process` (`OUTBOX_PROCESS_QUEUE`), Workflow `tstodon-outbox-delivery` (`OUTBOX_DELIVERY_WORKFLOW`), Analytics Engine dataset `tstodon_metrics` (`METRICS`). Substitute yours if `infra/cloudflare` created them under other names.
- Facts about this server come from the code and are exact. Cloudflare limits, retention windows and dashboard paths are from Cloudflare's documentation as of writing; the ones marked **(verify)** are worth checking against the current docs or dashboard before you rely on them.

## What holds state

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

| Binding                                    | Holds                                                                                                                                                                                                                             | Needs a backup                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `DB` (D1)                                  | Everything relational: accounts and their **actor private keys** (`accounts.private_key_jwk`, `instance_actor_keys.private_key_jwk`), statuses, follows, notifications, OAuth tables, Better Auth `user` / `session`, outbox rows | Yes, and it is sensitive (see below)  |
| `MEDIA` (R2)                               | Local uploads under `attachments/`, `avatars/`, `headers/`, custom emoji under `emoji/`, image previews                                                                                                                           | Yes                                   |
| `APP_CACHE` (KV)                           | Only `mailbox:<recipient>` entries when `EMAIL_TRANSPORT=capture` (tests and local e2e), one-hour TTL                                                                                                                             | No                                    |
| `REMOTE_DNS_CACHE` (KV)                    | Nothing: no code reads or writes it at this revision (OPS-7 in [open TODOs](../planning/open-todos.md))                                                                                                                           | No                                    |
| `RATE_LIMIT_COUNTER` (Durable Object)      | Rate-limit counters, deleted by an alarm when their window ends                                                                                                                                                                   | No                                    |
| `STREAM_HUB` (Durable Object)              | Open streaming connections                                                                                                                                                                                                        | No                                    |
| `OUTBOX_PROCESS_QUEUE` / Workflow          | In-flight jobs and deliveries; their durable state is the `outbox_deliveries` rows in D1                                                                                                                                          | No (restore D1, see caveats)          |
| `METRICS` (Analytics Engine), Workers Logs | Telemetry, kept for Cloudflare's retention window                                                                                                                                                                                 | No                                    |
| Worker secrets and vars                    | `BETTER_AUTH_SECRET`, `VAPID_PRIVATE_JWK`, `CF_ACCESS_*`, instance vars                                                                                                                                                           | Keep the values offline (see secrets) |

## Backups and restore

### D1 Time Travel (point-in-time restore)

Time Travel is always on for D1; there is nothing to configure. It keeps a restorable history of the last 30 days on Workers Paid (7 days on Free) **(verify)** at minute granularity. Restoring replaces the whole database in place; there is no per-table restore.

Inspect:

```sh
wrangler d1 time-travel info tstodon                                   # current bookmark
wrangler d1 time-travel info tstodon --timestamp 2026-11-09T03:00:00Z  # bookmark for a past moment
wrangler d1 time-travel info tstodon --timestamp 1762657200 --json     # Unix seconds also work
```

Restore (this is destructive for everything written after the target):

1. Record the current bookmark (`wrangler d1 time-travel info tstodon --json`). A restore can be undone by restoring to that bookmark; wrangler also prints the previous bookmark when the restore finishes.
2. Stop the writers you can stop. `wrangler queues pause-delivery tstodon-outbox-process` holds the queue consumer (fan-out, backfills, cron-queued jobs); resume it with `wrangler queues resume-delivery tstodon-outbox-process`. There is no maintenance switch in the Worker: to stop HTTP writes during the restore, add a temporary WAF custom rule that blocks the hostname, or accept that requests in flight fail.
3. Restore:

   ```sh
   wrangler d1 time-travel restore tstodon --timestamp 2026-11-09T03:00:00Z
   # or: wrangler d1 time-travel restore tstodon --bookmark <bookmark>
   ```

4. Check the schema against the deployed code. The restore also rewinds `d1_migrations`:

   ```sh
   wrangler d1 migrations list tstodon --remote
   ```

   If migrations are pending, the deployed Worker expects a schema the database no longer has. Either redeploy (`pnpm run deploy` applies the pending migrations before uploading) or roll the Worker back to a version that matches (see [Rolling back a bad deploy](#rolling-back-a-bad-deploy)).

5. Resume the queue.

Caveats, from how this server works:

- **Deliveries in flight.** Each delivery Workflow instance reads its `outbound_activities` row on every attempt. If the restore removed the row, the attempt counts as a 404 and the delivery ends `Failed` / `Permanent`; nothing is sent. Deliveries whose rows survive continue. Workflow instance ids are a hash of activity id and inbox (`deliveryWorkflowId` in `server/delivery.ts`), so a delivery that already ran is not started again for the same row.
- **Queue messages in flight** may name rows that no longer exist. Jobs handle a missing row as nothing to do or as a retry; a job that keeps failing is dropped after 3 attempts (`OutboxJobDropped`).
- **Federation does not rewind.** Remote servers keep what they received after the restore point: posts that no longer exist here (they get a 404 when fetched; no `Delete` is sent), follows and accepts this server has forgotten, profile updates. Expect a few days of inconsistency for anything that happened in the lost window.
- **Media does not rewind.** R2 is not restored. Objects uploaded after the restore point stay in the bucket unreferenced; objects the media vacuum or an account purge deleted after the restore point are gone, and their rows point at nothing (404).

### Periodic exports

Time Travel lives in the same account as the database and covers only its window. Keep exports elsewhere as well. This repository has no export job yet (OPS-4 in [open TODOs](../planning/open-todos.md)); run one from CI or a trusted machine:

```sh
f=tstodon-$(date -u +%Y%m%dT%H%MZ).sql
wrangler d1 export tstodon --remote --output "$f"
age -r <recipient-public-key> -o "$f.age" "$f" && rm "$f"   # or gpg; the dump contains private keys
wrangler r2 object put "tstodon-backups/d1/$f.age" --file "$f.age" --remote
```

- **Schedule.** Daily, off-peak, keeping about 30 dailies and 12 monthlies is a reasonable start; Time Travel already covers fine-grained recovery inside its window, so the exports are for account loss, operator error discovered late, and moving the instance.
- **Cost of an export.** D1 documents that an export blocks other queries to the database while it runs **(verify)**, so a large export is a short outage of the API; run it when traffic is lowest. Export does not support databases with virtual tables; tstodon's migrations create none (no FTS). `--table`, `--no-data` and `--no-schema` narrow the dump.
- **Where to put it.** A separate bucket, ideally in a different Cloudflare account or another provider, with a lock rule so a leaked token cannot delete history (`wrangler r2 bucket lock add tstodon-backups --retention-days 35`). `wrangler r2 object put` has an upload size limit **(verify)**; for large dumps use an S3-compatible client (rclone, `aws s3 cp`) with an R2 API token.
- **Restore from an export** into a new database, then point the Worker at it:

  ```sh
  wrangler d1 create tstodon-restore
  wrangler d1 execute tstodon-restore --remote --file tstodon-<stamp>.sql
  ```

  Put the new `database_id` in `packages/worker/wrangler.jsonc` and `pnpm run deploy`. The dump includes `d1_migrations`, so the deploy applies only the migrations newer than the dump. Check the placement region still matches the new database's primary location.

### R2 media

R2 has no object versioning to fall back on **(verify)**, and the Worker deletes objects as part of normal operation (`DELETE /api/v1/media/:id`, the six-hourly `VacuumMediaAttachments`, account purges, `MEDIA_REKEY_DELETE_LEGACY`). Options:

- **rclone** (or any S3-compatible sync) from the media bucket to a bucket in another account or provider, on a schedule. `rclone copy` keeps objects the Worker deleted; `rclone sync` mirrors deletions. With an R2 API token (Object Read on the source):

  ```sh
  rclone copy r2:tstodon-media backup:tstodon-media-backup --transfers 16
  ```

- **Bucket lock rules on the backup bucket**, never on the live one: a lock on `tstodon-media` makes the Worker's own deletes fail (`MediaObjectsNotDeleted`).
- **Lifecycle rules**: do not add expiration rules to the live bucket; every object there is referenced by a row until the Worker deletes it. On the backup bucket, expiration or Infrequent Access transitions (`wrangler r2 bucket lifecycle add`) keep the copy cheap.
- **Event notifications** (`wrangler r2 bucket notification`) can drive an incremental copy through a queue if a periodic sync is too slow; this repository has no such consumer.

The media bucket alone is not a usable backup: object keys are random, and only D1 says which account and status an object belongs to. Back up both, at about the same time.

### KV, Durable Objects, telemetry

Nothing to back up. `APP_CACHE` holds captured mail only in test setups, `REMOTE_DNS_CACHE` is unused, rate-limit counters expire with their window, `StreamHub` holds connections. Analytics Engine and Workers Logs keep data only for their retention window; export what you need to keep (Logpush, below).

### Secrets and configuration inventory

Keep these in a password manager or vault, outside Cloudflare:

| Item                                                                  | Where it lives                         | If lost                                                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                                  | Worker secret                          | Generate a new one; see [rotation](#key-compromise-and-secret-rotation)                                                                         |
| `VAPID_PRIVATE_JWK`                                                   | Worker secret                          | Every Web Push subscription stops working; clients must subscribe again                                                                         |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ADMIN_GROUPS`    | Worker vars (not secret)               | Read them again from Zero Trust → Access → Applications                                                                                         |
| The Access application itself (paths, policies, identity providers)   | Cloudflare Zero Trust                  | Recreate from the [deploy checklist](./cloudflare-deploy.md) protect/bypass list; a new application has a new AUD                               |
| Actor private keys                                                    | D1 (`accounts`, `instance_actor_keys`) | Unrecoverable without a D1 backup: remote servers cache the public keys, so new keys break signature verification until they refetch the actors |
| Cloudflare API tokens (deploy, OpenTofu, Queues send, Analytics read) | Your CI / machine                      | Roll them in the dashboard (My Profile → API Tokens)                                                                                            |
| `infra/cloudflare/terraform.tfvars` and the OpenTofu state            | Your machine / state backend           | Re-import the resources                                                                                                                         |
| `packages/worker/wrangler.jsonc` with production ids                  | Your deploy branch                     | Recreate from `tofu output -json wrangler_bindings`                                                                                             |

**A D1 backup is a key backup.** It contains every actor's private signing key, the Better Auth `session` rows (whose `token` derives the web app's access token: `webAccessToken` in `server/web-app.ts`), push subscription endpoints and keys, Access email addresses and account IP history. OAuth client secrets, codes and access tokens are stored as SHA-256 digests. Treat an export like the secrets above: encrypt it, restrict who can read the bucket, and never attach one to an issue.

`wrangler secret list` shows secret names, never values. Vars set in the dashboard are replaced by `wrangler.jsonc` on the next `wrangler deploy` unless `keep_vars` is set **(verify)**; keep production vars in your deploy copy of `wrangler.jsonc` so a deploy does not silently drop them.

## Monitoring and alerting

### Logs

`wrangler.jsonc` enables Workers Logs and traces with `head_sampling_rate: 1` (every invocation). Where to read them:

- **Workers Logs** (dashboard: Workers & Pages → `tstodon` → Observability / Logs). Kept 3 days on Free and 7 days on Paid **(verify)**. Every server event below is one `console.*` line holding a JSON object with a `kind` field; filter on the message containing `"kind":"OutboxJobDropped"` (Workers Logs also extracts JSON fields for querying; check whether your view offers `kind` as a field). Invocations also carry the request path, status and outcome, which is how inbox refusals are found (they are not logged as events, OPS-5).
- **Live tail**: `wrangler tail tstodon --format pretty` (add `--status error`, `--search OutboxWorkflowCreateFailed`, `--method POST`, `--ip self`). Tail sees queue, cron and Workflow invocations too.
- **Logpush** to R2 or a third party for longer retention and alerting: needs Workers Paid, `"logpush": true` in `wrangler.jsonc` (not set in this repository) and a Logpush job for the Workers trace events dataset (dashboard: Analytics & Logs → Logpush) **(verify)**.

### Log events

Level is the `console` method. Every event's `kind` is unique to one meaning; the source file is under `packages/worker/server/`.

**Delivery and the outbox queue.** Act on any of these: each one means activities did not leave or a job was abandoned.

| Event                                              | Level       | Source                                              | Meaning                                                                                                                                                                                                                       | Act                                                                                                                   |
| -------------------------------------------------- | ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `OutboxEnqueueInsertFailed`                        | error       | `delivery.ts`                                       | Storing the outbound activity in D1 failed (`accountId` or `signer`, `activityKind`, `message`); nothing was delivered                                                                                                        | D1 health; the user's local action happened, remotes never hear of it                                                 |
| `OutboxEnqueueInvalidActivityId`                   | error       | `delivery.ts`                                       | D1 returned an id that is not an activity id                                                                                                                                                                                  | Bug; report it                                                                                                        |
| `OutboxEnqueueQueueSendFailed`                     | error       | `delivery.ts`                                       | The activity is stored but its `ExpandFollowers` message was not queued, so no follower inbox gets it                                                                                                                         | Queue health (dashboard), then check `outbox.enqueue` volume                                                          |
| `OutboxWorkflowCreateFailed`                       | error       | `delivery.ts`                                       | Starting the delivery Workflow for one inbox failed (`activityId`, `message`)                                                                                                                                                 | Workflows limits / status. The target row stays `Queued`; the hourly sweep starts it again once it is an hour overdue |
| `OutboxWorkflowRestartFailed`                      | error       | `stuck-delivery-sweep.ts`                           | The sweep could not restart an ended delivery Workflow (`activityId`, `inboxUrl`, `message`)                                                                                                                                  | Retried by the next sweep; read the instance with `wrangler workflows instances describe`                             |
| `OutboxDeliveryGivenUp`                            | warn        | `outbox-delivery-run.ts`, `stuck-delivery-sweep.ts` | A delivery ended unsent (`reasonKind`: `RetryExhausted` after 17 attempts, `Permanent` for a refusal such as 410, `Stuck` for a target the sweep found over 10 days old; `inboxUrl`, `attempts`, `lastOutcome`, `httpStatus`) | Many for one host: the remote is down or refusing; see [unavailable domains](#a-remote-domain-is-marked-unavailable)  |
| `OutboxDeliverySkipped`                            | log         | `delivery.ts`, `outbox-delivery-run.ts`             | Targets on a domain marked unavailable were recorded `Skipped` instead of sent (`activityId`, `targets`, `domains`)                                                                                                           | Expected while a domain is unavailable                                                                                |
| `DeliveryDomainUnavailable`                        | warn        | `delivery-domain-health-store.ts`                   | A domain had failed deliveries on 7 distinct days with no success between; deliveries to it are skipped from now (`domain`, `failureDays`)                                                                                    | Check the domain; mark it available on `/admin/instances/<domain>` if it is back                                      |
| `DeliveryDomainAvailable`                          | log         | `delivery-domain-health-store.ts`                   | An unavailable domain answered a delivery, sent a verified activity, or an admin marked it available (`domain`, `failureDays`, `via`)                                                                                         | None                                                                                                                  |
| `DeliveryDomainHealthNotRecorded`                  | error       | `delivery-domain-health-store.ts`                   | D1 refused the failure-day write or the clear (`domain`, `reachability`, `message`); the delivery itself went on                                                                                                              | D1 health                                                                                                             |
| `OutboxDeliverySweep`, `OutboxDeliverySweepFailed` | log / error | `stuck-delivery-sweep.ts`                           | The hourly stuck-delivery sweep found overdue targets (counts), or could not list them                                                                                                                                        | A steady `created` or `restarted` count points at Workflows errors                                                    |
| `OutboxExpandLookupFailed`                         | error       | `outbox-job.ts`                                     | Fan-out could not load the activity or its audience (`lookup`)                                                                                                                                                                | The job is retried; repeated lines point at D1                                                                        |
| `OutboxExpandTargetsFailed`                        | error       | `outbox-job.ts`                                     | Fan-out could not write the per-inbox target rows                                                                                                                                                                             | As above                                                                                                              |
| `OutboxJobRejected`                                | error       | `queue-handler.ts`                                  | A queue message is not a valid `OutboxJob` (`issues`). Usually a hand-sent message with a wrong body, or version skew between producer and consumer during a deploy                                                           | Fix the sender. The message is retried and then discarded by Queues (no dead-letter queue)                            |
| `OutboxJobDropped`                                 | error       | `queue-handler.ts`                                  | A job returned retry on its third attempt and was acknowledged, so it will not run again (`jobKind`, `attempts`). Paired with the `outbox.job` `failed` metric                                                                | Read the job's own error lines just before it; cron-queued jobs run again at the next cron, others do not             |

**"Not federated" and "not queued".** The local change succeeded (the post exists, the profile changed) but the activity or follow-up job that tells remote servers was not created. One line is worth reading; a stream of them points at D1 or the queue.

| Event                                                                                                                                        | Source                                                                                                        | What did not happen                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `StatusNotFederated`, `StatusUpdateNotFederated`, `StatusDeleteNotFederated`                                                                 | `local-status-publish.ts`, `local-status-update.ts`, `admin-status-actions.ts`, `local-status-delete.ts`      | `Create`, `Update` or `Delete` of a local status (`statusId`)                                              |
| `PollUpdateNotQueued`, `PollUpdateNotFederated`                                                                                              | `poll-update.ts`                                                                                              | The delayed `Update(Question)` with new vote counts                                                        |
| `InteractionNotFederated`, `UnreblogNotFederated`                                                                                            | `routes/statuses/interactions.ts`                                                                             | The `Like` or its `Undo` for a remote status (`activity`), or the `Undo(Announce)` of a boost (`statusId`) |
| `ProfileUpdateNotFederated`                                                                                                                  | `routes/accounts/credentials.ts`                                                                              | The actor `Update` after a profile change (`accountId`, `error`)                                           |
| `BlockFollowNotSevered`                                                                                                                      | `account-block.ts`                                                                                            | Unfollow / remove-follower on a block (`step`, `targetActorUri`)                                           |
| `DomainBlockSeveranceNotFederated`, `DomainBlockSeverNotQueued`                                                                              | `account-domain-block.ts`                                                                                     | Severing follows with a user-blocked domain                                                                |
| `ReportForwardFailed`                                                                                                                        | `routes/reports.ts`                                                                                           | Forwarding a report to the remote server (`reportId`, `domain`)                                            |
| `QuoteRequestNotSent`, `QuoteRequestAnswerNotSent`, `QuoteAnswerNotAnnounced`, `QuoteRevokeNotAnnounced`                                     | `local-status-publish.ts`, `inbox/quote-request.ts`, `inbox/quote-answer.ts`, `routes/statuses/engagement.ts` | FEP-044f quote request, its `Accept` / `Reject`, or the revoke                                             |
| `QuoteStampDeleteNotFederated`, `QuoteStampDeleteNotForwarded`, `QuoteRefreshNotAnnounced`, `QuoteRefetchNotQueued`, `QuoteRefreshNotQueued` | `quote-stamp-revoke.ts`, `quote-retry-jobs.ts`, `quote-retry-queue.ts`                                        | Quote stamp withdrawal and quote retry jobs                                                                |
| `HomeFanOutNotQueued`, `PublicFanOutNotQueued`, `RemovedStatusesFanOutNotQueued`                                                             | `home-fan-out.ts`, `public-fan-out.ts`                                                                        | The next page of a home / public timeline fan-out                                                          |
| `MoveFollowsNotQueued`                                                                                                                       | `remote-move.ts`                                                                                              | The next page of moving follows after a remote account `Move`                                              |
| `ThreadBackfillNotQueued`, `OutboxBackfillNotQueued`, `OutboxBackfillPageNotQueued`                                                          | `remote-thread-backfill.ts`, `remote-outbox-backfill.ts`                                                      | Fetching a remote thread or a remote actor's recent posts                                                  |
| `ExpiredPollsFollowUpNotQueued`, `CsvImportNotQueued`                                                                                        | `poll-expiry.ts`, `csv-import-apply.ts`                                                                       | The next page of poll expiry or of a CSV import (the import then shows as stopped)                         |

**Streaming.** `HomeFanOutNotPublished`, `ListFanOutNotPublished`, `PublicFanOutNotPublished` (`hub`), `BoostRemovalNotPublished`, `ConversationNotPublished` (`home-fan-out.ts`, `public-fan-out.ts`, `conversation-stream.ts`): a `StreamHub` Durable Object call failed, so open clients missed a live update. Timelines are still correct on reload. Act only on a sustained rate (Durable Object errors in the dashboard).

**Media.**

| Event                                                | Level        | Meaning                                                                                                                                         |
| ---------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MediaImageRejected`, `MediaVideoRejected`           | warn         | `POST /api/v{1,2}/media` refused a file whose metadata could not be stripped (422 to the client, `error` says why)                              |
| `ProfileImageRejected`                               | warn         | The same for an avatar or header (`image`)                                                                                                      |
| `MediaImageNotProcessed`                             | warn         | The `IMAGES` binding could not analyse an image (`reason`): stored without dimensions, preview or blurhash. A burst means Images is failing     |
| `MediaPreviewNotStored`                              | warn         | The preview could not be written to R2                                                                                                          |
| `MediaObjectsNotDeleted`                             | error        | An R2 delete failed (`keys` count, `message`); the objects stay as orphans                                                                      |
| `LegacyMediaNotRekeyed`                              | error        | The rekey backfill skipped a row (`mediaId`, `reason`); retried hourly                                                                          |
| `MediaMetadataNotStripped`, `MediaSizeNotRead`       | warn / error | A backfill skipped one object (`outcome`); warn when the object is missing, error otherwise. See the [deploy checklist](./cloudflare-deploy.md) |
| `MediaMetadataBackfillDone`, `MediaSizeBackfillDone` | log          | A backfill run finished, with its counts                                                                                                        |

**Rate limits** (`rate-limit.ts`; plain strings, not JSON):

- `RATE_LIMITS is not a JSON object of known buckets; using the defaults` (warn): the `RATE_LIMITS` var is malformed and was ignored as a whole. Fix the var.
- `rate limit counter unavailable: …` (warn): a `RateLimitCounter` call failed and the request went through uncounted (fail open). Sustained lines mean limits are not enforced; check Durable Object errors.

**Not logged.** Inbox refusals (`401 InvalidSignature`, `503 VerificationUnavailable`, `403` for refused domains and suspended actors) are not log events (OPS-5); find them by request path and status in Workers Logs. A delivery attempt is not a log line either: each writes an `outbox.deliver` metric point, and only a delivery that ends unsent logs (`OutboxDeliveryGivenUp`).

### Analytics Engine metrics

<!-- constrained-by ../architecture/d1-heavy-scenarios.md#metric-reference -->

Every point is written by `writeMetric` in `packages/worker/server/metrics.ts` to dataset `tstodon_metrics`; a failed write is swallowed. Columns: `index1` is the metric name, then `double1..` and `blob1..`. The full table is the [metric reference](../architecture/d1-heavy-scenarios.md#metric-reference); the ones operators watch:

| `index1`          | Doubles                                                    | Blobs                                                                              | Watch for                                                                   |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `cron`            | `[1]`                                                      | `[cronExpression, scheduled]`                                                      | Missing points: a cron run failed (written only when all its sends succeed) |
| `outbox.job`      | `[1]`                                                      | `[jobKind, retry or failed]`                                                       | Any `failed`                                                                |
| `outbox.job.page` | `[size, elapsedMs, chainedFlag]`                           | `[jobKind, ok or retry or error, step]`                                            | `error` and `retry` by job; `elapsedMs` growth                              |
| `outbox.enqueue`  | `[1]`                                                      | `[activityKind]` or `[activityKind, targeted]`                                     | Volume of outgoing activities; a drop to zero while users post              |
| `outbox.expand`   | `[remoteTargetCount, expandMs, okFlag, skippedCount]`      | `[ok or targets_failed]`                                                           | `targets_failed`                                                            |
| `outbox.deliver`  | `[latencyMs, failedHttpStatus, attemptNumber]`             | `[success or permanent or http or throttled or network or local or skipped, host]` | Failure share per host; `local` (this server's D1 or keys failing)          |
| `outbox.skip`     | `[skippedCount]`                                           | `[expand or targeted, DomainUnavailable]`                                          | Volume left out for unavailable domains                                     |
| `outbox.domain`   | `[failureDays]`                                            | `[unavailable or available, delivery or inbound or admin]`                         | Any `unavailable`                                                           |
| `outbox.sweep`    | `[examined, created, restarted, waiting, givenUp, failed]` | `[ok or error]`                                                                    | `error`; `created` / `restarted` above zero every hour                      |
| `push.deliver`    | `[httpStatus or 0]`                                        | `[httpStatus or network]`                                                          | 401/403 (VAPID key problem), `network`                                      |
| `timeline.*`      | `[latencyMs, rows]`                                        | `[ok or error]`                                                                    | p95 latency, `error` share                                                  |
| `search`          | `[latencyMs, accountHits, statusHits]`                     | `[type]`                                                                           | p95 latency                                                                 |
| `stream.render`   | `[renderMs, deliveredFlag]`                                | `[home or list or public, ok or error]`                                            | `error` share                                                               |

`outbox.job.page` is written by every paged job: `FanOutHome`, `FanOutPublic`, `DistributePollUpdate`, `ProcessExpiredPolls`, `MoveFollows`, `BackfillRemoteOutbox`, `BackfillRemoteThread`, `ProcessCsvImport`, `CleanUpAccountStatuses`, `SeverBlockedDomainFollows`, `FanOutRemovedStatuses`, `BackfillLocalNoteTags`, `RekeyLegacyMedia`, `VacuumMediaAttachments`, `StripStoredMediaMetadata`, `BackfillStoredMediaSizes` (`blob1` is the job kind as queued). The delivery Workflow writes one `outbox.deliver` point per attempt.

Query with the SQL API (an API token with Account Analytics Read):

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  --data "SELECT blob1 AS job, blob2 AS outcome, SUM(_sample_interval) AS n
          FROM tstodon_metrics
          WHERE index1 = 'outbox.job' AND timestamp > NOW() - INTERVAL '1' DAY
          GROUP BY job, outcome ORDER BY n DESC"
```

More queries (same call):

```sql
-- Cron runs in the last day: expect 24 of "17 * * * *" and 4 of "17 */6 * * *".
SELECT blob1 AS cron, SUM(_sample_interval) AS runs, MAX(timestamp) AS last_run
FROM tstodon_metrics WHERE index1 = 'cron' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY cron

-- Paged jobs: passes, failures and p95 time per job over a week.
SELECT blob1 AS job, blob2 AS outcome, SUM(_sample_interval) AS passes,
       quantileWeighted(0.95, double2, _sample_interval) AS p95_ms
FROM tstodon_metrics WHERE index1 = 'outbox.job.page' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY job, outcome ORDER BY passes DESC

-- Outgoing activities per hour.
SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob1 AS activity,
       SUM(_sample_interval) AS n
FROM tstodon_metrics WHERE index1 = 'outbox.enqueue' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY hour, activity ORDER BY hour

-- Delivery attempts by outcome and host over a day (failing hosts first).
SELECT blob2 AS host, blob1 AS outcome, SUM(_sample_interval) AS attempts,
       quantileWeighted(0.95, double1, _sample_interval) AS p95_ms
FROM tstodon_metrics WHERE index1 = 'outbox.deliver' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY host, outcome ORDER BY attempts DESC LIMIT 50

-- Web Push responses by status.
SELECT blob1 AS status, SUM(_sample_interval) AS n
FROM tstodon_metrics WHERE index1 = 'push.deliver' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY status ORDER BY n DESC

-- Timeline latency.
SELECT index1, quantileWeighted(0.5, double1, _sample_interval) AS p50_ms,
       quantileWeighted(0.95, double1, _sample_interval) AS p95_ms, SUM(_sample_interval) AS requests
FROM tstodon_metrics WHERE index1 LIKE 'timeline.%' AND blob1 = 'ok' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY index1
```

Analytics Engine keeps data for three months and samples at high volume (weight by `_sample_interval`); a Worker invocation can write a limited number of data points (250 at the time of writing) **(verify)**, which a large fan-out batch (`stream.render`, one point per recipient) can exceed, losing points silently.

### Outbound delivery health (D1)

Each activity to each remote inbox is a row in `outbox_deliveries` (`inbox_url` set; fan-out rows have `inbox_url` NULL and `kind` `Expanded` or `Delivered`). `kind` is `Queued`, `Delivered`, `Failed` or `Skipped`:

- `Failed` / `Permanent` (with `http_status`): the remote answered a 4xx other than 401, 408 and 429, or a 501 (Mastodon's `response_error_unsalvageable?`), or the activity or its signer is gone here.
- `Failed` / `RetryExhausted` (with `attempt_count`): 17 attempts failed, or the hourly sweep found the target stuck for over 10 days.
- `Skipped` / `DomainUnavailable`: the inbox's domain was marked unavailable (below), so nothing was sent.
- `Queued` with `next_attempt_at`: waiting for its next attempt.

The Workflow attempts a delivery up to 17 times (Mastodon's 16 retries), sleeping Sidekiq's backoff between attempts: `count⁴ + 15 + rand(10) × (count + 1)` seconds, from 15 seconds up to about 14 hours, about 2.1 days in all (`OutboxDelivery` in `packages/domain/src/outbox-delivery.ts`). A 429 or 503 with a `Retry-After` waits at least that long, at most 12 hours. 5xx, 401, 408, 429 and no answer at all are retried.

```sh
# State of the last day's deliveries.
wrangler d1 execute tstodon --remote --command \
  "SELECT kind, reason_kind, COUNT(*) AS n FROM outbox_deliveries
   WHERE inbox_url IS NOT NULL AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
   GROUP BY kind, reason_kind"

# Failing hosts (assumes https:// inbox URLs).
wrangler d1 execute tstodon --remote --command \
  "SELECT substr(inbox_url, 9, instr(substr(inbox_url, 9), '/') - 1) AS host, kind, reason_kind, http_status, COUNT(*) AS n
   FROM outbox_deliveries
   WHERE inbox_url IS NOT NULL AND kind <> 'Delivered' AND updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
   GROUP BY host, kind, reason_kind, http_status ORDER BY n DESC LIMIT 30"

# Domains deliveries are failing to, and the ones marked unavailable.
wrangler d1 execute tstodon --remote --command \
  "SELECT domain, kind, failure_days, last_failure_day, unavailable_since FROM delivery_domain_health ORDER BY kind DESC, failure_days DESC"

# Targets overdue for their next attempt (what the hourly sweep picks up).
wrangler d1 execute tstodon --remote --command \
  "SELECT COUNT(*) AS overdue FROM outbox_deliveries
   WHERE kind = 'Queued' AND inbox_url IS NOT NULL
     AND COALESCE(next_attempt_at, updated_at) < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')"
```

The first two scan the table (there is no index on `updated_at`), so they cost rows read in proportion to its size; run them when investigating, not from a one-minute monitor. The last two are small: `delivery_domain_health` holds only failing domains, and the overdue count uses `idx_outbox_deliveries_due`.

**Domain health.** `delivery_domain_health` counts, per domain, the distinct UTC days on which a delivery attempt failed (an HTTP failure or no answer; this server's own failures do not count). On the seventh such day with no success between, the domain is `Unavailable` (`DeliveryDomainUnavailable`): fan-out and targeted sends record its inboxes as `Skipped`, and Workflows still retrying for it stop at their next attempt. Any answer from the domain (a success, or a permanent refusal), any verified inbound activity from it, or "Mark as available" on `/admin/instances/<domain>` deletes the row (`DeliveryDomainAvailable`). Deliveries and the inbox check an isolate copy of the table, read again each minute, so for up to a minute after a change another isolate can still send to a domain just marked unavailable, or not yet clear one just marked failing. Fan-out reads the unavailable list from D1 for each activity.

**Stuck deliveries.** Every hour the cron sweeps up to 50 `Queued` targets whose next attempt is over an hour late (`sweepStuckDeliveries`): a target whose Workflow was never created (`OutboxWorkflowCreateFailed`) gets one, an `errored`, `terminated` or `complete` instance is restarted from its first step (the row's attempt count carries over), a running or sleeping one is left for another hour, and a target over 10 days old is given up (`OutboxDeliveryGivenUp`, `Stuck`). Each run writes an `outbox.sweep` point.

Workflow instances (instance id `outbox-<hash>`):

```sh
wrangler workflows instances list tstodon-outbox-delivery --status errored
wrangler workflows instances list tstodon-outbox-delivery --status running --per-page 50
wrangler workflows instances describe tstodon-outbox-delivery <instance-id>
```

A delivery that ends `Failed` or `Skipped` completes normally (status `complete`, with the final state as output). `errored` means a step threw after its retries (D1 steps retry 3 times; the POST step never, and times out after 2 minutes); the sweep restarts such an instance within about two hours.

### Queue health

- **Dashboard**: Queues → `tstodon-outbox-process` → Metrics: backlog (messages and bytes), consumer concurrency, message operations. `wrangler queues info tstodon-outbox-process` shows the producers and consumer.
- **Consumer settings** come from `packages/worker/app/queues/tstodon-outbox-process.ts`: batches of 10, `max_retries` 3, `max_concurrency` 1. One consumer works through the backlog serially; a backlog that only grows means jobs arrive faster than one invocation clears them.
- **No dead-letter queue** is configured (OPS-1). A job the handler gives up on is acked (`OutboxJobDropped`); a message that throws or never parses is discarded by Queues after `max_retries`. Message retention in the queue is limited (4 days by default **(verify)**), so a consumer that is detached or failing for longer loses messages.
- **Consumer errors** are queue invocations with outcome `exception` in Workers Logs (`wrangler tail tstodon --status error`).

### Cron health

Two schedules, both at minute 17 (`packages/worker/app/crons/outbox-maintenance.ts`): hourly (`17 * * * *`) and six-hourly (`17 */6 * * *`). The handler only queues jobs (polls, link cards, tag backfills, media rekey, scheduled posts, post clean-up; the six-hourly one also media vacuum, metadata strip and size backfills) and refreshes stale remote actors directly on the hourly run. It writes the `cron` metric only when every send succeeded. Check:

- the `cron` query above (a missing hour is a failed run);
- dashboard: Workers & Pages → `tstodon` → Settings → Triggers (Cron Triggers) and its past events **(verify path)**;
- scheduled invocations with errors in Workers Logs.

### D1

- **Size**: `wrangler d1 info tstodon` (database size, tables). The per-database limit is 10 GB on Workers Paid and 500 MB on Free **(verify)**; writes fail once it is reached.
- **Queries**: `wrangler d1 insights tstodon --sort-by reads --time-period 7d --limit 10` (also `--sort-by time`, `writes`), and the D1 dashboard (rows read / written, query duration). A single query is cut off after 30 seconds **(verify)**.
- **Growth**: `outbound_activities`, `outbox_deliveries` and `inbox_activities` grow with every post, delivery and received activity and are never pruned (OPS-3). Watch their row counts:

  ```sh
  wrangler d1 execute tstodon --remote --command \
    "SELECT (SELECT COUNT(*) FROM outbound_activities) AS outbound, (SELECT COUNT(*) FROM outbox_deliveries) AS deliveries,
            (SELECT COUNT(*) FROM inbox_activities) AS inbox, (SELECT COUNT(*) FROM statuses) AS statuses"
  ```

### Durable Objects, R2, Images

- **Rate limiter** (`RateLimitCounter`): every counted request is one Durable Object call (one per subject, usually one per request). Dashboard: Workers & Pages → Durable Objects → `RateLimitCounter` (requests, errors, duration). Errors here mean limits fail open (`rate limit counter unavailable`).
- **StreamHub**: requests and errors in the same view; errors match the `*NotPublished` events.
- **R2**: `wrangler r2 bucket info tstodon-media` (object count, size) and the R2 dashboard (storage, Class A / Class B operations). Media served from the R2 custom domain hits the edge cache, so Class B reads stay low unless caching is off. What D1 accounts for:

  ```sh
  wrangler d1 execute tstodon --remote --command \
    "SELECT (SELECT SUM(COALESCE(file_size,0) + COALESCE(preview_file_size,0)) FROM media_attachments) AS attachments,
            (SELECT SUM(COALESCE(avatar_file_size,0) + COALESCE(header_file_size,0)) FROM account_profiles) AS profiles,
            (SELECT SUM(COALESCE(image_file_size,0)) FROM custom_emojis) AS emojis"
  ```

  A bucket much larger than this sum means orphans (`MediaObjectsNotDeleted`, rekey copies kept while `MEDIA_REKEY_DELETE_LEGACY` is off).

- **Images**: transformations used by uploads (dimensions, preview, blurhash). `MediaImageNotProcessed` bursts mean the binding is failing or over quota.

### Uptime checks

- `GET /healthz` answers `{"kind":"Ok","service":"tstodon"}` without touching D1: it proves the Worker runs. It is under the Access-protected `/`, so add it to the bypass list if an external monitor checks it.
- `GET /api/v1/instance` (bypassed with `/api/*`) reads D1 (`COUNT` over accounts and statuses), so it also proves the database answers; it costs rows read per call, so poll it every few minutes, not every few seconds.
- `GET /.well-known/webfinger?resource=acct:<user>@<domain>` checks the federation path through Access.

### Suggested alerts

Starting points; tune them to your traffic. Cloudflare Notifications covers some of these (which Workers, Queues and D1 alert types your plan offers varies **(verify)**); the rest need a small job that runs the queries above on a schedule.

| Signal                                                         | Threshold to start with                                   |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| Uptime check on `/healthz` or `/api/v1/instance`               | 3 consecutive failures                                    |
| Worker invocations with outcome `exception`                    | > 1% of requests over 10 minutes                          |
| `cron` metric                                                  | No point for 2 hours                                      |
| `outbox.job` `failed` or `OutboxJobDropped`                    | Any, per job kind, per hour                               |
| `OutboxEnqueue*Failed`, `OutboxWorkflowCreateFailed`           | Any                                                       |
| `DeliveryDomainUnavailable`, `outbox.domain` `unavailable`     | Any (a federated server is now skipped)                   |
| `outbox.sweep` `created` + `restarted`                         | > 0 for 3 hours in a row (Workflows failing)              |
| `*NotFederated` / `*NotQueued` events                          | > 10 per hour                                             |
| Queue backlog                                                  | > 1,000 messages for 30 minutes, or growing for 1 hour    |
| `OutboxDeliveryGivenUp` to one host                            | > 50 per hour (a remote is down; see playbook)            |
| `push.deliver` 401 / 403                                       | > 5% of pushes                                            |
| `rate limit counter unavailable`                               | Any sustained (> 10 per 5 minutes)                        |
| D1 size                                                        | > 70% of the plan limit                                   |
| R2 storage                                                     | Growth beyond what you budgeted per week                  |
| 429 responses on `/inbox` (Workers Logs or Security analytics) | A sudden jump, or one large remote throttled continuously |

## Common incidents

### A remote server is down, or delivery is backing up

1. Find the hosts with the [failing-host query](#outbound-delivery-health-d1) or the `outbox.deliver` query by host. Transient failures (5xx, 401, 408, 429, network) are retried for about 2.1 days (17 attempts), then the delivery is `RetryExhausted` and logged `OutboxDeliveryGivenUp`.
2. If one remote is down, there is nothing to do on this side: deliveries wait and retry. After failures on 7 distinct days it is marked unavailable and new deliveries to it are skipped; see the next playbook. Posts made during an outage longer than the retry window never reach it; when it is back, its users see new posts again, and old ones are fetched only when someone opens them.
3. If the queue backlog grows, check the consumer is attached (`wrangler queues info tstodon-outbox-process`; Terraform's `attach_queue_consumer`), look for queue invocation exceptions, and read `outbox.job.page` p95 by job. `max_concurrency` is 1 by design (set in the queue file and in Terraform's `queue_consumer_max_concurrency`; keep them equal).
4. If target rows stay `Queued` past their `next_attempt_at`, the hourly sweep starts or restarts their Workflows (`outbox.sweep`). If the overdue count keeps growing, list errored instances and read the failing step; check Workflows status and limits in the dashboard.

### A remote domain is marked unavailable

<!-- derived-from #outbound-delivery-health-d1 -->

`DeliveryDomainUnavailable` (or the domain under "Delivery failures" on `/admin/instances`) means deliveries to it failed on 7 distinct days with no success between, as Mastodon's `UnavailableDomain`. New deliveries to it are recorded `Skipped` / `DomainUnavailable`.

1. Check whether it is really gone: `curl -sI https://<domain>/.well-known/nodeinfo` from outside Cloudflare. A domain that is gone for good can stay marked; it costs nothing but its row.
2. It clears by itself when the domain sends a verified activity to any inbox here (or answers a delivery), as Mastodon's `track_inverse_success!`.
3. If it is back but quiet, open `/admin/instances/<domain>` and press "Mark as available" (`DeliveryDomainAvailable`, `via: admin`). Deliveries resume with the next activity; ones skipped meanwhile are not resent. Other isolates may skip it for up to a minute more.
4. To stop delivering to a domain on purpose, block it (severity `suspend`) instead; the unavailable mark is not a moderation tool.

### Inbox flood

1. Identify the source: Workers Logs filtered on path `/inbox`, `/actor/inbox` or `/users/*/inbox` by client IP and status; Security → Analytics for the zone.
2. The Worker already throttles: `inbox_ip` (1500 per 5 minutes per address, before the body is read) and `inbox_domain` (3000 per 5 minutes per verified sending server). Tighten with `RATE_LIMITS`, for example `{"inbox_domain": {"limit": 600, "period": 300}}`, in `wrangler.jsonc` vars, and deploy.
3. One bad server: a domain block with severity `suspend` (`/admin/instances`, or `POST /api/v1/admin/domain_blocks`) refuses its deliveries after signature verification.
4. An address range: an IP block with `no_access` (`POST /api/v1/admin/ip_blocks`, `ip=203.0.113.0/24`, `severity=no_access`, optional `expires_in`). It refuses every request from the range before routing, within a minute in every isolate. Do not block the address you administer from: the admin API is refused too (remove such a block with `wrangler d1 execute tstodon --remote --command "DELETE FROM ip_blocks WHERE ip = '203.0.113.0/24'"`).
5. Volumetric: the [WAF rate-limiting rule](./cloudflare-deploy.md#rate-limiting-at-the-edge) drops it before the Worker runs. Add a WAF custom rule (Block) on the attacking ASN or addresses if needed. Never use a challenge on federation or API paths.

### Spam account wave

1. Access is the first gate: tighten the Access application's policy (allowed email domains, an identity provider with its own sign-up controls) to stop new sign-ins entirely.
2. Close or gate registrations: `REGISTRATIONS_OPEN=false` (new Access emails get no account) or `REGISTRATION_APPROVAL=true` (new accounts wait in `/admin/accounts` as pending). Change them in `wrangler.jsonc` and deploy.
3. Block where they come from: IP blocks with `sign_up_block` or `sign_up_requires_approval`; email domain blocks (`/admin/email_domain_blocks`, `POST /api/v1/admin/email_domain_blocks`); canonical email blocks for one mailbox and its respellings (`/api/v1/admin/canonical_email_blocks`).
4. Remove the accounts: suspend on `/admin/accounts/:id`, or `POST /api/v1/admin/accounts/:id/action` with `type=suspend` (token with `admin:write`). Recent sign-ups:

   ```sh
   wrangler d1 execute tstodon --remote --command \
     "SELECT id, username, access_email, created_at FROM accounts ORDER BY created_at DESC LIMIT 50"
   ```

   `/admin/accounts` filters by IP (`account_ips`) to find accounts from one address.

### D1 near its limits

- **Size**: see the growth query. The tables that grow without bound are `outbound_activities`, `outbox_deliveries` and `inbox_activities` (OPS-3). There is no supported prune yet; do not delete from them by hand without checking which reads still use them (`prisma/sql/*.sql`, `packages/worker/server/*-store.ts`), for example `Undo` lookups of a past `Follow`.
- **Slow or expensive queries**: `wrangler d1 insights` by reads and time; compare with `timeline.*` and `outbox.job.page` p95. The [heavy D1 scenarios](../architecture/d1-heavy-scenarios.md) document lists the known heavy paths and what has been measured.
- **Overload** shows as `RepositoryError` 500s on the API and `retry` clusters in `outbox.job.page`. Throttle the source (rate limits) before anything else.

### Media bucket growth

1. Compare `wrangler r2 bucket info tstodon-media` with the D1 size sum above.
2. Unattached uploads are deleted after a day by `VacuumMediaAttachments` (six-hourly); check its `outbox.job.page` points.
3. While `MEDIA_REKEY_DELETE_LEGACY` is off, every rekeyed attachment exists twice (see [Moving attachments off id-derived keys](./cloudflare-deploy.md#moving-attachments-off-id-derived-keys)). Turning it on halves those.
4. `MediaObjectsNotDeleted` lines name failed deletes; the objects stay until removed by hand.
5. Per-account usage is on the admin dashboard (`space_usage`) once sizes are recorded (`BackfillStoredMediaSizes`).

### Access misconfiguration or admin lockout

Symptoms and fixes:

- **Everyone is signed out, Access login loops**: the JWT does not verify. Compare `CF_ACCESS_AUD` with the application's Audience (AUD) tag (Zero Trust → Access → Applications → the app → Overview) and `CF_ACCESS_TEAM_DOMAIN` with `https://<team>.cloudflareaccess.com`. A recreated application has a new AUD. API clients with tokens keep working, and so does `wrangler d1 execute`, which needs no Access.
- **Federation broke after an Access change**: a federation path lost its bypass. `curl -si https://<domain>/.well-known/webfinger?resource=acct:<user>@<domain>` must answer JSON, not a redirect to `cloudflareaccess.com`. Check every bypass path of the [deploy checklist](./cloudflare-deploy.md) step 4.
- **Admin role gone**: with `CF_ACCESS_ADMIN_GROUPS` set, every login sets or clears admin from the JWT's groups, so a renamed group or a changed identity provider demotes everyone. Fix the group names, or empty the var, then promote by hand:

  ```sh
  wrangler d1 execute tstodon --remote --command \
    "UPDATE \"user\" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = 'alice')"
  ```

- **Identity provider down**: add Access's One-time PIN login method to the application in Zero Trust as a break-glass login; the Access email must still equal the account's `access_email` exactly, or a second account is created (or none, with registrations closed).

### Key compromise and secret rotation

- **`BETTER_AUTH_SECRET`**: `openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET`. Better Auth signs its session cookie with it, so existing browser cookies stop verifying; the next request that carries a valid Access JWT signs the person in again with a new session. Mastodon app tokens are unaffected (they are digests, not signed). The web app token is derived from the session row, not from this secret, so to end every browser session for certain, also delete the sessions; their web tokens go with them (`oauth_access_tokens.web_session_id` is `ON DELETE CASCADE`):

  ```sh
  wrangler d1 execute tstodon --remote --command "DELETE FROM \"session\""
  ```

  Check the result on a staging instance first if you can; Access-signed-in users then get a new session on their next page load.

- **`VAPID_PRIVATE_JWK`**: rotating it invalidates every push subscription (the push services reject the new key for subscriptions made with the old one). Generate and put a new key (see [Web Push](../reference/configuration.md#web-push)); clients must subscribe again, which the web app does when it next registers push; native apps vary. Expect `push.deliver` 401/403 until the old subscriptions are replaced (only 404 and 410 delete a subscription).
- **Access**: rotate the identity provider's credentials in Zero Trust; revoke sessions there (Zero Trust → My Team → Users → revoke, **verify path**). A new Access application means a new `CF_ACCESS_AUD`.
- **Cloudflare API token leaked**: roll it in the dashboard, then update CI. Check the audit log (Manage Account → Audit Log) for what it did.
- **Actor private keys** (a D1 export leaked): there is no key rotation in tstodon (OPS-8), and remote servers cache public keys. Treat it as a full compromise: secure the backups, rotate everything above, and consider the instance's signatures forgeable until keys can be rotated. An OAuth token leak is contained by revoking the token (`/auth/edit` authorized apps, or delete its row).

### Rolling back a bad deploy

1. See what is live and what came before:

   ```sh
   wrangler deployments list
   wrangler versions list
   ```

2. Roll the Worker back: `wrangler rollback <version-id> -m "reason"`. This restores the code and its configuration from that version. It does not touch D1 data, R2, KV, or the queue's contents, and Cloudflare refuses some rollbacks across Durable Object migrations **(verify)** (this Worker's DO migrations are tags `v1` and `v2`).
3. **D1 migrations are forward-only.** `pnpm run deploy` applied the new version's migrations before uploading it, so the old code now runs on the new schema. Most migrations are additive and the old code works; a table rebuild or a dropped column can break it. Options, in order of preference:
   - fix forward: revert the code change on `main`, keep the migration, deploy;
   - if the migration damaged data, [restore D1 with Time Travel](#d1-time-travel-point-in-time-restore) to just before the deploy, then deploy the version that matches that schema.
4. Do not edit an applied migration file; Void's deploy gate compares the migrations with what wrangler would apply.

### Running the media backfills

The three media backfills run from the crons and need no starting; each is idempotent and safe to start again:

| Job                        | Started by      | Progress and done                                                |
| -------------------------- | --------------- | ---------------------------------------------------------------- |
| `RekeyLegacyMedia`         | hourly cron     | `LegacyMediaNotRekeyed`; the count query in the deploy checklist |
| `StripStoredMediaMetadata` | six-hourly cron | `MediaMetadataNotStripped`, `MediaMetadataBackfillDone`          |
| `BackfillStoredMediaSizes` | six-hourly cron | `MediaSizeNotRead`, `MediaSizeBackfillDone`                      |

The steps, queries and cache purges are in the deploy checklist: [Moving attachments off id-derived keys](./cloudflare-deploy.md#moving-attachments-off-id-derived-keys), [Stripping metadata from stored media](./cloudflare-deploy.md#stripping-metadata-from-stored-media) and [Recording stored media sizes](./cloudflare-deploy.md#recording-stored-media-sizes). To start one at once, send its message to the queue with the Queues REST API as shown there.

## Upgrades

### Deploying a new version

<!-- constrained-by ./cloudflare-deploy.md -->

1. Read the commits since the last deploy for new migrations (`packages/worker/app/db/migrations/`), new vars or bindings (`docs/reference/configuration.md`), and deploy notes in the [deploy checklist](./cloudflare-deploy.md) (backfills, flags).
2. Note the current bookmark (`wrangler d1 time-travel info tstodon`) and version (`wrangler deployments list`), so you know what to return to.
3. `pnpm run ci`, then `pnpm run deploy`. Void validates the bindings and the migrations, applies pending migrations to remote D1, verifies none remain, then runs `wrangler deploy`, which also uploads the cron triggers and the queue consumer settings.
4. If Terraform manages the queue consumer, keep `queue_consumer_max_concurrency` equal to `maxConcurrency` in `packages/worker/app/queues/tstodon-outbox-process.ts`; both write the same setting.
5. Watch for 30 minutes: exceptions in Workers Logs, `OutboxJobRejected` (producer and consumer disagree on a job shape; it settles once the new version is everywhere), `outbox.enqueue` volume, the next cron run.

### A newer Mastodon web UI

The web UI is vendored; moving to a newer Mastodon release is [Updating the vendored Mastodon web UI](./mastodon-web-upstream.md). It ships with the next deploy like any other change.
