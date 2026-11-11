import { type LocalStatus, type RemoteStatusValue, type StatusTargetValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { listQuoteFilterRelationsJson } from "./generated/prisma/sql";
import type { QuotedStatusAccess } from "./quote-document";
import { queryTyped } from "./typed-sql";
import { viewableStatusIds } from "./visibility-guard";

const RelationRow = z.object({
  relation: z.union([z.literal("blocking"), z.literal("muting"), z.literal("domain_blocking")]),
  target: z.string(),
});

type Relation = z.infer<typeof RelationRow>["relation"];

/** A quoted author: a local account id, or a remote actor URI. */
type Author = Readonly<{ key: string; local: boolean }>;

/** Which of `authors` the viewer blocks, mutes or domain-blocks, in one statement. */
const viewerRelations = async (
  db: D1Database,
  viewerId: string,
  authors: ReadonlyArray<Author>,
): Promise<Result<(relation: Relation, author: Author) => boolean, RepositoryError>> => {
  const keysOf = (local: boolean) =>
    jsonStringArray([...new Set(authors.flatMap((a) => (a.local === local ? [a.key] : [])))]);
  const rows = await runD1(() =>
    queryTyped(
      db,
      listQuoteFilterRelationsJson(viewerId, keysOf(true), keysOf(false), nowIso()),
      RelationRow,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const found = new Set(rows.value.map((row) => `${row.relation} ${row.target}`));
  return ok((relation, author) => found.has(`${relation} ${author.key}`));
};

/**
 * Mastodon's `StatusFilter#filter_state_for_quote` for the quoted statuses
 * `locals` and `remotes` as the viewer sees them: their author sees them
 * as they are; a status the viewer may not see (`StatusPolicy#show?`,
 * including a public or unlisted one whose author blocks the viewer, local
 * or remote) is `Unauthorized`; then the viewer's domain block, block and
 * mute of the author label it, in that order. A target in neither list is
 * `Gone`.
 */
export const quotedStatusAccess = async (
  db: D1Database,
  locals: ReadonlyArray<LocalStatus>,
  remotes: ReadonlyArray<RemoteStatusValue>,
  viewerId: string | undefined,
): Promise<Result<(quoted: StatusTargetValue) => QuotedStatusAccess, RepositoryError>> => {
  const authors = new Map<string, Author>();
  for (const status of locals) {
    authors.set(`LocalStatus ${status.id}`, { key: status.accountId, local: true });
  }
  for (const status of remotes) {
    authors.set(`RemoteStatus ${status.id}`, { key: status.actorUri, local: false });
  }
  const [viewable, related] = await Promise.all([
    viewableStatusIds(db, locals, remotes, viewerId),
    viewerId === undefined || authors.size === 0
      ? Promise.resolve(ok(() => false))
      : viewerRelations(db, viewerId, [...authors.values()]),
  ]);
  if (related.isErr()) {
    return err(related.error);
  }
  const has = related.value;
  return ok((target) => {
    const author = authors.get(`${target.kind} ${target.statusId}`);
    if (author === undefined) {
      return "Gone";
    }
    if (author.local && author.key === viewerId) {
      return "Shown";
    }
    if (!viewable.has(target.statusId)) {
      return "Unauthorized";
    }
    if (has("domain_blocking", author)) {
      return "BlockedDomain";
    }
    if (has("blocking", author)) {
      return "BlockedAccount";
    }
    return has("muting", author) ? "MutedAccount" : "Shown";
  });
};
