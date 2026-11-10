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
  The admin API (`/api/v1/admin/*`, `REST::Admin::*`) is `src/admin.ts`:
  `ApiAdminAccount` (the public account nested as `account`, as Mastodon),
  `ApiAdminReport`, `ApiAdminDomainBlock`, `ApiAdminDomainAllow`,
  `ApiAdminEmailDomainBlock`, `ApiAdminCanonicalEmailBlock`, `ApiAdminTag`,
  `ApiAdminIpBlock`, the dashboard's `ApiAdminMeasure`, `ApiAdminDimension`
  and `ApiAdminCohort`, `ApiAdminPreviewCardProvider` (a trending link's
  publisher), and tstodon's own `ApiAdminAnnouncement` and
  `ApiAdminCustomEmoji`. Their enum-like values (`IP_BLOCK_SEVERITIES`,
  `ADMIN_MEASURE_KEYS`, `ADMIN_DIMENSION_KEYS`,
  `ADMIN_RETENTION_FREQUENCIES`) are in `@tstodon/api/values`.
- Request params (`src/params/`, exported from `@tstodon/api`): what a
  JSON client sends to the endpoints the web UI's TypeScript wrappers call,
  under Mastodon's names (`ApiCreateListParamsSchema` /
  `ApiCreateListParams`, `ApiUpdateCredentialsParams`, `ApiSearchParams`,
  `ApiPaginationParams`, ...). The type is the schema's input
  (`z.input`), which the UI uses; the Worker parses with the schema. The
  schemas are the JSON shape only (booleans, numbers, arrays): the Worker
  folds a form or query string into that shape first
  (`packages/worker/server/request-params.ts`). Where the Worker reads an
  enum-like value leniently (a notification policy's `for_*`, the
  directory's `order`, a search `type`, a boost's `visibility`) the field is
  a string, so an unknown value keeps the answer it had instead of becoming
  a parse error.
- `@tstodon/api/values` (`src/values.ts`): the enum-like strings (status
  visibilities, quote policies and states, notification types, filter
  contexts, ...) as constant arrays with their types and guards. It imports
  nothing, so the browser can import a value from it without bundling Zod.
  The schemas build their `z.literal` unions from these arrays.

- `@tstodon/api/activitypub` (`src/activitypub/`): the ActivityPub documents
  tstodon sends and serves, as Mastodon's `ActivityPub::*Serializer`s shape
  them: `ApActorDocument` / `ApActor` (an actor `Update`'s object),
  `ApInstanceActorDocument`, `ApStatusDocument` (`ApNote` / `ApQuestion`),
  `ApPollVote`, `ApTombstone`, `ApQuoteAuthorizationDocument`, each activity
  (`ApCreate`, `ApUpdate`, `ApDelete`, `ApAnnounce`, `ApLike`, `ApFollow`,
  `ApAccept`, `ApReject`, `ApUndo`, `ApBlock`, `ApMove`, `ApFlag`,
  `ApQuoteRequest`) and `ApActivityDocument` (any of them with its
  `@context`, what the delivery queue takes), `ApActorCollection` and
  `ApOutbox`, `WebFingerJrd`, `NodeInfoDiscovery` and `NodeInfo20`, plus the
  constants `ACTIVITY_STREAMS`, `PUBLIC_COLLECTION` and `SECURITY_V1`. These
  describe tstodon's output only: what other servers send is read leniently
  in the Worker (`server/activitypub-wire.ts`). A schema with `@context` is
  a top-level document; the same schema without it is the embedded form.
  It is a separate entry so neither side pulls the other in; the web UI does
  not import it.

From the web UI, import types with `import type` / `export type` (erased at
build time) and values only from `@tstodon/api/values`.

## Who parses with these

The Worker builds its documents to these types and does not parse its own
answers; the tests do (`expectContract` in
`packages/worker/test/api-contract.ts`). The exception is data the Worker
stored in a wire shape: a local status's replaced revisions
(`status_edits.snapshot_json`) are parsed at the D1 boundary with
`StatusEditSnapshot`, built from `ApiStatusEdit`.

## Who parses the params

The Worker's handlers read requests with `readParams` / `readOptionalParams`
(body), `readQueryParams` (query) and `readMergedParams` (both, the body
winning, as Rails' `params`), all in `packages/worker/server/request-params.ts`:
`key[]` folds into `key`, a body's `a[b]` keys nest, and each field is cast
to the type its schema declares (`true` / `1` are true, anything else false;
a number that does not parse is left out; a single value of an array field
is a one-item list). `server/api-params-contract.test.ts` sends each covered
endpoint its JSON body and the form or query equivalent.

## No `kind` here

The repository's Zod rule (discriminator `kind`, see `AGENTS.md`) is for
domain models in `packages/domain`. This package mirrors Mastodon's wire
format instead: no `kind` property, enum-like strings as `z.literal([...])`
unions over the arrays in `values.ts`, and discriminated unions only on
Mastodon's own fields (`type` for media attachments and notifications,
`state` for quotes, and ActivityStreams' `type` for the ActivityPub
documents).

## Changing a shape

Change the schema, then let the compiler find the server builders and UI
code that disagree. When moving the web UI to a newer upstream release,
apply upstream's `app/javascript/mastodon/api_types` changes here (see
`packages/worker/src/UPSTREAM.md`).
