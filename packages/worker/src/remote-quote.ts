import { schemaResult } from "@tstodon/core";
import { type InstanceIdentity, type RemoteStatusValue, StatusTarget } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "./activitypub";
import { JsonObjectSchema, refId } from "./activitypub-wire";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { deleteQuoteByQuoting, findQuoteByQuoting, insertStatusQuote } from "./quote-store";
import { findStatusById } from "./status-store";

/** The keys a note may name its quoted status by, in Mastodon's order; all but `quote` predate FEP-044f. */
const QUOTE_KEYS = ["quote", "_misskey_quote", "quoteUrl", "quoteUri"] as const;

/**
 * The status a note quotes, as Mastodon's `StatusParser#quote_uri`. `legacy`
 * when no `quote` key names it, as `legacy_quote?`.
 */
export type NoteQuoteRef = Readonly<{ uri: string; legacy: boolean }>;

const parseJsonObject = schemaResult(JsonObjectSchema);

export const noteQuoteRef = (raw: unknown): NoteQuoteRef | undefined => {
  const document = parseJsonObject(raw);
  if (document.isErr()) {
    return undefined;
  }
  const uri = QUOTE_KEYS.map((key) => refId(document.value[key])).find((id) => id !== undefined);
  return uri === undefined ? undefined : { uri, legacy: !Object.hasOwn(document.value, "quote") };
};

/**
 * Keep the quote a cached remote note makes in step with its document, as
 * Mastodon's `update_quote!`, for a quote of a local status. A quote of the
 * same local status keeps its state: our acceptance is authoritative, so the
 * note's `quoteAuthorization` is not read. A new quoted status starts over as
 * `Pending`, until its author answers a `QuoteRequest`. A note that quotes
 * nothing, or a remote status, keeps no quote; quotes between remote statuses
 * are not stored yet. A legacy quote is not stored either: Mastodon never
 * shows one until it is accepted, and only a `QuoteRequest` accepts it.
 */
export const syncRemoteQuote = async (
  db: D1Database,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  raw: unknown,
): Promise<Result<void, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  const existing = await findQuoteByQuoting(db, quoting);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const ref = noteQuoteRef(raw);
  const quotedId = ref && parseLocalStatusId(identity, ref.uri);
  const kept = existing.value?.quoted;
  if (kept?.kind === "LocalStatus" && kept.statusId === quotedId) {
    return ok(undefined);
  }
  if (existing.value) {
    const deleted = await deleteQuoteByQuoting(db, quoting);
    if (deleted.isErr()) {
      return deleted;
    }
  }
  if (!ref || ref.legacy || quotedId === undefined) {
    return ok(undefined);
  }
  const quoted = await findStatusById(db, quotedId);
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  if (quoted.value?.kind !== "LocalNote") {
    return ok(undefined);
  }
  return insertStatusQuote(db, {
    id: newEntityId(),
    quoting,
    quoted: StatusTarget.local(quoted.value.id),
    state: { kind: "Pending" },
    createdAt: nowInstant(),
  });
};
