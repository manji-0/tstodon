# Status search

<!-- constrained-by ./d1-heavy-scenarios.md#6-search-and-tag-reads -->

`GET /api/v2/search` (and v1's `/api/v1/search`) finds statuses through an FTS5 index in D1 and applies the rules of Mastodon v4.7.5's status search with Elasticsearch enabled. This page records what Mastodon does, what tstodon matches, and how the index stays correct and cheap.

## What Mastodon v4.7.5 does

`SearchService#perform_statuses_search!` calls `StatusesSearchService` only when `status_searchable?` holds: `Chewy.enabled? && status_search? && @account.present?`. So:

- **Elasticsearch disabled (the default, `ES_ENABLED` unset).** Mastodon finds no status at all, for anyone. Search returns accounts, hashtags and the one status a URL with `resolve=true` names.
- **Signed out.** No status, with Elasticsearch or without.
- **Signed in, Elasticsearch enabled.** `SearchQueryTransformer::Query#request` searches two indexes and keeps a document when `default_filter` allows it:
  - `PublicStatusesIndex` holds `Status.indexable`: statuses that are not boosts, have `public` visibility, and whose author (local or remote) has `indexable` set (`Status::SearchConcern`). A remote account's `indexable` is its actor document's flag, false when absent.
  - `StatusesIndex` holds every kept status that is not a boost, with `searchable_by`: its author when the author is local, and the local accounts it mentions (not silent mentions), that favourited, boosted or bookmarked it, or that voted in its poll. A document is kept only for an account in that list.
- The results are ordered by id, newest first (`order(id: :desc)`), deduplicated across the two indexes (`collapse(field: :id)`), and paged with `offset` and `limit` (`offset` only when `type` is given). `StatusFilter` then drops each result the viewer may not see (`StatusPolicy#show?`), or whose author the viewer blocks, mutes, domain-blocks, or which is silenced and not followed. So a Mastodon page can come back shorter than `limit`.
- The `text` field is `searchable_text`: the content warning, the content as plain text, the poll options and the media descriptions, joined. It is analysed twice: `verbatim` (URL- and email-aware tokens, lowercased) and `content` (lowercased, ASCII-folded, English stemming, stop words dropped). A word matches either one.

### Query syntax

`SearchQueryParser` reads `(clause space?)*`. A clause is an optional `+` or `-`, an optional `prefix:`, and a term, a `"quoted phrase"` or a `:shortcode:`. A lone `"` is dropped. A query the grammar cannot read (`cat :`, `- cat`) raises `Parslet::ParseFailed`, and the search returns no status. `SearchService` first replaces curly quotes and `「」『』《》«»` with `"`.

| Clause                                                                                                    | Meaning in Mastodon                                                                         |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `word`, `+word`                                                                                           | Every token of the word appears in `text` (`multi_match`, `operator: and`)                  |
| `-word`                                                                                                   | The word does not appear                                                                    |
| `"two words"`                                                                                             | The words appear in that order (`match_phrase`)                                             |
| `#tag`                                                                                                    | The status has the hashtag                                                                  |
| `has:` / `is:` `image`, `video`, `audio`, `media`, `poll`, `link`, `embed`, `sensitive`, `reply`, `quote` | `searchable_properties`; `-has:` negates                                                    |
| `language:xx`                                                                                             | The status language, normalised to a supported locale (`en-US` → `en`)                      |
| `from:me`, `from:user`, `from:@user@domain`                                                               | The author; an account the server does not hold matches nothing                             |
| `before:`, `after:`, `during:`                                                                            | The creation time against an ISO 8601 date or epoch milliseconds, in the viewer's time zone |
| `in:library`, `in:public`                                                                                 | Only `StatusesIndex`, or only `PublicStatusesIndex`; anything else searches both            |
| any other `prefix:term`                                                                                   | The words `prefix` and `term`                                                               |

A date without a time is a whole day: Elasticsearch fills a missing time with the day's first instant for `lt` and `gte`, and its last for `gt` and `lte`. So `before:D` is before day D, `after:D` is after day D, and `during:D` is day D.

## What tstodon matches, and why

tstodon matches Mastodon with Elasticsearch enabled, for a signed-in viewer.

Matching the default (no Elasticsearch) would mean removing status search, which tstodon serves today and which the web UI offers (`search_enabled` is true in the initial state, `server/web-app.ts`). The Elasticsearch behaviour is the one Mastodon documents for users, and the one a Mastodon user meets on any server that offers status search. FTS5 makes it affordable on D1 without another service. Matching it also closes the privacy gaps of the old search: it found any public or unlisted local note, so a post by an author who opted out of search (`indexable: false`) was still found, and followers-only posts of followed accounts were found by text although Mastodon indexes them only for the accounts that interacted with them.

What follows from that choice:

- A signed-out request finds no status. Accounts and hashtags are still searched.
- A signed-in viewer finds public notes by `indexable` authors (local or remote), and the notes in its library: its own notes of any visibility, notes that mention it, and notes it favourited, boosted, bookmarked or voted in. A followers-only or unlisted note it never touched is not found.
- Each result also passes `StatusPolicy#show?` and `StatusFilter`, in SQL, before `OFFSET`.

### Deviations

- **Short pages.** The filters run before `OFFSET`, so a page holds `limit` visible results while there are more. Mastodon filters after paging. This was already the case before the index.
- **Time zone.** tstodon keeps no time zone per account, so dates are UTC days.
- **Date bound.** `before:`, `after:` and `during:` compare the status id, whose high bits are its creation instant. A remote note received live has the instant it was received, which is seconds or minutes after its `published`. Mastodon compares `created_at`, which for a remote note is `published`.
- **Tokenizing.** FTS5's `porter unicode61 remove_diacritics 2` tokenizer lowercases, folds accents and stems English, close to Mastodon's `content` analyser. It keeps stop words and does not split on URLs the way `uax_url_email` does. `unicode61` reads an unspaced run of CJK as one token, where Elasticsearch's `standard` tokenizer makes each Han or kana character one: the index sets each such character apart with spaces, and so does the query, so `東京` finds `東京タワー` as a phrase of adjacent characters (Elasticsearch matches the characters anywhere in the text).
- **Words in one clause.** A term is matched as a phrase of its tokens (`foo-bar` needs `foo` then `bar`); Elasticsearch takes the tokens anywhere.
- **Hashtags.** A `#tag` clause matches the note's stored tag names (`local_status_tags`, `remote_status_tags`), lowercased and folded, and stemmed like the text. Mastodon's `hashtag` analyser also splits `CamelCase` names.
- **Media types.** `has:image` is an `image/*` attachment other than GIF, `has:video` a `video/*` one, `has:audio` an `audio/*` one. Mastodon reads its own attachment types, where a GIF is `gifv`.
- **`account_id`, `min_id`, `max_id`.** Mastodon's deprecated search parameters are not read.
- **`:shortcode:`.** Mastodon's transformer raises on a bare shortcode clause (a server error); tstodon reads it as the word.
- **Inputs that fail in Mastodon.** Where Elasticsearch or the parser fails and Mastodon answers no status, tstodon answers no status too: a date a JavaScript `Date` cannot hold (`after:` and 310 digits), a date before 1970, and a page past Elasticsearch's `max_result_window` (`offset + limit` over 10,000). An unknown `has:` / `is:` value matches no note (`-has:` of one matches every note), as Mastodon's term filter does; `has:__proto__` is such a value.
- **Many filters.** A query whose filters would pass D1's 100 bound parameters (about 70 `from:`, `language:` or date clauses) finds no status. This is checked before any `from:` account is looked up, and each distinct account is looked up once. Mastodon has no such bound.

## How it works

### Data

Migration `0015_status_search.sql` adds:

- `status_search_documents`: one row per searchable note, local (`status_id`) or remote (`remote_status_id`). Its `id` is the status id as an integer, so the index's rowid orders as status ids do. `content_text` holds a remote note's content as plain text, which only the Worker can compute from HTML (`htmlToText`).
- `status_search`: a contentless FTS5 table (`content=''`, `contentless_delete=1`) with three columns. `text` is `searchable_text`. `tags` holds the hashtag names. `scope` holds `p` when the note is in `PublicStatusesIndex`, and `v<account id>` for each local account whose library holds it.
- `status_search_sources` and `status_search_rows`: the views that compute a row of the index from the tables it is read from. `status_search_rows` sets CJK characters apart.

### Keeping the index in step

Every write that changes a row of the index goes through a trigger that deletes the note's index row by rowid and inserts it again from `status_search_rows`.

- A local note: inserted with its document (`status_search_local_added`). Edits of `content_text`, `spoiler_text`, `visibility` or `poll_id`, its media (insert, `status_id`, `description`, delete), its poll (insert, option titles, delete) and its tags write the row again.
- A remote note: `remoteSearchDocumentStatements` (`server/status-search-documents.ts`) writes its document in the batch that writes the note (`upsertRemoteStatus`, `overwriteRemoteStatus`). Changes to its content warning, visibility, media, poll or actor, and to its tags, write the row again.
- The library: inserts and deletes of mentions (and changes of `silent`), favourites, bookmarks, local boosts, local poll votes and local votes in remote polls write the row of the note they name.
- `indexable`: an author may have more public notes than one statement should write. A change of a local account's `account_profiles.indexable`, or of the flag in a remote actor's `profile_json`, only marks the author in `status_search_stale_authors`. The `BackfillStatusSearch` job writes that author's public notes' rows again, 100 a page, before its other work (`reindexStaleAuthors`); a new change restarts the walk. Until the walk has passed a note, the query reads the author's flag itself: a note matched as public is kept only when the author is `indexable` now, or when the note is in the viewer's library. So a note never shows through a stale `p`; a note of an author that just became `indexable` is found once the job has reached it.
- A deleted note deletes its document through the foreign key, and the document's delete trigger deletes the index row.

The migration indexes the local notes it finds. The remote notes cached before it are indexed by the `BackfillStatusSearch` job, which the hourly cron runs (and which queues its next page while there is work): it walks `remote_statuses` by id from the `status_search` row of `backfill_cursors`, 100 a page, and sets the cursor to `~` (after every id) when a page comes back short. After that the job reads only the cursor.

### Query cost

`searchStatusIds` (`server/status-search-store.ts`) sends one statement. The FTS5 expression is the scope (`scope : p OR scope : "v<viewer>"`, or one of them for `in:`) AND the `Must` text clauses, NOT each `MustNot` one. The statement reads the index ordered by rowid, newest first, which FTS5 serves without sorting. It seeks each match's document, local or remote row, and the rows the filters read by key, and stops once it has `offset + limit` results that pass. Because `indexable` and the library are part of the index, the notes the index returns are almost all ones the viewer may see. Per row the statement checks visibility, blocks, mutes and moderation, and the author's `indexable` as it is now (then, only for a note whose author is not `indexable`, the viewer's library), each by key. A page reads at most 10,000 results deep (`max_result_window`). `status-filter-sql-plan.test.ts` checks the plan: an FTS5 scan in rowid order with no sort of its own, the document by primary key, and each note by id.

A trigger's write costs one lookup per table the row is read from, and one pass over the characters of text that is not all ASCII. A note's row is written several times while it is posted (the note, then each attachment and tag).

### Storage

The index is contentless, so the text is not stored twice. A remote note's plain-text content is stored once more in `status_search_documents.content_text`, beside its HTML.

### Backups

D1's own export format refuses a database with a virtual table. The [backup workflow](../operations/runbook.md#scheduled-d1-backups) exports with `--compatibility sqlite3_cli_only`, the SQLite CLI's `.dump`, which D1 cannot import as is; `scripts/d1-dump-for-import.mjs` turns it into SQL D1 imports and rebuilds the index from its source tables. The converter fails, and exits non-zero, on a schema write it does not recognise (it reads `sqlite_schema` and `sqlite_master` and quoted names), on a virtual table it has no rebuild for, and on an empty result. The workflow converts each dump and imports the result into a scratch local D1 database before it encrypts the dump, so a backup that would not restore fails the run.
