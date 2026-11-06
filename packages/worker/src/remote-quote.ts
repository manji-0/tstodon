import { schemaResult } from "@tstodon/core";
import {
  type InstanceIdentity,
  type QuoteState,
  type QuoteValue,
  type RemoteStatusValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { parseLocalStatusId } from "./activitypub";
import { JsonObjectSchema, refId } from "./activitypub-wire";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import type { FederatedFetchOptions } from "./federated-fetch";
import { newEntityId } from "./ids";
import {
  deleteQuoteByQuoting,
  findQuoteByQuoting,
  insertStatusQuote,
  saveQuoteState,
} from "./quote-store";
import { verifyRemoteQuote } from "./remote-quote-verify";
import { findStatusById } from "./status-store";

/** The keys a note may name its quoted status by, in Mastodon's order; all but `quote` predate FEP-044f. */
const QUOTE_KEYS = ["quote", "_misskey_quote", "quoteUrl", "quoteUri"] as const;

/**
 * The status a note quotes, as Mastodon's `StatusParser#quote_uri`. `legacy`
 * when no `quote` key names it, as `legacy_quote?`. `approvalUri` is the
 * first `quoteAuthorization`, by id when inlined.
 */
export type NoteQuoteRef = Readonly<{
  uri: string;
  legacy: boolean;
  approvalUri: string | undefined;
}>;

const parseJsonObject = schemaResult(JsonObjectSchema);

export const noteQuoteRef = (raw: unknown): NoteQuoteRef | undefined => {
  const document = parseJsonObject(raw);
  if (document.isErr()) {
    return undefined;
  }
  const uri = QUOTE_KEYS.map((key) => refId(document.value[key])).find((id) => id !== undefined);
  return uri === undefined
    ? undefined
    : {
        uri,
        legacy: !Object.hasOwn(document.value, "quote"),
        approvalUri: refId(document.value["quoteAuthorization"]),
      };
};

/** How a quote of a remote status reaches the network: its quoted note and its stamp. */
export type RemoteQuoteContext = Readonly<{
  /** The cached remote status at `uri`, fetched and stored when it may be. */
  resolveQuoted: (uri: string) => Promise<Result<RemoteStatusValue | undefined, RepositoryError>>;
  fetchOptions: FederatedFetchOptions;
}>;

const forget = async (
  db: D1Database,
  quoting: StatusTargetValue,
  existing: QuoteValue | undefined,
): Promise<Result<void, RepositoryError>> =>
  existing ? deleteQuoteByQuoting(db, quoting) : ok(undefined);

const newQuote = (quoting: StatusTargetValue, quoted: StatusTargetValue, state: QuoteState) => ({
  id: newEntityId(),
  quoting,
  quoted,
  state,
  createdAt: nowInstant(),
});

/**
 * A quote of a local status. The same quoted status keeps its state: our
 * acceptance is authoritative, so the note's `quoteAuthorization` is not
 * read. A new quoted status starts over as `Pending`, until its author
 * answers a `QuoteRequest`.
 */
const syncLocalQuoted = async (
  db: D1Database,
  quoting: StatusTargetValue,
  existing: QuoteValue | undefined,
  ref: NoteQuoteRef,
  quotedId: string,
): Promise<Result<void, RepositoryError>> => {
  const kept = existing?.quoted;
  if (kept?.kind === "LocalStatus" && kept.statusId === quotedId) {
    return ok(undefined);
  }
  const forgotten = await forget(db, quoting, existing);
  if (forgotten.isErr() || ref.legacy) {
    return forgotten;
  }
  const quoted = await findStatusById(db, quotedId);
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  if (quoted.value?.kind !== "LocalNote") {
    return ok(undefined);
  }
  return insertStatusQuote(
    db,
    newQuote(quoting, StatusTarget.local(quoted.value.id), { kind: "Pending" }),
  );
};

/**
 * Whether a quote of the same remote status keeps its state: the quoted
 * author revoked it, it is a self-quote, or it was accepted on the stamp the
 * note still names.
 */
const keepsState = (state: QuoteState, approvalUri: string | undefined): boolean => {
  switch (state.kind) {
    case "Revoked":
      return true;
    case "Accepted":
      return state.approval.kind === "Implicit" || state.approval.uri === approvalUri;
    default:
      return false;
  }
};

/**
 * A quote of a remote status, verified with {@link verifyRemoteQuote}. A
 * quoted note that cannot be found or fetched keeps no quote: a quote row
 * names its quoted status. A changed stamp, or a quote not yet accepted, is
 * verified again; a changed quoted status starts over under a new quote id.
 */
const syncRemoteQuoted = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  existing: QuoteValue | undefined,
  ref: NoteQuoteRef,
  context: RemoteQuoteContext,
): Promise<Result<void, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  const quoted = await context.resolveQuoted(ref.uri);
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  if (!quoted.value) {
    return forget(env.DB, quoting, existing);
  }
  const target = StatusTarget.remote(quoted.value.id);
  const same =
    existing?.quoted.kind === "RemoteStatus" && existing.quoted.statusId === target.statusId
      ? existing
      : undefined;
  if (same && keepsState(same.state, ref.approvalUri)) {
    return ok(undefined);
  }
  const state = await verifyRemoteQuote(
    identity,
    { quoting: status, quoted: quoted.value, approvalUri: ref.approvalUri },
    context.fetchOptions,
  );
  if (same) {
    return saveQuoteState(env.DB, { ...same, state });
  }
  const forgotten = await forget(env.DB, quoting, existing);
  if (forgotten.isErr()) {
    return forgotten;
  }
  return insertStatusQuote(env.DB, newQuote(quoting, target, state));
};

/**
 * Keep the quote a cached remote note makes in step with its document, as
 * Mastodon's `update_quote!` and `VerifyQuoteService`. A note that quotes
 * nothing keeps no quote. A legacy quote of a new status is not stored
 * either: Mastodon never shows one until it is accepted, and for a local
 * status only a `QuoteRequest` accepts it.
 */
export const syncRemoteQuote = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  raw: unknown,
  context: RemoteQuoteContext,
): Promise<Result<void, RepositoryError>> => {
  const quoting = StatusTarget.remote(status.id);
  const existing = await findQuoteByQuoting(env.DB, quoting);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const ref = noteQuoteRef(raw);
  const quotedId = ref && parseLocalStatusId(identity, ref.uri);
  if (ref && quotedId !== undefined) {
    return syncLocalQuoted(env.DB, quoting, existing.value, ref, quotedId);
  }
  if (ref && !ref.legacy) {
    return syncRemoteQuoted(env, identity, status, existing.value, ref, context);
  }
  return forget(env.DB, quoting, existing.value);
};
