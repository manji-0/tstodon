import { normalizeHashtag } from "@tstodon/core";
import { StreamChannel, type StreamChannelValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import {
  deleteStreamSubscription,
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

/** Record that `hub` holds `channel`, which must have a row. */
export const insertSubscriptionRow = async (
  db: D1Database,
  hub: string,
  row: SubscriptionRow,
): Promise<Result<void, RepositoryError>> =>
  (await runD1(() => runTyped(db, insertStreamSubscription(hub, row.stream, row.param)))).map(
    () => undefined,
  );

/** Record that `hub` no longer holds the channel `row` stands for. */
export const deleteSubscriptionRow = async (
  db: D1Database,
  hub: string,
  row: SubscriptionRow,
): Promise<Result<void, RepositoryError>> =>
  (await runD1(() => runTyped(db, deleteStreamSubscription(hub, row.stream, row.param)))).map(
    () => undefined,
  );

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
