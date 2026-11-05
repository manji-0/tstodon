import { notifyFromRemote } from "../notify";
import { findStatusById } from "../status-store";

/** Tell a local status's author about a remote actor's Like or Announce of it. */
export const notifyStatusAuthor = async (
  env: Env,
  actorUri: string,
  statusId: string,
  kind: "favourite" | "reblog",
): Promise<void> => {
  const status = await findStatusById(env.DB, statusId);
  if (status.isOk() && status.value?.kind === "LocalNote") {
    await notifyFromRemote(env, { accountId: status.value.accountId, actorUri, kind, statusId });
  }
};
