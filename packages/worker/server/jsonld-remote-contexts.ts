import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { type FederatedHostOptions, fetchJsonLdContext } from "./federated-fetch";
import { parseJsonColumn } from "./json-column";
import type { RemoteContexts } from "./ld-signature";

/** How long a fetched context is kept, as Mastodon's `jsonld:context:<url>` cache entry. */
export const JSONLD_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The most contexts tstodon does not ship that one document may name, those
 * the named contexts name included. Mastodon sets no bound; a forward names
 * one or two in practice, and each costs a fetch.
 */
export const MAX_REMOTE_CONTEXTS = 5;

export const FIND_JSONLD_CONTEXT_SQL =
  "SELECT document_json FROM jsonld_contexts WHERE url = ? AND fetched_at >= ?";
export const DELETE_EXPIRED_JSONLD_CONTEXTS_SQL =
  "DELETE FROM jsonld_contexts WHERE fetched_at < ?";

const ContextRow = z.object({ document_json: z.string() });
const ContextDocument = z.record(z.string(), z.unknown());

/** The context fetched from `url` since `fetchedSince`, as it was fetched. */
export const findJsonLdContext = async (
  db: D1Database,
  url: string,
  fetchedSince: string,
): Promise<Result<Readonly<Record<string, unknown>> | undefined, RepositoryError>> => {
  const rows = await runD1(async () => {
    const found = await db.prepare(FIND_JSONLD_CONTEXT_SQL).bind(url, fetchedSince).all();
    return parseRows(ContextRow, found.results);
  });
  if (rows.isErr()) {
    return err(rows.error);
  }
  const [row] = rows.value;
  return row === undefined ? ok(undefined) : parseJsonColumn(ContextDocument, row.document_json);
};

/**
 * Keep the context fetched from `url`, and forget those fetched before
 * `expiredBefore`, which no lookup would take.
 */
export const storeJsonLdContext = (
  db: D1Database,
  url: string,
  documentJson: string,
  fetchedAt: string,
  expiredBefore: string,
): Promise<Result<D1Result[], RepositoryError>> =>
  runD1Batch(db, [
    db.prepare(DELETE_EXPIRED_JSONLD_CONTEXTS_SQL).bind(expiredBefore),
    db
      .prepare(
        `INSERT INTO jsonld_contexts (url, document_json, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET document_json = excluded.document_json,
           fetched_at = excluded.fetched_at`,
      )
      .bind(url, documentJson, fetchedAt),
  ]);

/**
 * The context at `url`: kept from a fetch in the last 30 days, else fetched
 * and kept, as Mastodon's `load_jsonld_context` (`Rails.cache.fetch` with
 * `expires_in: 30.days`). A failed fetch is not kept, so the next document
 * naming it tries again, as in Mastodon.
 */
const loadRemoteContext = async (
  db: D1Database,
  identity: InstanceIdentity,
  options: FederatedHostOptions,
  url: string,
  now: Date,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const expiredBefore = new Date(now.getTime() - JSONLD_CONTEXT_TTL_MS).toISOString();
  const kept = await findJsonLdContext(db, url, expiredBefore);
  if (kept.isOk() && kept.value !== undefined) {
    return kept.value;
  }
  const fetched = await fetchJsonLdContext(identity, url, options);
  if (fetched.isErr()) {
    console.warn(
      JSON.stringify({ kind: "JsonLdContextNotLoaded", url, reason: fetched.error.kind }),
    );
    return undefined;
  }
  const stored = await storeJsonLdContext(
    db,
    url,
    fetched.value.json,
    now.toISOString(),
    expiredBefore,
  );
  if (stored.isErr()) {
    console.error(JSON.stringify({ kind: "JsonLdContextNotKept", url }));
  }
  return fetched.value.document;
};

/**
 * The contexts tstodon does not ship, for processing one document: each URL
 * loaded once ({@link loadRemoteContext}), so the compaction, expansion and
 * canonicalization of a check all read the same document, and at most
 * {@link MAX_REMOTE_CONTEXTS} of them; any further one fails the document.
 */
export const remoteContextsFor = (
  db: D1Database,
  identity: InstanceIdentity,
  options: FederatedHostOptions,
  now: Date = new Date(),
): RemoteContexts => {
  const loaded = new Map<string, Promise<Readonly<Record<string, unknown>> | undefined>>();
  return (url) => {
    const known = loaded.get(url);
    if (known !== undefined) {
      return known;
    }
    if (loaded.size >= MAX_REMOTE_CONTEXTS) {
      return Promise.resolve(undefined);
    }
    const loading = loadRemoteContext(db, identity, options, url, now);
    loaded.set(url, loading);
    return loading;
  };
};
