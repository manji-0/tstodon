import { normalizeHashtag } from "@tstodon/core";
import { StreamChannel, type StreamChannelValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  deleteStreamSubscription,
  findStreamListeners,
  insertStreamSubscription,
  listHubStreamSubscriptions as listHubStreamSubscriptionsSql,
  listPublicStreamSubscriptions as listPublicStreamSubscriptionsSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/** A subscription as `stream_subscriptions` keeps it. */
export type SubscriptionRow = Readonly<{ stream: string; param: string }>;

/**
 * The row a fan-out finds a channel by. `user:notification` has none: it
 * carries only notifications, which are published to the account's hub
 * without a lookup.
 */
export const subscriptionRow = (channel: StreamChannelValue): SubscriptionRow | undefined => {
  switch (channel.kind) {
    case "UserNotification":
      return undefined;
    case "User":
    case "Direct":
    case "Public":
      return { stream: StreamChannel.streamName(channel)[0] ?? "", param: "" };
    case "Hashtag":
      return {
        stream: channel.localOnly ? "hashtag:local" : "hashtag",
        param: normalizeHashtag(channel.tag),
      };
    case "List":
      return { stream: "list", param: channel.listId };
  }
};

const channelOfRow = (row: SubscriptionRow): StreamChannelValue | undefined => {
  const channel = StreamChannel.fromWire({ stream: row.stream, tag: row.param, list: row.param });
  return channel.isOk() ? channel.value : undefined;
};

/** Whether any hub holds a stream that a home or a public fan-out could reach. */
export type StreamListeners = Readonly<{ home: boolean; public: boolean }>;

/**
 * How long an isolate reuses what {@link streamListeners} read. A stream
 * opened through another isolate misses the events of that long at most; a
 * row written or deleted through this one is seen at once.
 */
export const STREAM_LISTENERS_TTL_MS = 5_000;

let cachedListeners: Readonly<{ readAt: number; listeners: StreamListeners }> | undefined;

/** Bumped on every row change here, so a read that overlapped one is not kept. */
let rowChanges = 0;

const forgetListeners = (): void => {
  cachedListeners = undefined;
  rowChanges += 1;
};

/** Record that `hub` holds `channel`, which must have a row. */
export const insertSubscriptionRow = async (
  db: D1Database,
  hub: string,
  row: SubscriptionRow,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(() =>
    runTyped(db, insertStreamSubscription(hub, row.stream, row.param)),
  );
  forgetListeners();
  return written.map(() => undefined);
};

/** Record that `hub` no longer holds the channel `row` stands for. */
export const deleteSubscriptionRow = async (
  db: D1Database,
  hub: string,
  row: SubscriptionRow,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(() =>
    runTyped(db, deleteStreamSubscription(hub, row.stream, row.param)),
  );
  forgetListeners();
  return written.map(() => undefined);
};

const ListenersRow = z.object({ home: z.number(), public: z.number() });

/**
 * Which fan-outs could reach anyone, read once per {@link STREAM_LISTENERS_TTL_MS}
 * per isolate, so a fan-out with nobody to tell costs no queue message. Rows
 * left behind by an evicted hub only make it answer yes, and the fan-out that
 * finds nobody behind them deletes them. A failed read answers yes.
 */
export const streamListeners = async (db: D1Database): Promise<StreamListeners> => {
  const now = Date.now();
  if (cachedListeners && now - cachedListeners.readAt < STREAM_LISTENERS_TTL_MS) {
    return cachedListeners.listeners;
  }
  const changes = rowChanges;
  const rows = await runD1(() => queryTyped(db, findStreamListeners(), ListenersRow));
  if (rows.isErr()) {
    return { home: true, public: true };
  }
  const row = rows.value[0];
  const listeners = { home: row?.home === 1, public: row?.public === 1 };
  if (changes === rowChanges) {
    cachedListeners = { readAt: now, listeners };
  }
  return listeners;
};

const HubRowSchema = z.object({ hub: z.string(), stream: z.string(), param: z.string() });

/** A stream of an account's own hub, as `stream_subscriptions` names it. */
export type OwnStream = "user" | "direct" | "list";

/** The subscriptions to `streams` held by any of `hubs`, each with its channel. */
export const listHubStreamSubscriptions = async (
  db: D1Database,
  hubs: ReadonlyArray<string>,
  streams: ReadonlyArray<OwnStream>,
): Promise<Result<Readonly<{ hub: string; channel: StreamChannelValue }>[], RepositoryError>> => {
  if (hubs.length === 0) {
    return ok([]);
  }
  const rows = await runD1(() =>
    queryTyped(
      db,
      listHubStreamSubscriptionsSql(JSON.stringify(streams), JSON.stringify(hubs)),
      HubRowSchema,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(
    rows.value.flatMap((row) => {
      const channel = channelOfRow(row);
      return channel ? [{ hub: row.hub, channel }] : [];
    }),
  );
};

/** One hub's channels that a fan-out should consider for an entry. */
export type HubChannels = Readonly<{ hub: string; channels: StreamChannelValue[] }>;

/**
 * The public and hashtag channels of the next `limit` hubs after `afterHub`
 * that may want the entry, and the cursor of the page after, if any. With
 * `anyTag`, every hashtag channel counts (for a `delete`, whose tags are gone
 * with the status).
 */
export const listPublicStreamSubscriptions = async (
  db: D1Database,
  input: Readonly<{ entryId: string; afterHub: string; limit: number; anyTag: boolean }>,
): Promise<
  Result<Readonly<{ hubs: HubChannels[]; next: string | undefined }>, RepositoryError>
> => {
  const rows = await runD1(() =>
    queryTyped(
      db,
      listPublicStreamSubscriptionsSql(
        input.entryId,
        input.afterHub,
        input.limit,
        input.anyTag ? 1 : 0,
      ),
      HubRowSchema,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const page = [...Map.groupBy(rows.value, (row) => row.hub)].map(([hub, hubRows]) => ({
    hub,
    channels: hubRows.flatMap((row) => {
      const channel = channelOfRow(row);
      return channel ? [channel] : [];
    }),
  }));
  return ok({ hubs: page, next: page.length >= input.limit ? page.at(-1)?.hub : undefined });
};
