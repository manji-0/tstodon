import type {
  InstanceIdentity,
  InstantRange,
  StatusSearchClause,
  StatusSearchQuery,
  StatusSearchScope,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountByUsername } from "./account-store";
import { SUPPRESSED_ACCOUNT_IDS_SQL, SUPPRESSED_ACTOR_URIS_SQL } from "./block-mute-store";
import { nowIso } from "./clock";
import { D1_MAX_BOUND_PARAMETERS, parseRows, type RepositoryError, runD1 } from "./d1";
import { DOMAIN_RESTRICTED_ACTORS_SQL, DOMAIN_SUSPENDED_ACTORS_SQL } from "./domain-hidden-actors";
import { findRemoteActorByHandle } from "./remote-actor-store";
import { SILENCED_UNFOLLOWED_OR_SUSPENDED_SQL } from "./status-timeline-store";

/**
 * The CJK characters the index sets apart (`status_search_rows` in migration
 * 0015 lists the same code points): Elasticsearch's `standard` tokenizer
 * makes each a token, where FTS5's `unicode61` reads an unspaced run as one.
 */
const CJK = /[々-〇぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ\u{20000}-\u{3FFFF}]/gu;

export const segmentCjk = (text: string): string => text.replace(CJK, " $& ");

/** Whether `unicode61` reads a token in the text. */
const hasToken = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/** An FTS5 string in `column`: the phrase of the text's tokens. */
const phrase = (column: "text" | "tags" | "scope", text: string): string =>
  `${column} : "${segmentCjk(text).replaceAll('"', '""')}"`;

/** A text clause as an FTS5 expression, `undefined` for one with no token. */
const textExpression = (clause: StatusSearchClause): string | undefined => {
  switch (clause.kind) {
    case "Words": {
      const words = clause.words.filter(hasToken);
      return words.length === 0
        ? undefined
        : words.map((word) => phrase("text", word)).join(" AND ");
    }
    case "Phrase": {
      const text = clause.words.join(" ");
      return hasToken(text) ? phrase("text", text) : undefined;
    }
    case "Tag":
      return hasToken(clause.name) ? phrase("tags", clause.name) : undefined;
    default:
      return undefined;
  }
};

const scopeExpression = (scope: StatusSearchScope, viewerId: string): string => {
  const library = phrase("scope", `v${viewerId}`);
  switch (scope) {
    case "Public":
      return phrase("scope", "p");
    case "Library":
      return library;
    case "All":
      return `${phrase("scope", "p")} OR ${library}`;
  }
};

/**
 * The FTS5 expression of a query: the notes in its scope that hold every
 * `Must` clause and no `MustNot` one. `undefined` when a `Must` clause has
 * no token, which Elasticsearch's `match` reads as matching nothing.
 */
export const matchExpression = (query: StatusSearchQuery, viewerId: string): string | undefined => {
  let expression = `(${scopeExpression(query.scope, viewerId)})`;
  const excluded: string[] = [];
  for (const clause of query.clauses) {
    if (clause.kind !== "Words" && clause.kind !== "Phrase" && clause.kind !== "Tag") {
      continue;
    }
    const text = textExpression(clause);
    if (clause.occurrence === "MustNot") {
      if (text !== undefined) {
        excluded.push(text);
      }
    } else if (text === undefined) {
      return undefined;
    } else {
      expression = `${expression} AND (${text})`;
    }
  }
  for (const text of excluded) {
    expression = `(${expression}) NOT (${text})`;
  }
  return expression;
};

/** Who a `from:` clause names, as this server holds them. */
type SearchAuthor =
  | Readonly<{ kind: "Local"; accountId: string }>
  | Readonly<{ kind: "Remote"; actorUri: string }>
  | Readonly<{ kind: "Unknown" }>;

/**
 * `account_id_from_term`: `me`, a local username (with or without this
 * server's domain), or a cached remote actor's handle. One that is not held
 * finds nothing.
 */
const resolveAuthor = async (
  db: D1Database,
  identity: InstanceIdentity,
  viewerId: string,
  clause: Extract<StatusSearchClause, { kind: "From" }>,
): Promise<Result<SearchAuthor, RepositoryError>> => {
  const author = clause.author;
  if (author.kind === "Viewer") {
    return ok({ kind: "Local", accountId: viewerId });
  }
  const domain = author.domain?.toLowerCase();
  if (
    domain === undefined ||
    domain === identity.domain ||
    domain === URL.parse(identity.publicOrigin)?.host
  ) {
    const local = await findAccountByUsername(db, author.username);
    return local.map((account) =>
      account === undefined ? { kind: "Unknown" } : { kind: "Local", accountId: account.id },
    );
  }
  const remote = await findRemoteActorByHandle(db, author.username, domain);
  return remote.map((actor) =>
    actor === undefined ? { kind: "Unknown" } : { kind: "Remote", actorUri: actor.actorUri },
  );
};

type Fragment = Readonly<{ sql: string; binds: ReadonlyArray<string> }>;

/** `searchable_properties`, for the local row (`statuses`) or the remote one (`r`). */
const PROPERTY_SQL: ReadonlyMap<string, Readonly<{ local: string; remote: string }>> = new Map(
  Object.entries({
    image: {
      local: `EXISTS (SELECT 1 FROM media_attachments m WHERE m.status_id = statuses.id
      AND m.content_type LIKE 'image/%' AND m.content_type <> 'image/gif')`,
      remote: `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(r.media_json) THEN r.media_json ELSE '[]' END) a
      WHERE json_extract(a.value, '$.mediaType') LIKE 'image/%'
        AND json_extract(a.value, '$.mediaType') <> 'image/gif')`,
    },
    video: {
      local: `EXISTS (SELECT 1 FROM media_attachments m WHERE m.status_id = statuses.id
      AND m.content_type LIKE 'video/%')`,
      remote: `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(r.media_json) THEN r.media_json ELSE '[]' END) a
      WHERE json_extract(a.value, '$.mediaType') LIKE 'video/%')`,
    },
    audio: {
      local: `EXISTS (SELECT 1 FROM media_attachments m WHERE m.status_id = statuses.id
      AND m.content_type LIKE 'audio/%')`,
      remote: `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(r.media_json) THEN r.media_json ELSE '[]' END) a
      WHERE json_extract(a.value, '$.mediaType') LIKE 'audio/%')`,
    },
    media: {
      local: "EXISTS (SELECT 1 FROM media_attachments m WHERE m.status_id = statuses.id)",
      remote: "r.media_json NOT IN ('[]', '')",
    },
    poll: { local: "statuses.poll_id IS NOT NULL", remote: "r.poll_json IS NOT NULL" },
    link: { local: "statuses.card_json IS NOT NULL", remote: "r.card_json IS NOT NULL" },
    embed: {
      local: `json_valid(statuses.card_json) AND json_extract(statuses.card_json, '$.type') = 'video'`,
      remote: `json_valid(r.card_json) AND json_extract(r.card_json, '$.type') = 'video'`,
    },
    sensitive: { local: "statuses.sensitive = 1", remote: "r.sensitive = 1" },
    reply: {
      local: "statuses.in_reply_to_id IS NOT NULL OR statuses.in_reply_to_uri IS NOT NULL",
      remote: "r.in_reply_to_uri IS NOT NULL",
    },
    quote: {
      local: "EXISTS (SELECT 1 FROM status_quotes q WHERE q.status_id = statuses.id)",
      remote: "EXISTS (SELECT 1 FROM status_quotes q WHERE q.remote_status_id = r.id)",
    },
  }),
);

/** The last instant a status id holds: its 63 bits less the 16 random low ones. */
const MAX_ID_MS = Number((1n << 47n) - 1n);

/** The lowest status id of a millisecond (`firstEntityIdAt`), as the index's integer rowid. */
const firstIdAt = (ms: number): string =>
  (
    BigInt(Math.min(MAX_ID_MS, Math.max(0, Math.trunc(Number.isFinite(ms) ? ms : 0)))) << 16n
  ).toString();

const rangeSql = (range: InstantRange): Fragment => {
  const parts: string[] = [];
  const binds: string[] = [];
  if (range.from !== undefined) {
    parts.push("status_search.rowid >= CAST(? AS INTEGER)");
    binds.push(firstIdAt(range.from));
  }
  if (range.until !== undefined) {
    parts.push("status_search.rowid < CAST(? AS INTEGER)");
    binds.push(firstIdAt(range.until));
  }
  return { sql: parts.length === 0 ? "1" : parts.join(" AND "), binds };
};

/**
 * `from:` as SQL. The unary `+` keeps the planner reading the note by its id
 * (the index's order) rather than walking the author's notes for each match.
 */
const authorSql = (author: SearchAuthor): Fragment => {
  switch (author.kind) {
    case "Local":
      return {
        sql: "(d.status_id IS NOT NULL AND +statuses.account_id = ?)",
        binds: [author.accountId],
      };
    case "Remote":
      return {
        sql: "(d.remote_status_id IS NOT NULL AND +r.actor_uri = ?)",
        binds: [author.actorUri],
      };
    case "Unknown":
      return { sql: "0", binds: [] };
  }
};

const negatable = (negated: boolean, fragment: Fragment): Fragment =>
  negated ? { sql: `NOT (${fragment.sql})`, binds: fragment.binds } : fragment;

/** A filter clause (`has:`, `is:`, `language:`, `from:`, a date) as SQL over the joined rows. */
const filterSql = (
  clause: StatusSearchClause,
  authors: ReadonlyMap<StatusSearchClause, SearchAuthor>,
): Fragment | undefined => {
  switch (clause.kind) {
    case "Property": {
      // An unknown property is no value a note has: it matches none, as Mastodon's term filter.
      const property = PROPERTY_SQL.get(clause.property);
      return negatable(clause.negated, {
        sql:
          property === undefined
            ? "0"
            : `COALESCE(CASE WHEN d.status_id IS NOT NULL THEN (${property.local}) ELSE (${property.remote}) END, 0)`,
        binds: [],
      });
    }
    case "Language":
      return {
        sql: `(CASE WHEN d.status_id IS NOT NULL THEN statuses.language ELSE r.language END) ${clause.negated ? "IS NOT" : "IS"} ?`,
        binds: [clause.code],
      };
    case "From":
      return negatable(clause.negated, authorSql(authors.get(clause) ?? { kind: "Unknown" }));
    case "Created":
      return negatable(clause.negated, rangeSql(clause.range));
    default:
      return undefined;
  }
};

/**
 * Mastodon's `StatusPolicy#show?` and `StatusFilter` for a local note, in
 * SQL: one the viewer may read (public and unlisted, its own, a
 * followers-only one of an account it follows, a direct or limited one that
 * mentions it), by an author it neither blocks nor mutes nor is blocked by,
 * not suspended, and silenced only when it follows the author.
 * Bind order: viewer ×2, suppressed ×4, viewer ×3.
 */
const LOCAL_SHOWN_SQL = `(
  1 ${SILENCED_UNFOLLOWED_OR_SUSPENDED_SQL}
  AND statuses.account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
  AND (
    statuses.visibility IN ('public', 'unlisted')
    OR statuses.account_id = ?
    OR (statuses.visibility = 'private' AND EXISTS (
      SELECT 1 FROM follows f WHERE f.follower_account_id = ?
        AND f.target_account_id = statuses.account_id AND f.kind = 'Accepted'
    ))
    OR (statuses.visibility IN ('direct', 'limited') AND EXISTS (
      SELECT 1 FROM status_mentions m WHERE m.status_id = statuses.id AND m.account_id = ?
    ))
  )
)`;

/**
 * The same for a remote note: public and unlisted ones, a followers-only one
 * of an actor the viewer follows, a direct or limited one that mentions it;
 * not by an actor it blocks or mutes or that blocks it, nor on a domain it
 * blocks or the instance suspends, and silenced only when it follows the
 * actor. Bind order: viewer, viewer, suppressed ×4, viewer, viewer, viewer.
 */
const REMOTE_SHOWN_SQL = `(
  (
    r.visibility IN ('public', 'unlisted')
    OR (r.visibility = 'private' AND EXISTS (
      SELECT 1 FROM outbound_follows o
      WHERE o.account_id = ? AND o.actor_uri = r.actor_uri AND o.state = 'Accepted'
    ))
    OR (r.visibility IN ('direct', 'limited') AND EXISTS (
      SELECT 1 FROM remote_status_mentions m WHERE m.status_id = r.id AND m.account_id = ?
    ))
  )
  AND r.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
  AND r.actor_uri NOT IN ${DOMAIN_SUSPENDED_ACTORS_SQL}
  AND (
    r.actor_uri NOT IN ${DOMAIN_RESTRICTED_ACTORS_SQL}
    OR EXISTS (
      SELECT 1 FROM outbound_follows o
      WHERE o.account_id = ? AND o.actor_uri = r.actor_uri AND o.state = 'Accepted'
    )
  )
)`;

/**
 * Whether a note is in `PublicStatusesIndex` as its author's `indexable`
 * stands now. The index's `p` follows a change of the flag a page at a time
 * (`reindexStaleAuthors`), so a match through `p` is checked here.
 */
const PUBLIC_NOW_SQL = `(CASE WHEN d.status_id IS NOT NULL THEN
  statuses.visibility = 'public' AND COALESCE(
    (SELECT p.indexable FROM account_profiles p WHERE p.account_id = statuses.account_id), 1
  ) <> 0
ELSE
  r.visibility = 'public' AND EXISTS (
    SELECT 1 FROM remote_actors a WHERE a.actor_uri = r.actor_uri
      AND json_valid(a.profile_json) AND json_extract(a.profile_json, '$.indexable') = 1
  )
END)`;

/**
 * Whether a note is in the viewer's library (`searchable_by`), which the
 * index's triggers keep in step. Binds the viewer 11 times.
 */
const LIBRARY_SQL = `(CASE WHEN d.status_id IS NOT NULL THEN
  statuses.account_id = ?
  OR EXISTS (SELECT 1 FROM status_mentions m
    WHERE m.status_id = statuses.id AND m.account_id = ? AND m.silent = 0)
  OR EXISTS (SELECT 1 FROM favourites f WHERE f.account_id = ? AND f.local_status_id = statuses.id)
  OR EXISTS (SELECT 1 FROM statuses b WHERE b.account_id = ? AND b.reblog_of_id = statuses.id)
  OR EXISTS (SELECT 1 FROM bookmarks k WHERE k.account_id = ? AND k.local_status_id = statuses.id)
  OR EXISTS (SELECT 1 FROM polls p JOIN poll_votes v ON v.poll_id = p.id
    WHERE p.status_id = statuses.id AND v.account_id = ?)
ELSE
  EXISTS (SELECT 1 FROM remote_status_mentions m
    WHERE m.status_id = r.id AND m.account_id = ? AND m.silent = 0)
  OR EXISTS (SELECT 1 FROM favourites f WHERE f.account_id = ? AND f.remote_status_id = r.id)
  OR EXISTS (SELECT 1 FROM statuses b WHERE b.account_id = ? AND b.reblog_of_remote_id = r.id)
  OR EXISTS (SELECT 1 FROM bookmarks k WHERE k.account_id = ? AND k.remote_status_id = r.id)
  OR EXISTS (SELECT 1 FROM remote_poll_own_votes v WHERE v.status_id = r.id AND v.account_id = ?)
END)`;

/** What the scope keeps of the index's matches, as the flags stand now. */
const scopeSql = (scope: StatusSearchScope, viewerId: string): Fragment => {
  switch (scope) {
    case "All":
      return {
        sql: `(${PUBLIC_NOW_SQL} OR ${LIBRARY_SQL})`,
        binds: Array.from({ length: 11 }, () => viewerId),
      };
    case "Public":
      return { sql: PUBLIC_NOW_SQL, binds: [] };
    case "Library":
      return { sql: "1", binds: [] };
  }
};

/**
 * Elasticsearch's `index.max_result_window`: a search past its 10,000th
 * result fails, which Mastodon answers with no status.
 */
const MAX_RESULT_WINDOW = 10_000;

/** The bound parameters of the statement besides the scope's and the filters'. */
const OWN_BINDS = 21;

const IdRow = z.object({
  status_id: z.string().nullable(),
  remote_status_id: z.string().nullable(),
});

/**
 * The ids of the notes `query` finds for `viewerId`, newest first, as
 * Mastodon's `StatusesSearchService` with Elasticsearch: public notes by
 * `indexable` authors and the notes in the viewer's library that match, which
 * the viewer may see and `StatusFilter` keeps. The filter runs before
 * `OFFSET`, so a page skips only what the viewer sees.
 *
 * The index is read newest first (its rowid is the status id), so a page
 * reads the matches from the newest until it has `offset + limit` that pass
 * the filters, and sorts nothing.
 */
export const searchStatusIds = async (
  db: D1Database,
  identity: InstanceIdentity,
  viewerId: string,
  query: StatusSearchQuery,
  limit: number,
  offset: number,
): Promise<Result<string[], RepositoryError>> => {
  const match = matchExpression(query, viewerId);
  if (match === undefined || offset + limit > MAX_RESULT_WINDOW) {
    return ok([]);
  }
  // A query of so many filters that the statement would pass D1's bound
  // parameters finds nothing; this is known before any `from:` is looked up.
  const filterBindsAtMost = query.clauses.reduce(
    (count, clause) =>
      count +
      (clause.kind === "Created"
        ? 2
        : clause.kind === "Language" || clause.kind === "From"
          ? 1
          : 0),
    0,
  );
  const scope = scopeSql(query.scope, viewerId);
  if (OWN_BINDS + scope.binds.length + filterBindsAtMost > D1_MAX_BOUND_PARAMETERS) {
    return ok([]);
  }
  // Each account named once is looked up once.
  const resolved = new Map<string, SearchAuthor>();
  const authors = new Map<StatusSearchClause, SearchAuthor>();
  for (const clause of query.clauses) {
    if (clause.kind === "From") {
      const key = JSON.stringify(clause.author);
      const known = resolved.get(key);
      const author =
        known === undefined ? await resolveAuthor(db, identity, viewerId, clause) : ok(known);
      if (author.isErr()) {
        return err(author.error);
      }
      resolved.set(key, author.value);
      authors.set(clause, author.value);
    }
  }
  const filters = query.clauses.flatMap((clause) => filterSql(clause, authors) ?? []);
  const filterBinds = filters.flatMap((filter) => filter.binds);
  const now = nowIso();
  return runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT d.status_id, d.remote_status_id
         FROM status_search
         CROSS JOIN status_search_documents d ON d.id = status_search.rowid
         LEFT JOIN statuses ON statuses.id = d.status_id
         LEFT JOIN remote_statuses r ON r.id = d.remote_status_id
         WHERE status_search MATCH ?
           AND (d.status_id IS NULL OR ${LOCAL_SHOWN_SQL})
           AND (d.remote_status_id IS NULL OR ${REMOTE_SHOWN_SQL})
           AND ${scope.sql}
           ${filters.map((filter) => `AND ${filter.sql}`).join("\n           ")}
         ORDER BY status_search.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(
        match,
        ...[viewerId, viewerId],
        ...[viewerId, viewerId, viewerId, now],
        ...[viewerId, viewerId, viewerId],
        ...[viewerId, viewerId],
        ...[viewerId, viewerId, viewerId, now],
        viewerId,
        viewerId,
        viewerId,
        ...scope.binds,
        ...filterBinds,
        limit,
        offset,
      )
      .all();
    return parseRows(IdRow, results).flatMap((row) => row.status_id ?? row.remote_status_id ?? []);
  });
};
