import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { CountedRow, queryTyped } from "./typed-sql";

/** `IfMissing` leaves a status alone when it already has a card for the same link. */
export type CardWrite = "Always" | "IfMissing";
import {
  listRemoteStatusCards as listRemoteStatusCardsSql,
  listStatusCards as listStatusCardsSql,
  setRemoteStatusCard as setRemoteStatusCardSql,
  updateStatusCard as updateStatusCardSql,
} from "./generated/prisma/sql";

const IdCardJsonRow = z.object({ id: z.string(), card_json: z.string() });

/** Store the link preview built for a remote status, with the link it was unfurled from. */
export const setRemoteStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
  cardUrl: string,
  write: CardWrite = "Always",
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(
      db,
      setRemoteStatusCardSql(statusId, cardJson, cardUrl, write === "IfMissing" ? 1 : 0),
      CountedRow,
    );
  });
  return written.map(() => undefined);
};

/** Link previews for the given remote statuses, keyed by status id. */
export const listRemoteStatusCards = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, string>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listRemoteStatusCardsSql(jsonStringArray(unique)), IdCardJsonRow),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(queried.value.map((row) => [row.id, row.card_json])));
};

/** Store the link preview built for a status, with the link it was unfurled from. */
export const setStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
  cardUrl: string,
  write: CardWrite = "Always",
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(
      db,
      updateStatusCardSql(statusId, cardJson, cardUrl, write === "IfMissing" ? 1 : 0),
      CountedRow,
    );
  });
  return written.map(() => undefined);
};

/** Link previews for the given statuses, keyed by status id. */
export const listStatusCards = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, string>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listStatusCardsSql(jsonStringArray(unique)), IdCardJsonRow),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(queried.value.map((row) => [row.id, row.card_json])));
};
