import {
  type CoveredHosts,
  InstanceIdentity,
  type OutboxJob,
  ProfileField,
  RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountProfile } from "./account-profile-store";
import { findAccountById } from "./account-store";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { checkFederatedHost } from "./federated-fetch";
import {
  listRemoteActorsDueLinkCheck as listRemoteActorsDueLinkCheckSql,
  markLocalProfileFieldVerified as markLocalProfileFieldVerifiedSql,
  markRemoteActorLinksChecked as markRemoteActorLinksCheckedSql,
  markRemoteProfileFieldVerified as markRemoteProfileFieldVerifiedSql,
} from "./generated/prisma/sql";
import { parseJsonColumn } from "./json-column";
import { fetchGuarded } from "./link-card";
import { measureJobPage } from "./metrics";
import { decodeEntities } from "./remote-actor-fetch";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { queryTyped, runTyped } from "./typed-sql";

type VerifyProfileLinks = Extract<OutboxJob, { kind: "VerifyProfileLinks" }>;

type FetchOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  blockedHosts?: CoveredHosts;
}>;

/** Mastodon's `Request`: three redirects, and the linked page is read up to 1 MB (`truncated_body`). */
const PAGE_FETCH = { redirects: 3, timeoutMs: 10_000, accept: "text/html" } as const;
const PAGE_BYTES = 1024 * 1024;

/** Fields checked by one job; the rest are left to the next. */
const CHECKS_PER_JOB = 4;

/** Actors listed per page of the hourly look for profiles to check, and pages per run. */
const DUE_PAGE = 100;
const DUE_PAGES_PER_RUN = 10;

/** HTML elements without an end tag, which hold nothing. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * Call `onEnd` when the element closes; false for one without an end tag: a
 * void element, or a self-closing one (`<path/>` in SVG), on which lol-html's
 * `onEndTag` throws.
 */
const onEndOf = (element: Element, onEnd: () => void): boolean => {
  if (VOID_ELEMENTS.has(element.tagName)) {
    return false;
  }
  try {
    element.onEndTag(onEnd);
    return true;
  } catch {
    return false;
  }
};

const htmlResponse = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html" } });

/**
 * The link a remote field's HTML value is checked for, as Mastodon's
 * `Account::Field#extract_url_from_html`: the value is one `<a>` and nothing
 * else, whose `href` is its text (a value Mastodon formats from a bare URL).
 */
export const remoteFieldLink = async (html: string): Promise<string | undefined> => {
  let depth = 0;
  let children = 0;
  let tag = "";
  let href: string | null = null;
  let text = "";
  try {
    await new HTMLRewriter()
      .on("*", {
        element: (element) => {
          if (depth === 0) {
            children += 1;
            tag = element.tagName;
            href = element.getAttribute("href");
          }
          if (
            onEndOf(element, () => {
              depth -= 1;
            })
          ) {
            depth += 1;
          }
        },
      })
      .onDocument({
        text: (chunk) => {
          if (chunk.text.length === 0) {
            return;
          }
          if (depth === 0) {
            children += 1;
          } else {
            text += chunk.text;
          }
        },
      })
      .transform(htmlResponse(html))
      .text();
  } catch {
    return undefined;
  }
  const link = href === null ? undefined : decodeEntities(href);
  return children === 1 && tag === "a" && link === decodeEntities(text) ? link : undefined;
};

/** The `href` of each `<a>` and `<link>` whose `rel` includes `me`, in document order. */
const relMeLinks = async (page: Response): Promise<ReadonlyArray<string>> => {
  const links: string[] = [];
  const collect = {
    element: (element: Element) => {
      const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      const href = element.getAttribute("href");
      if (rel.includes("me") && href !== null) {
        links.push(decodeEntities(href));
      }
    },
  };
  await new HTMLRewriter().on("a[rel]", collect).on("link[rel]", collect).transform(page).text();
  return links;
};

/** A body's text, read until it passes `limit` bytes, as Mastodon's `truncated_body`. */
const truncatedText = async (body: ReadableStream, limit: number): Promise<string> => {
  // An identity transform types the chunks, which the runtime's body leaves untyped.
  const reader = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (read > limit) {
      await reader.cancel();
      return text + decoder.decode();
    }
  }
};

/**
 * Where `url` redirects to, without following it: Mastodon's
 * `link_redirects_back?` asks with a HEAD. Undefined when the host is refused
 * or the request fails.
 */
const redirectOf = async (
  url: string,
  identity: InstanceIdentity,
  options: FetchOptions,
): Promise<string | undefined> => {
  if (!URL.canParse(url) || !/^https?:/.test(url)) {
    return undefined;
  }
  const target = new URL(url);
  if ((await checkFederatedHost(target.hostname, identity.domain, options)) !== "Admitted") {
    return undefined;
  }
  try {
    const response = await fetch(target, {
      method: "HEAD",
      headers: { "User-Agent": `tstodon (${identity.publicOrigin})` },
      redirect: "manual",
      signal: AbortSignal.timeout(PAGE_FETCH.timeoutMs),
    });
    await response.body?.cancel();
    return response.headers.get("location") ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether the page at `url` links back to the profile at `linkBack`, as
 * Mastodon's `VerifyLinkService`: it answers 200 (after up to three
 * redirects), and one of its `rel="me"` links is `linkBack` (ignoring case),
 * or else its first `rel="me"` link redirects to exactly `linkBack`. A page
 * that cannot be fetched does not link back.
 */
const linksBack = async (
  url: string,
  linkBack: string,
  identity: InstanceIdentity,
  options: FetchOptions,
): Promise<boolean> => {
  try {
    const fetched = await fetchGuarded(new URL(url), identity, options, PAGE_FETCH);
    if (fetched.kind !== "Response") {
      return false;
    }
    const { response } = fetched;
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return false;
    }
    const links = await relMeLinks(htmlResponse(await truncatedText(response.body, PAGE_BYTES)));
    if (links.some((link) => link.toLowerCase() === linkBack.toLowerCase())) {
      return true;
    }
    const [first] = links;
    return first !== undefined && (await redirectOf(first, identity, options)) === linkBack;
  } catch {
    return false;
  }
};

/** The profile a job checks: its fields, the link they must link back to, and how a field is marked. */
type CheckedProfile = Readonly<{
  fields: ReadonlyArray<ProfileField>;
  linkBack: string;
  linkOf: (field: ProfileField) => Promise<string | undefined>;
  markVerified: (
    index: number,
    value: string,
    at: string,
  ) => Promise<Result<void, RepositoryError>>;
}>;

const localProfile = async (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
): Promise<Result<CheckedProfile | undefined, RepositoryError>> => {
  const account = await findAccountById(db, accountId);
  if (account.isErr()) {
    return err(account.error);
  }
  if (account.value === undefined) {
    return ok(undefined);
  }
  const { username } = account.value;
  const profile = await findAccountProfile(db, accountId);
  return profile.map((found) => ({
    fields: found.fields,
    // Mastodon's `short_account_url`.
    linkBack: InstanceIdentity.profileUrl(identity, username),
    linkOf: async (field) => field.value,
    markVerified: async (index, value, at) =>
      (
        await runD1(() =>
          runTyped(db, markLocalProfileFieldVerifiedSql(at, accountId, index, value)),
        )
      ).map(() => undefined),
  }));
};

const remoteProfile = async (
  db: D1Database,
  actorUri: string,
): Promise<Result<CheckedProfile | undefined, RepositoryError>> => {
  const [actor, moderation] = await Promise.all([
    findRemoteActorByUri(db, actorUri),
    getRemoteActorModeration(db, actorUri),
  ]);
  if (actor.isErr()) {
    return err(actor.error);
  }
  if (moderation.isErr()) {
    return err(moderation.error);
  }
  // Mastodon does not check the links of a suspended account.
  if (actor.value === undefined || moderation.value.standing.kind === "Suspended") {
    return ok(undefined);
  }
  return ok({
    fields: actor.value.profile.fields,
    // Mastodon's `url_for` of a remote account: its `url` on its own host, else its URI.
    linkBack: RemoteActor.profileUrl(actor.value),
    linkOf: (field) => remoteFieldLink(field.value),
    markVerified: async (index, value, at) =>
      (
        await runD1(() =>
          runTyped(db, markRemoteProfileFieldVerifiedSql(at, actorUri, index, value)),
        )
      ).map(() => undefined),
  });
};

/**
 * Queue the check of a local account's field links, as Mastodon's
 * `UpdateAccountService#check_links`, when one of `fields` waits for it.
 */
export const queueProfileLinkCheck = async (
  env: Env,
  account: VerifyProfileLinks["account"],
  fields: ReadonlyArray<ProfileField>,
): Promise<void> => {
  if (!fields.some((field) => ProfileField.requiresVerification(field, field.value))) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({ kind: "VerifyProfileLinks", account, fromIndex: 0 });
  } catch {
    console.error(JSON.stringify({ kind: "ProfileLinkCheckNotQueued", account: account.kind }));
  }
};

/**
 * Queue job: check the links of an account's fields from `fromIndex` on, as
 * Mastodon's `VerifyAccountLinksWorker`, and mark each field whose page links
 * back verified, unless its value changed meanwhile. A failed check is not
 * retried; the next change of the profile checks again.
 */
export const processVerifyProfileLinksJob = (
  env: Env,
  job: VerifyProfileLinks,
): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      return { outcome: "ok", size: 0, chained: false };
    }
    const profile =
      job.account.kind === "LocalAccount"
        ? await localProfile(env.DB, identity.value, job.account.accountId)
        : await remoteProfile(env.DB, job.account.actorUri);
    if (profile.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    if (profile.value === undefined) {
      return { outcome: "ok", size: 0, chained: false };
    }
    const options = {
      allowHosts: await federationAllowHosts(env),
      blockedHosts: await suspendedDomains(env.DB),
    };
    const { fields, linkBack, linkOf, markVerified } = profile.value;
    let checked = 0;
    for (let index = job.fromIndex; index < fields.length; index += 1) {
      const field = fields[index];
      if (field === undefined) {
        continue;
      }
      const url = await linkOf(field);
      if (url === undefined || !ProfileField.requiresVerification(field, url)) {
        continue;
      }
      if (checked === CHECKS_PER_JOB) {
        // A job that cannot queue the rest runs again from where it stopped.
        try {
          await env.OUTBOX_PROCESS_QUEUE.send({ ...job, fromIndex: index });
        } catch {
          return { outcome: "retry", size: checked, chained: false };
        }
        return { outcome: "ok", size: checked, chained: true };
      }
      checked += 1;
      if (
        (await linksBack(url, linkBack, identity.value, options)) &&
        (await markVerified(index, field.value, nowIso())).isErr()
      ) {
        return { outcome: "retry", size: checked, chained: false };
      }
    }
    return { outcome: "ok", size: checked, chained: false };
  });

const DueActorRow = z.object({
  actor_uri: z.string(),
  profile_json: z.string(),
  fetched_at: z.string(),
});

const ProfileFieldsOnly = z.object({ fields: z.array(ProfileField.schema).default([]) });

/**
 * Hourly cron path: queue a `VerifyProfileLinks` job for each remote actor
 * whose document was fetched since its links were last looked at and one of
 * whose fields may hold a link to check, as Mastodon's
 * `ProcessAccountService#check_links!` queues one each time it processes
 * the actor. Each processing stores the fields without their verification,
 * so they are checked again. A page is marked looked at once its jobs are
 * queued.
 */
export const queueDueProfileLinkChecks = async (env: Env): Promise<void> => {
  for (let page = 0; page < DUE_PAGES_PER_RUN; page += 1) {
    const listed = await runD1(() =>
      queryTyped(env.DB, listRemoteActorsDueLinkCheckSql(DUE_PAGE), DueActorRow),
    );
    if (listed.isErr() || listed.value.length === 0) {
      return;
    }
    const jobs = listed.value.flatMap((row) => {
      const profile = parseJsonColumn(ProfileFieldsOnly, row.profile_json);
      const waiting =
        profile.isOk() &&
        profile.value.fields.some(
          (field) => field.verifiedAt === undefined && field.value.includes("https://"),
        );
      return waiting
        ? [
            {
              body: {
                kind: "VerifyProfileLinks",
                account: { kind: "RemoteActor", actorUri: row.actor_uri },
                fromIndex: 0,
              } as const satisfies OutboxJob,
            },
          ]
        : [];
    });
    try {
      if (jobs.length > 0) {
        await env.OUTBOX_PROCESS_QUEUE.sendBatch(jobs);
      }
    } catch {
      console.error(JSON.stringify({ kind: "ProfileLinkChecksNotQueued", actors: jobs.length }));
      return;
    }
    const marked = await runD1(() =>
      runTyped(
        env.DB,
        markRemoteActorLinksCheckedSql(
          JSON.stringify(listed.value.map((row) => [row.actor_uri, row.fetched_at])),
        ),
      ),
    );
    if (marked.isErr() || listed.value.length < DUE_PAGE) {
      return;
    }
  }
};
