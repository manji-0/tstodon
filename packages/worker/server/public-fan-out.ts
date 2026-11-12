import type { ApiStatusJSON } from "@tstodon/api";
import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  type StreamChannelValue,
  type StreamDeliveryValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { afterResponse } from "./after-response";
import type { RepositoryError } from "./d1";
import { runOrQueue } from "./inline-job";
import { type StreamRenderTally, measureJobPage, streamRenderTally } from "./metrics";
import { parseInstanceIdentity } from "./runtime-config";
import { MAX_HUB_TAGGED_CHANNELS } from "./stream-hub";
import { publishToHub } from "./stream-publish";
import {
  type HubChannels,
  listPublicStreamSubscriptions,
  streamListeners,
} from "./stream-subscription-store";
import { publicTimelineDocuments, tagTimelineDocuments } from "./timeline-documents";

type FanOutPublic = Extract<OutboxJobValue, { kind: "FanOutPublic" }>;

/** Hubs read per pass; a full page queues the next. */
const PUBLIC_FAN_OUT_PAGE_SIZE = 20;

/**
 * Timeline passes per page: each channel that may carry the entry costs one
 * (several D1 queries), so a page stops before the hub that would go over
 * and queues the rest. A hub alone stays under it (six public streams and
 * `MAX_HUB_TAGGED_CHANNELS` hashtags), so every page makes progress.
 */
const PUBLIC_FAN_OUT_PASS_BUDGET = 6 + MAX_HUB_TAGGED_CHANNELS;

/**
 * Tell the public and hashtag streams about a public status, as Mastodon's
 * `FanOutOnWriteService` and `RemoveStatusService` publish to
 * `timeline:public*` and `timeline:hashtag:*`. Callers start it only for
 * public notes stored as they happen, not for backfilled ones. Nothing is
 * done when no hub holds a public or hashtag stream; otherwise the first
 * page of hubs is told once the response is ready, and the queue takes later
 * pages and a page to retry. Best effort: a viewer who misses the event still
 * sees the status on the next fetch.
 */
export const startPublicFanOut = (
  env: Env,
  fanOut: Readonly<{ event: FanOutPublic["event"]; entryId: string }>,
): void => {
  const job = OutboxJob.parse({ kind: "FanOutPublic", ...fanOut, afterHub: "" });
  if (job.isErr() || job.value.kind !== "FanOutPublic") {
    return;
  }
  const fanOutJob = job.value;
  afterResponse(fanOutJob.kind, async () => {
    if ((await streamListeners(env.DB)).public) {
      await runOrQueue(env, fanOutJob, processFanOutPublicJob);
    }
  });
};

/** The entry as `channel`'s timeline holds it for the viewer, or nothing when it does not. */
const channelDocument = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  channel: StreamChannelValue,
  entryId: string,
): Promise<Result<ApiStatusJSON | undefined, RepositoryError>> => {
  const cursor = { onlyId: entryId };
  switch (channel.kind) {
    case "Public": {
      const scopes = { local: channel.origin !== "Remote", remote: channel.origin !== "Local" };
      const documents = await publicTimelineDocuments(
        env,
        identity,
        viewerId,
        { scopes, onlyMedia: channel.onlyMedia },
        1,
        cursor,
      );
      return documents.map((found) => found[0]);
    }
    case "Hashtag": {
      const documents = await tagTimelineDocuments(
        env,
        identity,
        viewerId,
        channel.tag,
        {
          scopes: { local: true, remote: !channel.localOnly },
          filters: { any: [], all: [], none: [], onlyMedia: false },
        },
        1,
        cursor,
      );
      return documents.map((found) => found[0]);
    }
    case "User":
    case "UserNotification":
    case "Direct":
    case "List":
      return ok(undefined);
  }
};

/** What one hub hears: the entry on each of its channels whose timeline holds it. */
const hubDelivery = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutPublic,
  hub: HubChannels,
): Promise<Result<StreamDeliveryValue | undefined, RepositoryError>> => {
  if (job.event === "delete") {
    return ok({ channels: hub.channels, event: { kind: "delete", statusId: job.entryId } });
  }
  const channels: StreamChannelValue[] = [];
  let payload: ApiStatusJSON | undefined;
  for (const channel of hub.channels) {
    const document = await channelDocument(env, identity, hub.hub, channel, job.entryId);
    if (document.isErr()) {
      return err(document.error);
    }
    if (document.value) {
      channels.push(channel);
      payload = document.value;
    }
  }
  return ok(payload ? { channels, event: { kind: job.event, payload } } : undefined);
};

/**
 * Tell one page of subscribed hubs about the entry, each with the document
 * rendered for its viewer. Redoing a page only sends the events again.
 * Resolves to the cursor of the next page, or `undefined` when this was the last.
 */
const fanOutPublicPage = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutPublic,
  pageSize: number = PUBLIC_FAN_OUT_PAGE_SIZE,
): Promise<Result<Readonly<{ hubs: number; next: string | undefined }>, RepositoryError>> => {
  const page = await listPublicStreamSubscriptions(env.DB, {
    entryId: job.entryId,
    afterHub: job.afterHub,
    limit: pageSize,
    anyTag: job.event === "delete",
  });
  if (page.isErr()) {
    return err(page.error);
  }
  const renders = streamRenderTally(env, "public");
  try {
    return await tellHubs(env, identity, job, page.value, renders);
  } finally {
    renders.flush();
  }
};

const tellHubs = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutPublic,
  page: Readonly<{ hubs: ReadonlyArray<HubChannels>; next: string | undefined }>,
  renders: StreamRenderTally,
): Promise<Result<Readonly<{ hubs: number; next: string | undefined }>, RepositoryError>> => {
  let passes = 0;
  let told = 0;
  for (const [index, hub] of page.hubs.entries()) {
    const cost = job.event === "delete" ? 0 : hub.channels.length;
    if (passes > 0 && passes + cost > PUBLIC_FAN_OUT_PASS_BUDGET) {
      return ok({ hubs: told, next: page.hubs[index - 1]?.hub });
    }
    passes += cost;
    told += 1;
    const delivery = await renders.measure(() => hubDelivery(env, identity, job, hub));
    if (delivery.isErr()) {
      return err(delivery.error);
    }
    if (delivery.value) {
      try {
        await publishToHub(env, hub.hub, delivery.value);
      } catch {
        console.error(JSON.stringify({ kind: "PublicFanOutNotPublished", hub: hub.hub }));
      }
    }
  }
  return ok({ hubs: told, next: page.next });
};

/** Handle one queued page of a public fan-out, queueing the next when there is one. */
export const processFanOutPublicJob = (env: Env, job: FanOutPublic): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    const page = await fanOutPublicPage(env, identity.value, job);
    if (page.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    const { hubs, next } = page.value;
    if (next !== undefined) {
      try {
        await env.OUTBOX_PROCESS_QUEUE.send({ ...job, afterHub: next });
      } catch {
        console.error(JSON.stringify({ kind: "PublicFanOutNotQueued", entryId: job.entryId }));
        return { outcome: "ok", size: hubs, chained: false };
      }
    }
    return { outcome: "ok", size: hubs, chained: next !== undefined };
  });
