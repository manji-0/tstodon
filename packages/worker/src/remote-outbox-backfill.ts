import {
  ActivityId,
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  RemoteStatus,
  type RemoteActor,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { stringList } from "./form-values";
import { replaceRemoteActorPins } from "./remote-actor-pin-store";
import { recordRemoteBoost } from "./remote-boost";
import { remoteActorFromDocument } from "./remote-actor-fetch";
import {
  claimRemoteOutboxBackfill,
  findRemoteActorByUri,
  releaseRemoteOutboxBackfill,
  upsertRemoteActor,
} from "./remote-actor-store";
import { persistAnnouncedObject, persistRemoteObject } from "./remote-status-persist";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/** How long a backfilled outbox counts as fresh before a profile view fetches it again. */
export const OUTBOX_BACKFILL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Collection items processed per backfill: the first page's newest, enough
 * to fill a profile's first screen. Each referenced item can cost a fetch,
 * so this bounds the job's subrequests.
 */
export const OUTBOX_BACKFILL_ITEM_LIMIT = 20;

type BackfillRemoteOutbox = Extract<OutboxJobValue, { kind: "BackfillRemoteOutbox" }>;

/**
 * Queue a backfill of `actorUri`'s outbox unless one ran within the TTL.
 * Best effort and off the request path: the profile renders what is cached.
 */
export const requestRemoteOutboxBackfill = async (env: Env, actorUri: string): Promise<void> => {
  const claimed = await claimRemoteOutboxBackfill(env.DB, actorUri, OUTBOX_BACKFILL_TTL_MS);
  if (claimed.isErr() || claimed.value === undefined) {
    return;
  }
  const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
  } catch {
    console.error(JSON.stringify({ kind: "OutboxBackfillNotQueued", actorUri }));
    await releaseRemoteOutboxBackfill(env.DB, actorUri, claimed.value);
  }
};

const CollectionPageSchema = z
  .object({
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
  })
  .passthrough();

const CollectionSchema = CollectionPageSchema.extend({
  first: z.union([z.string().min(1), CollectionPageSchema]).optional(),
});

const parseCollection = schemaResult(CollectionSchema);
const parseCollectionPage = schemaResult(CollectionPageSchema);

const pageItems = (page: z.infer<typeof CollectionPageSchema>): ReadonlyArray<unknown> =>
  page.orderedItems ?? page.items ?? [];

/**
 * The first items of a collection: its own, or its `first` page's, which may
 * be embedded or a link. Only one page is read. Undefined when the collection
 * could not be read, as opposed to an empty one.
 */
const collectionItems = async (
  identity: InstanceIdentity,
  collectionUri: string,
  options: FederatedFetchOptions,
): Promise<ReadonlyArray<unknown> | undefined> => {
  const raw = await fetchActivityJson(identity, collectionUri, options);
  const collection = raw.isOk() ? parseCollection(raw.value) : undefined;
  if (!collection || collection.isErr()) {
    return undefined;
  }
  const own = pageItems(collection.value);
  const first = collection.value.first;
  if (own.length > 0 || first === undefined) {
    return own.slice(0, OUTBOX_BACKFILL_ITEM_LIMIT);
  }
  if (typeof first !== "string") {
    return pageItems(first).slice(0, OUTBOX_BACKFILL_ITEM_LIMIT);
  }
  const page = await fetchActivityJson(identity, first, options);
  const parsed = page.isOk() ? parseCollectionPage(page.value) : undefined;
  return parsed?.isOk() ? pageItems(parsed.value).slice(0, OUTBOX_BACKFILL_ITEM_LIMIT) : undefined;
};

const AudienceSchema = z.union([z.string(), z.array(z.string())]).optional();

const ObjectReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), to: AudienceSchema, cc: AudienceSchema }).passthrough(),
]);

const OutboxItemSchema = z.object({
  type: z.union([z.literal("Create"), z.literal("Announce")]),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: ObjectReferenceSchema,
  to: AudienceSchema,
  cc: AudienceSchema,
});

const parseOutboxItem = schemaResult(OutboxItemSchema);

const urlHost = (href: string): string | undefined => {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Store one outbox item: a public `Create` of the actor's own note, or a
 * public `Announce` as a boost. Ids sort at the item's publish time, and
 * nothing fans out or notifies, since these are old posts. An embedded
 * object is trusted only when it comes from the actor's host; an announced
 * note from elsewhere is fetched with the boost path's origin checks.
 */
const backfillOutboxItem = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  options: FederatedFetchOptions,
): Promise<void> => {
  const item = parseOutboxItem(raw);
  if (item.isErr() || item.value.actor !== actor.actorUri) {
    return;
  }
  const actorHost = urlHost(actor.actorUri);
  const object = item.value.object;
  // A `Create` is as visible as its note, as Mastodon reads it; servers
  // (tstodon among them) may address only the note.
  const audience = item.value.type === "Create" && typeof object !== "string" ? object : item.value;
  const visibility = RemoteStatus.visibilityFromAudience(
    stringList(audience.to),
    stringList(audience.cc),
  );
  if (
    urlHost(item.value.id) !== actorHost ||
    (visibility.kind !== "Public" && visibility.kind !== "Unlisted")
  ) {
    return;
  }
  const objectUri = typeof object === "string" ? object : object.id;
  const fromActorHost = urlHost(objectUri) === actorHost;
  const persist = { ...options, idClock: "Published" } as const;
  if (item.value.type === "Create") {
    if (fromActorHost) {
      await persistRemoteObject(env, identity, actor, object, persist);
    }
    return;
  }
  const announced = await persistAnnouncedObject(
    env,
    identity,
    actor,
    fromActorHost ? object : objectUri,
    persist,
  );
  if (announced.isOk()) {
    await recordRemoteBoost(
      env.DB,
      identity,
      actor.actorUri,
      { id: item.value.id, object: objectUri },
      raw,
      announced.value,
      "Published",
    );
  }
};

/**
 * The cached actor, refetched once when it was cached before collection URIs
 * were kept, so its outbox can be found.
 */
const withCollections = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<RemoteActor> => {
  if (actor.outboxUri || actor.featuredUri) {
    return actor;
  }
  const raw = await fetchActivityJson(identity, actor.actorUri, options);
  const refreshed = raw.isOk() ? remoteActorFromDocument(raw.value, actor.actorUri) : undefined;
  if (!refreshed || refreshed.isErr()) {
    return actor;
  }
  const stored = await upsertRemoteActor(env.DB, refreshed.value);
  return stored.isOk() ? stored.value : actor;
};

export const processBackfillRemoteOutboxJob = async (
  env: Env,
  job: BackfillRemoteOutbox,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const cached = await findRemoteActorByUri(env.DB, job.actorUri);
  if (identity.isErr() || cached.isErr()) {
    return "retry";
  }
  const suspended = await suspendedDomains(env.DB);
  if (!cached.value || suspended.has(cached.value.domain.toLowerCase())) {
    return "ok";
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: suspended,
  };
  const actor = await withCollections(env, identity.value, cached.value, options);
  const outbox = actor.outboxUri
    ? await collectionItems(identity.value, actor.outboxUri, options)
    : undefined;
  for (const item of outbox ?? []) {
    await backfillOutboxItem(env, identity.value, actor, item, options);
  }
  const featured = actor.featuredUri
    ? await collectionItems(identity.value, actor.featuredUri, options)
    : undefined;
  if (featured) {
    await backfillPins(env, identity.value, actor, featured, options);
  }
  return "ok";
};

const parseObjectReference = schemaResult(ObjectReferenceSchema);

/**
 * Store the actor's pinned notes from its `featured` items (notes or their
 * URIs, from the actor's host) and make them its pins, in order.
 */
const backfillPins = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  items: ReadonlyArray<unknown>,
  options: FederatedFetchOptions,
): Promise<void> => {
  const actorHost = urlHost(actor.actorUri);
  const statusIds: string[] = [];
  for (const raw of items) {
    const item = parseObjectReference(raw);
    if (item.isErr()) {
      continue;
    }
    const uri = typeof item.value === "string" ? item.value : item.value.id;
    if (urlHost(uri) !== actorHost) {
      continue;
    }
    const stored = await persistRemoteObject(env, identity, actor, item.value, {
      ...options,
      idClock: "Published",
    });
    if (stored.isOk() && stored.value?.actorUri === actor.actorUri) {
      statusIds.push(stored.value.id);
    }
  }
  await replaceRemoteActorPins(env.DB, actor.actorUri, statusIds);
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([CollectionSchema, CollectionPageSchema, OutboxItemSchema]);
