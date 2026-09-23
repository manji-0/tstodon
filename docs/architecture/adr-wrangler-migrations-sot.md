# ADR: Wrangler D1 migrations are the schema source of truth

<!-- constrained-by ./tstodon-architecture.md#cloudflare-mapping -->
<!-- constrained-by ./prisma-typedsql.md -->
<!-- constrained-by ./adr-typedsql-d1-execution.md -->

## Status

Accepted

## Context

The Worker already applies ordered SQL under `migrations/` via Wrangler (local, CI vitest pool, remote deploy). Prisma TypedSQL needs a schema for generate/introspect and can also run its own migrate tooling.

Running two appliers against one D1 database splits history (`d1_migrations` vs Prisma migrate tables), invites drift, and fights the existing vitest/miniflare setup that loads Wrangler migrations.

Prisma’s own D1 guidance favors Wrangler apply plus optional `prisma migrate diff` / `db pull`, not Prisma Migrate as the production applier.

## Decision

1. **Author and apply** schema changes only through Wrangler: edit `migrations/*.sql`, then `wrangler d1 migrations apply tstodon --local` / `--remote`.
2. **Refresh Prisma** with `pnpm prisma:pull` (optional) and always `pnpm prisma:generate` after SQL or `prisma/sql` changes.
3. Do **not** use `prisma migrate deploy` / `migrate dev` against this D1 database.
4. Optional later: use `prisma migrate diff` only to **draft** Wrangler migration SQL; still apply via Wrangler.

## Alternatives considered

| Alternative                    | Why rejected                                                     |
| ------------------------------ | ---------------------------------------------------------------- |
| Prisma Migrate as SoT          | Dual history with Wrangler; breaks current test pool assumptions |
| Hand-sync only, no `db pull`   | TypedSQL/schema drift becomes silent                             |
| Abandon Prisma schema entirely | Still useful for TypedSQL typing and table visibility            |

## Consequences

- Reviewers treat `migrations/` as the deployable schema; `prisma/schema.prisma` is derived.
- CI/typecheck relies on committed generated client so clones need not have a local D1 before `tsc` (generate still requires local D1 when editing SQL).
- New tables/indexes land in Wrangler SQL first, then regenerate TypedSQL.
