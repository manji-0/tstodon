import type { ApiAsyncRefreshJSON } from "@tstodon/api";
import type { Context } from "hono";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { findThreadRefresh, type ThreadRefresh } from "../remote-thread-backfill";

/** Seconds a client waits before polling a refresh, Mastodon's default. */
const ASYNC_REFRESH_RETRY_SECONDS = 3;

const CONTEXT_REFRESH_ID = /^context:([^:]+):refresh$/;

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
