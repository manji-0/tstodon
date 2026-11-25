import { schemaResult } from "@tstodon/core";
import { extractEntities } from "@tstodon/core/post-text";
import {
  type InstanceIdentity,
  type LocalNote,
  type OutboxJob,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { localCollectionIdOf } from "./collection-documents";
import type { RepositoryError } from "./d1";
import { queueOutboxJobs } from "./queue-jobs";
import { fetchTaggedCollection, type TaggedCollectionLookup } from "./remote-curated-collection";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusesByIds } from "./status-store";
import {
  addTaggedCollection,
  findKnownCollections,
  replaceTaggedCollections,
  searchableDomains,
  type TaggedCollectionRef,
} from "./tagged-collection-store";

const parseTagList = schemaResult(z.object({ tag: z.unknown().optional() }));
const parseCollectionTag = schemaResult(
  z.object({
    type: z.union([z.string(), z.array(z.unknown())]),
    id: z.string().min(1),
  }),
);

/**
 * The ids of a note's `FeaturedCollection` tags, once each, in the note's
 * order (`Create#process_tags`, `ProcessStatusUpdateService#update_metadata!`):
 * `tag` may be one object, and `type` a list that includes it.
 */
export const noteTaggedCollectionUris = (raw: unknown): ReadonlyArray<string> => {
  const tagged = parseTagList(raw);
  const tag = tagged.isOk() ? tagged.value.tag : undefined;
  const entries: ReadonlyArray<unknown> = Array.isArray(tag) ? tag : [tag];
  return [
    ...new Set(
      entries.flatMap((entry) => {
        const parsed = parseCollectionTag(entry);
        if (parsed.isErr()) {
          return [];
        }
        const { type, id } = parsed.value;
        return (
          typeof type === "string"
            ? type === "FeaturedCollection"
            : type.includes("FeaturedCollection")
        )
          ? [id]
          : [];
      }),
    ),
  ];
};

/** `uri.split('#').first`, as `uri_to_resource` looks a remote object up. */
const withoutFragment = (uri: string): string => uri.split("#")[0] ?? uri;

const isHttpUrl = (uri: string): boolean => /^https?:\/\//i.test(uri);

/**
 * What each of `uris` names that is stored: this server's collection by its
 * URL or URI, or a remote one by its `uri` (`TagManager#uri_to_resource`).
 * `unknown` are the others on another server, in order.
 */
const resolveStored = async (
  db: D1Database,
  identity: InstanceIdentity,
  uris: ReadonlyArray<string>,
): Promise<
  Result<
    Readonly<{ refs: ReadonlyArray<TaggedCollectionRef>; unknown: ReadonlyArray<string> }>,
    RepositoryError
  >
> => {
  const localIds = new Map(
    uris.flatMap((uri) => {
      const id = localCollectionIdOf(identity, uri);
      return id === undefined ? [] : [[uri, id] as const];
    }),
  );
  const ownOrigin = URL.parse(identity.publicOrigin)?.origin;
  const remoteUris = uris.filter((uri) => isHttpUrl(uri) && URL.parse(uri)?.origin !== ownOrigin);
  const known = await findKnownCollections(
    db,
    [...localIds.values()],
    remoteUris.map(withoutFragment),
  );
  if (known.isErr()) {
    return err(known.error);
  }
  const refOf = (uri: string): TaggedCollectionRef | undefined => {
    const localId = localIds.get(uri);
    return localId === undefined
      ? known.value.remote.get(withoutFragment(uri))
      : known.value.local.get(localId);
  };
  const refs = uris.flatMap((uri) => refOf(uri) ?? []);
  return ok({
    refs: [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()],
    unknown: remoteUris.filter((uri) => refOf(uri) === undefined),
  });
};

const resolveJobs = (
  status: StatusTargetValue,
  uris: ReadonlyArray<string>,
  lookup: TaggedCollectionLookup,
): OutboxJob[] => uris.map((uri) => ({ kind: "ResolveTaggedCollection", status, uri, lookup }));

/**
 * The collections the stored remote note `statusId` tags become those its
 * document `raw` tags, as `Create#process_tagged_collection` and
 * `ProcessStatusUpdateService#update_tagged_objects!` leave them: the stored
 * ones at once, and a `ResolveTaggedCollection` job queued for each one not
 * stored yet, where Mastodon fetches it while it processes the activity and
 * queues `TaggedCollectionResolveWorker` when that fetch fails. Running it
 * again gives the same tags, and queues the unknown ones again.
 */
export const syncRemoteTaggedCollections = async (
  env: Env,
  identity: InstanceIdentity,
  status: StatusTargetValue,
  raw: unknown,
): Promise<Result<void, RepositoryError>> => {
  const resolved = await resolveStored(env.DB, identity, noteTaggedCollectionUris(raw));
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  const replaced = await replaceTaggedCollections(env.DB, status, resolved.value.refs);
  if (replaced.isErr()) {
    return err(replaced.error);
  }
  return queueOutboxJobs(env, resolveJobs(status, resolved.value.unknown, "Uri"), env.PULL_QUEUE);
};

/**
 * The http(s) URLs a local post's text links, normalized, once each, in
 * order, as `ProcessLinksService` scans `FetchLinkCardService::URL_PATTERN`.
 */
const linkedUrls = (text: string): ReadonlyArray<string> => [
  ...new Set(
    extractEntities(text).flatMap((entity) => {
      if (entity.kind !== "Url" || !isHttpUrl(entity.url)) {
        return [];
      }
      const url = URL.parse(entity.url);
      return url === null ? [] : [url.toString()];
    }),
  ),
];

/**
 * `ProcessLinksService` on a local note just posted or edited: the
 * collections its text links become the ones it tags, those it no longer
 * links dropped. A link to a collection not stored, on a server this one
 * knows and does not block (`Instance.searchable`), queues a
 * `ResolveTaggedCollection` job, where Mastodon resolves it
 * (`ResolveURLService`) before it stores the post; the note is then
 * delivered without it. Before the note's activity is built, so its `tag`
 * carries the collections.
 */
export const linkTaggedCollections = async (
  env: Env,
  identity: InstanceIdentity,
  note: LocalNote,
  written: "Posted" | "Edited",
): Promise<Result<void, RepositoryError>> => {
  const urls = linkedUrls(note.text);
  if (urls.length === 0 && written === "Posted") {
    return ok(undefined);
  }
  const resolved = await resolveStored(env.DB, identity, urls);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  const status = StatusTarget.local(note.id);
  const replaced = await replaceTaggedCollections(env.DB, status, resolved.value.refs);
  if (replaced.isErr()) {
    return err(replaced.error);
  }
  const hostOf = (uri: string): string => URL.parse(uri)?.hostname ?? "";
  const searchable = await searchableDomains(env.DB, resolved.value.unknown.map(hostOf));
  if (searchable.isErr()) {
    return err(searchable.error);
  }
  return queueOutboxJobs(
    env,
    resolveJobs(
      status,
      resolved.value.unknown.filter((uri) => searchable.value.has(hostOf(uri))),
      "Url",
    ),
    env.PULL_QUEUE,
  );
};

const statusExists = async (
  db: D1Database,
  status: StatusTargetValue,
): Promise<Result<boolean, RepositoryError>> =>
  status.kind === "LocalStatus"
    ? (await findStatusesByIds(db, [status.statusId])).map((found) => found.has(status.statusId))
    : (await findRemoteStatusesByIds(db, [status.statusId])).map((found) =>
        found.has(status.statusId),
      );

/**
 * `ResolveTaggedCollection`, Mastodon's `TaggedCollectionResolveWorker`:
 * the collection the job names, stored or fetched, is tagged on its status.
 * A status that is gone, or a URI that names no collection, ends the job; a
 * server that could not be reached is asked again.
 */
export const processResolveTaggedCollectionJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "ResolveTaggedCollection" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const exists = await statusExists(env.DB, job.status);
  if (exists.isErr()) {
    return "retry";
  }
  if (!exists.value) {
    return "ok";
  }
  const stored = await resolveStored(env.DB, identity.value, [job.uri]);
  if (stored.isErr()) {
    return "retry";
  }
  const [known] = stored.value.refs;
  if (known !== undefined) {
    return (await addTaggedCollection(env.DB, job.status, known)).isOk() ? "ok" : "retry";
  }
  if (stored.value.unknown.length === 0) {
    return "ok";
  }
  const fetched = await fetchTaggedCollection(env, identity.value, job.uri, job.lookup);
  if (fetched.isErr() || fetched.value === "Unavailable") {
    return "retry";
  }
  if (fetched.value === undefined) {
    return "ok";
  }
  const added = await addTaggedCollection(env.DB, job.status, {
    kind: "RemoteCollection",
    id: fetched.value.id,
  });
  return added.isOk() ? "ok" : "retry";
};
