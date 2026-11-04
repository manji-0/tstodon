import { z } from "zod";
import { parseRows } from "./d1";

/** A local account's boost that went away with the status it boosted. */
export type RemovedBoost = Readonly<{ id: string; accountId: string }>;

const BoostRowSchema = z.object({ id: z.string().min(1), account_id: z.string().min(1) });

/** The boosts in `id, account_id` rows, as the delete queries return them. */
export const removedBoostsFromRows = (
  rows: ReadonlyArray<unknown> | undefined,
): ReadonlyArray<RemovedBoost> =>
  parseRows(BoostRowSchema, rows).map((row) => ({ id: row.id, accountId: row.account_id }));
