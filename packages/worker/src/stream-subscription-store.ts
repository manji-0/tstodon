import { StreamChannel, type StreamChannelValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import {
  deleteStreamSubscription,
  insertStreamSubscription,
  listListStreamSubscriptions as listListStreamSubscriptionsSql,
  listPublicStreamSubscriptions as listPublicStreamSubscriptionsSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/** A subscription as `stream_subscriptions` keeps it. */
export type SubscriptionRow = Readonly<{ stream: string; param: string }>;

/**
 * The row a fan-out finds a channel by. `user*` and `direct` streams have none: they go
 * to the account's own hub, which needs no lookup.
 */
export const subscriptionRow = (channel: StreamChannelValue): SubscriptionRow | undefined => {
  switch (channel.kind) {
    case "User":
    case "UserNotification":
    case "Direct":
      return undefined;
    case "Public":
      return { stream: StreamChannel.streamName(channel)[0] ?? "", param: "" };
    case "Hashtag":
      return {
        stream: channel.localOnly ? "hashtag:local" : "hashtag",
        param: channel.tag.toLowerCase(),
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

const ListRowSchema = z.object({ hub: z.string(), param: z.string() });

/** The list subscriptions held by any of `hubs`. */
export const listListStreamSubscriptions = async (
  db: D1Database,
  hubs: ReadonlyArray<string>,
): Promise<Result<Readonly<{ hub: string; listId: string }>[], RepositoryError>> => {
  if (hubs.length === 0) {
    return ok([]);
  }
  const rows = await runD1(() =>
    queryTyped(db, listListStreamSubscriptionsSql(JSON.stringify(hubs))),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(
    parseRows(ListRowSchema, rows.value).map((row) => ({ hub: row.hub, listId: row.param })),
  );
};

const HubRowSchema = z.object({ hub: z.string(), stream: z.string(), param: z.string() });

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
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const hubs = new Map<string, StreamChannelValue[]>();
  for (const row of parseRows(HubRowSchema, rows.value)) {
    const channel = channelOfRow(row);
    hubs.set(row.hub, [...(hubs.get(row.hub) ?? []), ...(channel ? [channel] : [])]);
  }
  const page = [...hubs].map(([hub, channels]) => ({ hub, channels }));
  return ok({ hubs: page, next: page.length >= input.limit ? page.at(-1)?.hub : undefined });
};
