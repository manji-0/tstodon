import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { queryTyped } from "./typed-sql";
import {
  listRemoteStatusCards as listRemoteStatusCardsSql,
  listStatusCards as listStatusCardsSql,
  setRemoteStatusCard as setRemoteStatusCardSql,
  updateStatusCard as updateStatusCardSql,
} from "./generated/prisma/sql";

/** Store the link preview built for a remote status, with the link it was unfurled from. */
export const setRemoteStatusCard = async (
  db: D1Database,
  statusId: string,
  cardJson: string,
  cardUrl: string,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, setRemoteStatusCardSql(statusId, cardJson, cardUrl));
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
    queryTyped<{ id: string; card_json: string }>(
      db,
      listRemoteStatusCardsSql(jsonStringArray(unique)),
    ),
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
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await queryTyped(db, updateStatusCardSql(statusId, cardJson, cardUrl));
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
    queryTyped<{ id: string; card_json: string }>(db, listStatusCardsSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  return ok(new Map(queried.value.map((row) => [row.id, row.card_json])));
};
