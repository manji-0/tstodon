import {
  type InstanceIdentity,
  IsoInstant,
  RemoteAttachmentSchema,
  RemoteEmojiSchema,
  RemotePollSchema,
  type RemoteActor,
  type RemoteStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import { parseJsonColumn } from "./json-column";
import { mastodonRemoteStatus } from "./remote-status-document";
import { insertRemoteStatusEdit, listRemoteStatusEdits } from "./remote-status-edit-store";

/** One version of a remote note: what its author had published as of `at`. */
const RemoteRevisionSchema = z.object({
  kind: z.literal("RemoteRevision"),
  at: IsoInstant.schema,
  contentHtml: z.string(),
  spoilerText: z.string(),
  sensitive: z.boolean(),
  media: z.array(RemoteAttachmentSchema),
  poll: RemotePollSchema,
  emojis: z.array(RemoteEmojiSchema),
});

export type RemoteRevision = z.infer<typeof RemoteRevisionSchema>;

/** The note as it reads now; `at` is when it was last edited, or published if never. */
export const revisionOf = (status: RemoteStatusValue): RemoteRevision => ({
  kind: "RemoteRevision",
  at: status.editedAt.kind === "Edited" ? status.editedAt.at : status.publishedAt,
  contentHtml: status.contentHtml,
  spoilerText: status.spoilerText,
  sensitive: status.sensitive,
  media: [...status.media],
  poll: status.poll,
  emojis: [...status.emojis],
});

/** Keep the version `status` holds now, before an `Update` replaces it. */
export const snapshotRemoteRevision = (
  db: D1Database,
  status: RemoteStatusValue,
): Promise<Result<void, RepositoryError>> =>
  insertRemoteStatusEdit(db, status.id, JSON.stringify(revisionOf(status)));

/** The `StatusEdit` entity of one version of `status`. */
const statusEditJson = (
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  actor: RemoteActor,
  revision: RemoteRevision,
): Record<string, unknown> => {
  const document = mastodonRemoteStatus(
    identity,
    {
      ...status,
      contentHtml: revision.contentHtml,
      spoilerText: revision.spoilerText,
      sensitive: revision.sensitive,
      media: revision.media,
      poll: revision.poll,
      emojis: revision.emojis,
    },
    actor,
  );
  return {
    content: document.content,
    spoiler_text: revision.spoilerText,
    sensitive: revision.sensitive,
    created_at: revision.at,
    account: document.account,
    poll:
      revision.poll.kind === "NoPoll"
        ? null
        : { options: revision.poll.options.map((option) => ({ title: option.title })) },
    media_attachments: document.media_attachments,
    emojis: document.emojis,
  };
};

/**
 * `GET /api/v1/statuses/:id/history` for a remote note: every version it held,
 * the original first and the current one last. A note edited before versions
 * were kept shows only its current one.
 */
export const remoteStatusHistory = async (
  db: D1Database,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  actor: RemoteActor,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  const stored = await listRemoteStatusEdits(db, status.id);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const replaced = stored.value.toReversed().flatMap((text) => {
    const revision = parseJsonColumn(RemoteRevisionSchema, text);
    return revision.isOk() ? [revision.value] : [];
  });
  return ok(
    [...replaced, revisionOf(status)].map((revision) =>
      statusEditJson(identity, status, actor, revision),
    ),
  );
};
