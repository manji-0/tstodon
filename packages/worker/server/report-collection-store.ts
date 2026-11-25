import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1, sqlInJsonEach } from "./d1";

/** Record the collections a report names. */
export const insertReportCollections = async (
  db: D1Database,
  reportId: string,
  collectionIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  collectionIds.length === 0
    ? ok(undefined)
    : runD1(async () => {
        await db
          .prepare(
            `INSERT OR IGNORE INTO report_collections (report_id, collection_id)
             SELECT ?, value FROM json_each(?)`,
          )
          .bind(reportId, jsonStringArray(collectionIds))
          .run();
      });

/** Each report's collection ids, by report id. */
export const reportCollectionIds = async (
  db: D1Database,
  reportIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<string>>, RepositoryError>> =>
  reportIds.length === 0
    ? ok(new Map())
    : runD1(async () => {
        const { results } = await db
          .prepare(
            `SELECT report_id, collection_id FROM report_collections
             WHERE report_id ${sqlInJsonEach()} ORDER BY collection_id`,
          )
          .bind(jsonStringArray(reportIds))
          .all();
        const byReport = new Map<string, string[]>();
        for (const row of parseRows(
          z.object({ report_id: z.string(), collection_id: z.string() }),
          results,
        )) {
          byReport.set(row.report_id, [...(byReport.get(row.report_id) ?? []), row.collection_id]);
        }
        return byReport;
      });
