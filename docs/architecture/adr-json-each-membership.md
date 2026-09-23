# ADR: Variable-length membership uses `json_each` (never growing `IN`)

<!-- constrained-by ./d1-writes.md -->
<!-- derived-from ./adr-variable-timeline-sql.md -->

## Status

Accepted

## Context

Cloudflare D1 (SQLite) rejects a statement with more than **100** bound parameters. Building `IN (?,?,…)` with one placeholder per id makes bind count scale with list length. In cfwdon this produced opaque Worker 500s once list sizes (for example trending / hydrate batches) exceeded the ceiling.

Fixed-arity padding (`IN` with 50 slots and sentinels) keeps SQL text stable but still wastes bind budget and is awkward with TypedSQL. Temporary tables are heavier than needed for read-side membership.

SQLite’s `json_each(?)` turns one JSON text array bind into a virtual table of values, so membership stays **O(1)** binds for any list size.

## Decision

For variable-length membership filters, always use:

```ts
`WHERE id ${sqlInJsonEach()}` // IN (SELECT value FROM json_each(?))
  .bind(jsonStringArray(ids));
```

Helpers live in `packages/worker/src/d1.ts` (`sqlInJsonEach`, `jsonStringArray`, `D1_MAX_BOUND_PARAMETERS`).

Do **not** concatenate growing `?` lists for id/username/status sets.

Fixed, known-small lists with N ≤ 100 may use ordinary `IN (?,…)` only when N is a compile-time constant (not “chunk until it fits”).

## Alternatives considered

| Alternative                               | Why rejected                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Growing `IN (?,?,…)` + chunking at 50/100 | Still easy to regress; chunks multiply round-trips; cfwdon already burned here |
| Fixed 50/100-arg padded `IN`              | TypedSQL-friendly but bind-heavy and sentinel-sensitive                        |
| Temp table + `INSERT` then `JOIN`         | Correct but more statements and lifecycle noise for simple reads               |

## Consequences

- Preload helpers (`findAccountsByIds`, interaction counts, hydrate media, …) bind one JSON array (plus any other fixed params).
- Regression coverage: `packages/worker/src/d1-sql.test.ts` asserts a 200-id list still uses a single `?`.
- Reviewers should reject PRs that reintroduce placeholder maps for membership.
