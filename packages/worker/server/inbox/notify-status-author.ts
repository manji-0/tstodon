import type { LocalStatus } from "@tstodon/domain";
import { ok } from "neverthrow";
import { notifyFromRemote } from "../notify";
import { findStatusById } from "../status-store";

/**
 * Tell a local status's author about a remote actor's Like or Announce of it.
 * `read` is the status when the caller already read it.
 */
export const notifyStatusAuthor = async (
  env: Env,
  actorUri: string,
  statusId: string,
  kind: "favourite" | "reblog",
  read?: LocalStatus,
): Promise<void> => {
  const status = read === undefined ? await findStatusById(env.DB, statusId) : ok(read);
  if (status.isOk() && status.value?.kind === "LocalNote") {
    await notifyFromRemote(env, { accountId: status.value.accountId, actorUri, kind, statusId });
  }
};
