# ADR: Variable timeline SQL stays on `db.prepare`

<!-- constrained-by ./d1-writes.md -->
<!-- constrained-by ./prisma-typedsql.md -->

## Status

Accepted

## Context

Prisma TypedSQL wants a fixed SQL string per query file. Timeline and search helpers in `status-store` / `list-store` change shape with optional `maxId`, reply-policy branches, LIKE patterns, and context walks. Encoding every branch as a separate `.sql` file multiplies surface area without reducing bind-count risk.

Variable-length `IN (?,?,…)` lists are already forbidden (cfwdon / `sqlInJsonEach`). That constraint is orthogonal to optional-clause SQL.

## Decision

Keep **shape-varying** timeline / search / context SQL on `db.prepare` with fixed bind positions per branch.

Do **not** build growing placeholder lists. Membership filters use `sqlInJsonEach()` + `jsonStringArray()`.

Prefer TypedSQL for fixed-arity statements (CRUD, simple lists, json_each membership).

## Consequences

- Timeline SQL remains hand-written next to the store helpers.
- New optional filters should add an explicit SQL branch (or TypedSQL file), not string-concatenate extra `?` for ID lists.
- Completeness of “all SQL in prisma/sql” is deferred; completeness of “no growing IN binds” is required.
