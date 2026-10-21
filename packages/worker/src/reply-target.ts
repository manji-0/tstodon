import {
  InstanceIdentity,
  type LocalStatus,
  type RemoteStatus,
  type Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { findRemoteStatusById, findRemoteStatusByObjectUri } from "./remote-status-store";
import { findStatusById, listStatusReplyUris } from "./status-store";
import { canViewRemoteStatus, canViewStatus } from "./visibility-guard";

/** The status a new local note answers: a local one, or a cached remote one. */
export type ReplyTarget =
  | Readonly<{ kind: "Local"; status: LocalStatus }>
  | Readonly<{ kind: "Remote"; status: RemoteStatus }>;

/** The status `in_reply_to_id` names, when the author may see it; `undefined` otherwise. */
export const findReplyTarget = async (
  db: D1Database,
  id: string,
  viewerId: string,
): Promise<Result<ReplyTarget | undefined, RepositoryError>> => {
  const local = await findStatusById(db, id);
  if (local.isErr()) {
    return err(local.error);
  }
  if (local.value) {
    return ok(
      (await canViewStatus(db, local.value, viewerId))
        ? { kind: "Local", status: local.value }
        : undefined,
    );
  }
  const remote = await findRemoteStatusById(db, id);
  if (remote.isErr()) {
    return err(remote.error);
  }
  return ok(
    remote.value && (await canViewRemoteStatus(db, remote.value, viewerId))
      ? { kind: "Remote", status: remote.value }
      : undefined,
  );
};

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
  const parent = await findRemoteStatusByObjectUri(db, inReplyTo);
  const open = note.visibility.kind === "Public" || note.visibility.kind === "Unlisted";
  return {
    inReplyTo,
    addressAuthor: open && parent.isOk() && parent.value ? parent.value.actorUri : undefined,
  };
};
