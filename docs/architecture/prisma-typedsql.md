# Prisma TypedSQL conventions

<!-- constrained-by ./d1-writes.md -->
<!-- constrained-by ./tstodon-architecture.md#cloudflare-mapping -->

## Scope

Worker SQL that is a **single statement** should live in `prisma/sql/*.sql` and run via `$queryRawTyped` through `createPrisma(env.DB)`.

Prisma 7.10 TypedSQL helpers are generated from `prisma/sql/*.sql`. At runtime we execute them through D1 via `queryTyped` / `runTyped` / `d1PrepareTyped` in `packages/worker/src/typed-sql.ts`, converting `$1`-style placeholders to `?` (D1 positional bind).

**Do not** use Prisma model CRUD APIs for domain persistence in this initiative.

## Migrations

Wrangler D1 migrations under `migrations/` remain the applied schema history. After changing migrations:

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

## SQLite params

TypedSQL files use `$1`, `$2`, … with `-- @param {String} $1:name` comments (required for SQLite).
