# ADR: TypedSQL is codegen-only; execute through D1 helpers

<!-- constrained-by ./prisma-typedsql.md -->
<!-- constrained-by ./d1-writes.md -->
<!-- constrained-by ./adr-json-each-membership.md -->

## Status

Accepted

## Context

Prisma TypedSQL generates typed factories from `prisma/sql/*.sql`. The natural Prisma path is `new PrismaClient({ adapter: new PrismaD1(env.DB) })` then `$queryRawTyped(...)`.

On D1 that path is a poor default:

1. Generated SQLite TypedSQL uses `$1`-style placeholders; D1 `prepare` expects positional `?`. The adapter’s bind behavior is easy to get wrong and already caused RepositoryError 500s in tests.
2. Shipping a runtime `PrismaClient` (WASM edge runtime) ballooned the Worker bundle (~5 MB upload) for little benefit when we only need typed SQL strings.
3. Prisma’s D1 adapter does not provide real multi-statement transactions; our write batches must stay on `env.DB.batch`.

## Decision

- **Generate** with Prisma (`pnpm prisma:generate` → `packages/worker/src/generated/prisma`).
- **Execute** only via `queryTyped` / `runTyped` / `d1PrepareTyped` in `packages/worker/src/typed-sql.ts`, which rewrite `$N` → `?` and call D1.
- Do **not** construct `PrismaClient` / `@prisma/adapter-d1` on the request path.
- Do **not** use Prisma model CRUD (`findMany`, `create`, …) for domain persistence.

Fixed-arity SQL belongs in `prisma/sql/*.sql`. Shape-varying timeline SQL stays on `db.prepare` ([adr-variable-timeline-sql.md](./adr-variable-timeline-sql.md)). Batches use `d1PrepareTyped` + `runD1Batch`.

## Alternatives considered

| Alternative                               | Why rejected                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Runtime `PrismaClient` + `$queryRawTyped` | Placeholder / adapter footguns; large bundle                             |
| ORM model API for stores                  | Fights branded Zod domain boundary; weak fit for ActivityPub-shaped rows |
| Hand-written SQL only (no TypedSQL)       | Loses generated param/result typing and SQL file review surface          |

## Consequences

- `@prisma/adapter-d1` is not a runtime dependency; `prisma` / `@prisma/client` remain for generate and typed factories.
- Generated `sql/*.ts` still import Prisma’s typed-sql runtime helpers; bundle cost is smaller than a full Client path but non-zero.
- Agents must not “simplify” stores back to `createPrisma(env.DB)`.
