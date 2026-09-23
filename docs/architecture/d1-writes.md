# D1 write conventions

<!-- constrained-by ./tstodon-architecture.md#cloudflare-mapping -->
<!-- constrained-by ../planning/local-core.md#quality-bar -->

## Rules

1. Multi-statement writes go through `runD1Batch` / `runD1BatchChunked` (`packages/worker/src/d1.ts`), not sequential `await stmt.run()` loops.
2. Prefer a single UPSERT / `INSERT OR IGNORE` / conditional `UPDATE ... WHERE` over SELECT-then-INSERT when app logic allows. D1 has no interactive `BEGIN`/`COMMIT`.
3. Do not use `Promise.all` of separate D1 writes on the same database as a substitute for `batch`. D1 serializes writers; batch is one round-trip and one SQL transaction.
4. Chunk large homogeneous batches with `D1_BATCH_CHUNK_SIZE` (100). Keep per-statement bind counts under the platform limit (100).
5. Keep side effects (notifications, stream publish, outbound HTTP) outside the D1 batch. Batch only SQL statements whose failure should share one fate.

## When batch helps

- INSERT parent row + N child rows (status + media links, mentions, list members).
- Paired writes that must succeed together (outbound activity + delivery row, poll + `statuses.poll_id`).
- Independent SELECTs that today run back-to-back (optional; prefer one SQL with `IN` when shapes allow).

## Timeline / status document reads

`mastodonStatuses` preloads a page of related rows (`findAccountsByIds`, `accountCountsByIds`, `statusInteractionCountsByIds`, `findPollsByStatusIds`, `findMediaByIds`, `findStatusesByIds`) instead of calling `mastodonStatus` once per item. Use `db.batch` when several aggregate shapes are needed for the same id set.

## Variable-length `IN` lists

D1 rejects statements with more than **100** bound parameters. Do **not** build growing `IN (?,?,…)` lists (cfwdon hit this when N > 100 and returned opaque 500s).

Use the cfwdon pattern from `packages/worker/src/d1.ts`:

```ts
`WHERE id ${sqlInJsonEach()}` // → IN (SELECT value FROM json_each(?))
  .bind(jsonStringArray(ids)); // one bind, any list size
```

`sql_placeholders`-style fixed lists are fine only when N is known and ≤ 100.

Shape-varying timeline / search SQL stays on `db.prepare` by design: [adr-variable-timeline-sql.md](./adr-variable-timeline-sql.md).

## TypedSQL

Single-statement SQL is moving to Prisma TypedSQL. See [prisma-typedsql.md](./prisma-typedsql.md).

## When a single statement is better

- Existence check + insert → `INSERT OR IGNORE` / `ON CONFLICT` and inspect `meta.changes`.
- “Update only if not expired” → `UPDATE ... WHERE expires_at > ?` and treat zero changes as the business error.
