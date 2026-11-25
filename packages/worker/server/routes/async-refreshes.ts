import type { ApiAsyncRefreshJSON } from "@tstodon/api";
import type { Context } from "hono";
import { ok } from "neverthrow";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { findThreadRefresh, type ThreadRefresh } from "../remote-thread-backfill";
import { findAnnualReportRefresh } from "../annual-report-store";

/** Seconds a client waits before polling a refresh, Mastodon's default. */
const ASYNC_REFRESH_RETRY_SECONDS = 3;

const CONTEXT_REFRESH_ID = /^context:([^:]+):refresh$/;
const ANNUAL_REPORT_REFRESH_ID = /^wrapstodon:([^:]+):(\d+)$/;

/**
 * The refresh id of a status's thread fetch: Mastodon's key for it. Mastodon
 * signs the key because it names a Redis entry; this one only names a remote
 * status, and only public and unlisted statuses are ever fetched.
 */
const contextRefreshId = (statusId: string): string => `context:${statusId}:refresh`;

const resultCountOf = (refresh: ThreadRefresh): number =>
  refresh.kind === "Finished" ? refresh.resultCount : 0;

/** `Mastodon-Async-Refresh` for a context whose thread fetch is still running. */
export const contextAsyncRefreshHeader = (
  statusId: string,
  refresh: ThreadRefresh | undefined,
): string | undefined =>
  refresh?.kind === "Running"
    ? `id="${contextRefreshId(statusId)}", retry=${ASYNC_REFRESH_RETRY_SECONDS}, result_count=${resultCountOf(refresh)}`
    : undefined;

/** Mastodon 4.4 `Api::V1Alpha::AsyncRefreshesController#show`. */
export const getV1AlphaAsyncRefreshesById = async (
  c: Context<{ Bindings: Env }, "/api/v1_alpha/async_refreshes/:id">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id");
  const annualReport = ANNUAL_REPORT_REFRESH_ID.exec(id);
  if (annualReport?.[1] !== undefined && annualReport[2] !== undefined) {
    // An annual report's generation, which only its owner reads (Mastodon
    // signs the id, so no one else can name it).
    const refresh =
      annualReport[1] === user.value.id
        ? await findAnnualReportRefresh(
            c.env.DB,
            user.value.id,
            Number(annualReport[2]),
            new Date(),
          )
        : ok(undefined);
    if (refresh.isErr()) {
      return jsonRepositoryError(c, refresh.error.message);
    }
    if (!refresh.value) {
      return c.json({ error: "Record not found", kind: "NotFound" }, 404);
    }
    const document: ApiAsyncRefreshJSON = {
      async_refresh: {
        id,
        status: refresh.value.kind === "Running" ? "running" : "finished",
        result_count: null,
      },
    };
    return c.json(document);
  }
  const statusId = CONTEXT_REFRESH_ID.exec(id)?.[1];
  if (statusId === undefined) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const refresh = await findThreadRefresh(c.env.DB, statusId);
  if (refresh.isErr()) {
    return jsonRepositoryError(c, refresh.error.message);
  }
  if (!refresh.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document: ApiAsyncRefreshJSON = {
    async_refresh: {
      id,
      status: refresh.value.kind === "Running" ? "running" : "finished",
      result_count: resultCountOf(refresh.value),
    },
  };
  return c.json(document);
};
