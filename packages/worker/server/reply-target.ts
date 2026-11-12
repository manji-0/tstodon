import { InstanceIdentity, type ThreadStatus, type Visibility } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { findShownStatusAnywhere } from "./found-status";
import { findDeliveredRemoteStatus, readableRemoteStatus } from "./remote-status-store";
import { findStatusById, listStatusReplyUris } from "./status-store";

/**
 * The status `in_reply_to_id` names, local or cached remote, when Mastodon's
 * `StatusPolicy#show?` lets the author see it; `undefined` otherwise.
 */
export const findReplyTarget = async (
  env: Env,
  id: string,
  viewerId: string,
): Promise<Result<ThreadStatus | undefined, RepositoryError>> =>
  (await findShownStatusAnywhere(env, id, viewerId)).map((found) =>
    found === undefined
      ? undefined
      : found.kind === "LocalStatus"
        ? { kind: "Local", status: found.status }
        : { kind: "Remote", status: found.status },
  );

/** How a local note federates its reply: the parent's URI, and who else to address. */
export type NoteReply = Readonly<{
  inReplyTo: string;
  /**
   * A remote parent's author, addressed on a public or unlisted reply so it
   * reaches them as Mastodon delivers replies; private and direct replies
   * reach only who they mention.
   */
  addressAuthor: string | undefined;
}>;

export const loadNoteReply = async (
  db: D1Database,
  identity: InstanceIdentity,
  note: Readonly<{ id: string; inReplyToId: string | null; visibility: Visibility }>,
): Promise<NoteReply | undefined> => {
  if (note.inReplyToId) {
    const parent = await findStatusById(db, note.inReplyToId);
    if (parent.isErr() || !parent.value) {
      return undefined;
    }
    const author = await findAccountById(db, parent.value.accountId);
    if (author.isErr() || !author.value) {
      return undefined;
    }
    return {
      inReplyTo: `${InstanceIdentity.actorUrl(identity, author.value.username)}/statuses/${parent.value.id}`,
      addressAuthor: undefined,
    };
  }
  const uris = await listStatusReplyUris(db, [note.id]);
  const inReplyTo = uris.isOk() ? uris.value.get(note.id) : undefined;
  if (!inReplyTo) {
    return undefined;
  }
  const parent = readableRemoteStatus(await findDeliveredRemoteStatus(db, inReplyTo));
  const open = note.visibility.kind === "Public" || note.visibility.kind === "Unlisted";
  return {
    inReplyTo,
    addressAuthor: open && parent.isOk() && parent.value ? parent.value.actorUri : undefined,
  };
};
