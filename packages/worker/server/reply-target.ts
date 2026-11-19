import { InstanceIdentity, type ThreadStatus, type Visibility } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { findAccountById, findAccountsByIds } from "./account-store";
import { readableRow, type RepositoryError } from "./d1";
import { findShownStatusAnywhere } from "./found-status";
import { findDeliveredRemoteStatus, findRemoteStatusesByObjectUris } from "./remote-status-store";
import { findStatusById, findStatusesByIds, listStatusReplyUris } from "./status-store";

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
  const parent = readableRow(await findDeliveredRemoteStatus(db, inReplyTo));
  const open = note.visibility.kind === "Public" || note.visibility.kind === "Unlisted";
  return {
    inReplyTo,
    addressAuthor: open && parent.isOk() && parent.value ? parent.value.actorUri : undefined,
  };
};

/**
 * {@link loadNoteReply} for several notes, keyed by note id; a note that
 * replies to nothing has no entry. The parents of all the notes are read at
 * once.
 */
export const loadNoteReplies = async (
  db: D1Database,
  identity: InstanceIdentity,
  notes: ReadonlyArray<
    Readonly<{ id: string; inReplyToId: string | null; visibility: Visibility }>
  >,
): Promise<ReadonlyMap<string, NoteReply>> => {
  const toLocal = notes.flatMap((note) =>
    note.inReplyToId ? [{ note, parentId: note.inReplyToId }] : [],
  );
  const toRemote = notes.filter((note) => !note.inReplyToId);
  const [parents, uris] = await Promise.all([
    findStatusesByIds(
      db,
      toLocal.map((entry) => entry.parentId),
    ),
    listStatusReplyUris(
      db,
      toRemote.map((note) => note.id),
    ),
  ]);
  const replyUris = uris.isOk() ? uris.value : new Map<string, string>();
  const [authors, remoteParents] = await Promise.all([
    findAccountsByIds(
      db,
      parents.isOk() ? [...parents.value.values()].map((parent) => parent.accountId) : [],
    ),
    findRemoteStatusesByObjectUris(db, [...replyUris.values()]),
  ]);
  const local = toLocal.flatMap(({ note, parentId }): [string, NoteReply][] => {
    const parent = parents.isOk() ? parents.value.get(parentId) : undefined;
    const author = parent && authors.isOk() ? authors.value.get(parent.accountId) : undefined;
    return parent && author
      ? [
          [
            note.id,
            {
              inReplyTo: `${InstanceIdentity.actorUrl(identity, author.username)}/statuses/${parent.id}`,
              addressAuthor: undefined,
            },
          ],
        ]
      : [];
  });
  const remote = toRemote.flatMap((note): [string, NoteReply][] => {
    const inReplyTo = replyUris.get(note.id);
    if (!inReplyTo) {
      return [];
    }
    const parent = remoteParents.isOk() ? remoteParents.value.get(inReplyTo) : undefined;
    const open = note.visibility.kind === "Public" || note.visibility.kind === "Unlisted";
    return [[note.id, { inReplyTo, addressAuthor: open && parent ? parent.actorUri : undefined }]];
  });
  return new Map([...local, ...remote]);
};
