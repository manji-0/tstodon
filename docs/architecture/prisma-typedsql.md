# Prisma TypedSQL conventions

<!-- constrained-by ./d1-writes.md -->
<!-- constrained-by ./tstodon-architecture.md#cloudflare-mapping -->
<!-- constrained-by ./adr-typedsql-d1-execution.md -->
<!-- constrained-by ./adr-wrangler-migrations-sot.md -->
<!-- constrained-by ./adr-json-each-membership.md -->

## Scope

Worker SQL that is a **single, fixed-shape statement** should live in `prisma/sql/*.sql`.

Prisma generates typed factories under `packages/worker/src/generated/prisma`. At runtime we execute them through D1 via `queryTyped` / `runTyped` / `d1PrepareTyped` in `packages/worker/src/typed-sql.ts` (rewrites `$1`-style placeholders to `?`). There is **no** runtime `PrismaClient` path.

Do **not** use Prisma model CRUD APIs for domain persistence.

Design decisions:

- [adr-typedsql-d1-execution.md](./adr-typedsql-d1-execution.md) — codegen only, D1 execution
- [adr-wrangler-migrations-sot.md](./adr-wrangler-migrations-sot.md) — Wrangler owns applied schema
- [adr-json-each-membership.md](./adr-json-each-membership.md) — variable membership binds
- [adr-variable-timeline-sql.md](./adr-variable-timeline-sql.md) — shape-varying timeline SQL on `prepare`

## Migrations

Wrangler D1 migrations under `migrations/` are the applied schema history. After changing migrations:

```sh
pnpm exec wrangler d1 migrations apply tstodon --local
pnpm prisma:pull    # optional schema refresh
pnpm prisma:generate
```

## Generate

TypedSQL needs a local D1 sqlite file (created by the wrangler apply above). `prisma.config.ts` resolves it from `.wrangler/state/...` or `PRISMA_D1_URL`.

```sh
pnpm prisma:generate   # prisma generate --sql
```

Generated client lives at `packages/worker/src/generated/prisma/` (committed so typecheck works without a local D1).

## Escape hatches

| Case                       | Approach                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Multi-statement writes     | Keep `runD1Batch` / `env.DB.batch` (Prisma D1 adapter does not provide transactional batches) |
| Variable-length membership | `sqlInJsonEach()` + `jsonStringArray()` (O(1) binds; never grow `IN (?,?,…)`)                 |
| Domain branded types       | Parse TypedSQL rows with existing Zod companions                                              |
| Shape-varying timeline SQL | `db.prepare` branches — see [adr-variable-timeline-sql.md](./adr-variable-timeline-sql.md)    |

## SQLite params

TypedSQL files use `$1`, `$2`, … with `-- @param {String} $1:name` comments (required for SQLite).
