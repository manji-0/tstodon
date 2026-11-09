# @tstodon/api

<!-- constrained-by ../../docs/architecture/tstodon-architecture.md#rest-api-contract -->

Mastodon's REST API entities as they appear on the wire, as Zod 4 schemas with
their inferred types. It is the one definition of the JSON the Worker answers
and the web UI reads:

- the Worker's document builders (`packages/worker/server/*-documents.ts`, the
  instance routes, ...) return these types, and the Worker tests parse API
  responses with these schemas (`packages/worker/test/api-contract.ts`);
- the web UI's `packages/worker/src/mastodon/api_types/*.ts` re-export these
  types under upstream's names (`ApiStatusJSON`, `ApiAccountJSON`, ...).

The shapes follow Mastodon's 4.5–4.7 serializers (`app/serializers/rest/*`).
Where tstodon renders more than Mastodon, the schema says so in a comment
(for example the `move` notification type).

## Modules

- `@tstodon/api` (`src/index.ts`): the schemas (`ApiStatus`, `ApiAccount`,
  `ApiNotificationGroup`, ...) and their types (`ApiStatusJSON`, ...). A
  schema and its type share the stem: `export type ApiStatusJSON = z.infer<typeof ApiStatus>`.
- `@tstodon/api/values` (`src/values.ts`): the enum-like strings (status
  visibilities, quote policies and states, notification types, filter
  contexts, ...) as constant arrays with their types and guards. It imports
  nothing, so the browser can import a value from it without bundling Zod.
  The schemas build their `z.literal` unions from these arrays.

From the web UI, import types with `import type` / `export type` (erased at
build time) and values only from `@tstodon/api/values`.

## No `kind` here

The repository's Zod rule (discriminator `kind`, see `AGENTS.md`) is for
domain models in `packages/domain`. This package mirrors Mastodon's wire
format instead: no `kind` property, enum-like strings as `z.literal([...])`
unions over the arrays in `values.ts`, and discriminated unions only on
Mastodon's own fields (`type` for media attachments and notifications,
`state` for quotes).

## Changing a shape

Change the schema, then let the compiler find the server builders and UI
code that disagree. When moving the web UI to a newer upstream release,
apply upstream's `app/javascript/mastodon/api_types` changes here (see
`packages/worker/src/UPSTREAM.md`).
