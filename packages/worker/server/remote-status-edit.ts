import type { ApiAccountJSON, ApiStatusEditJSON } from "@tstodon/api";
import {
  IsoInstant,
  RemoteAttachmentSchema,
  RemoteEmojiSchema,
  RemotePoll,
  RemotePollSchema,
  type RemoteStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import { parseJsonColumn } from "./json-column";
import { mastodonRemoteStatus } from "./remote-status-document";
import { listRemoteStatusEdits, remoteStatusEditStatement } from "./remote-status-edit-store";

/**
 * Whether the author changed what the post says. Vote counts, which a
 * `Question` refreshes as people vote, are not an edit, as on Mastodon.
 */
export const contentChanged = (before: RemoteStatusValue, after: RemoteStatusValue): boolean =>
  before.contentHtml !== after.contentHtml ||
  before.spoilerText !== after.spoilerText ||
  before.sensitive !== after.sensitive ||
  JSON.stringify(before.media) !== JSON.stringify(after.media) ||
  !RemotePoll.sameQuestion(before.poll, after.poll);

/** Whether the instant `candidate` is later than `than`: an edit dated so replaces the one stored. */
export const isNewer = (candidate: string, than: string): boolean =>
  Date.parse(candidate) > Date.parse(than);

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

/**
 * The statement that keeps the version `status` holds now. It runs in the
 * batch that replaces the row (`upsertRemoteStatus`), so an `Update` whose
 * write fails keeps no version, and its redelivery keeps it once.
 */
export const remoteRevisionStatement = (
  db: D1Database,
  status: RemoteStatusValue,
): D1PreparedStatement =>
  remoteStatusEditStatement(db, status.id, JSON.stringify(revisionOf(status)));

/** The `StatusEdit` entity of one version of `status`. */
const statusEditJson = (
  status: RemoteStatusValue,
  account: ApiAccountJSON,
  revision: RemoteRevision,
): ApiStatusEditJSON => {
  const document = mastodonRemoteStatus(
    {
      ...status,
      contentHtml: revision.contentHtml,
      spoilerText: revision.spoilerText,
      sensitive: revision.sensitive,
      media: revision.media,
      poll: revision.poll,
      emojis: revision.emojis,
    },
    account,
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
 * were kept shows only its current one. `account` is its author as the reader
 * is shown it.
 */
export const remoteStatusHistory = async (
  db: D1Database,
  status: RemoteStatusValue,
  account: ApiAccountJSON,
): Promise<Result<ApiStatusEditJSON[], RepositoryError>> => {
  const stored = await listRemoteStatusEdits(db, status.id);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const replaced = stored.value.toReversed().flatMap((text) => {
    const revision = parseJsonColumn(RemoteRevisionSchema, text);
    return revision.isOk() ? [revision.value] : [];
  });
  return ok(
    [...replaced, revisionOf(status)].map((revision) => statusEditJson(status, account, revision)),
  );
};
