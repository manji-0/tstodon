/**
 * What the sweep's scenario files share: the response shapes they read, the
 * client API call, the step recorder and the lookups both servers answer.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sleep, type E2eUser } from "../lib.js";

/** The Mastodon users `bootstrap.sh` provisions; each scenario file signs up its own tstodon users. */
export type Cast = Readonly<{
  /** Unique per run, for post texts. */
  stamp: string;
  /** The tstodon users of the base scenarios follow mona, and she follows them. */
  mona: E2eUser;
  /** No tstodon user keeps a follow of carol: tstodon sees her posts only when it fetches them. */
  carol: E2eUser;
  /** The follow scenarios lock dana and leave her tstodon followers. */
  dana: E2eUser;
  /** No tstodon user ever follows erin. */
  erin: E2eUser;
  /** The Mastodon user with the longest username Mastodon allows (30 characters). */
  longName: E2eUser;
}>;

export const Account = z.looseObject({
  id: z.string(),
  username: z.string(),
  acct: z.string(),
  uri: z.string(),
  display_name: z.string(),
  followers_count: z.number(),
});
export const Poll = z.looseObject({
  id: z.string(),
  votes_count: z.number(),
  options: z.array(z.looseObject({ title: z.string(), votes_count: z.number().nullable() })),
});
export const BaseStatus = z.looseObject({
  id: z.string(),
  uri: z.string(),
  content: z.string(),
  visibility: z.string(),
  url: z.string().nullish(),
  in_reply_to_id: z.string().nullable(),
  favourites_count: z.number(),
  reblogs_count: z.number(),
  edited_at: z.string().nullable(),
  account: z.looseObject({ uri: z.string() }),
  poll: Poll.nullish(),
  media_attachments: z.array(
    z.looseObject({ type: z.string(), description: z.string().nullable() }),
  ),
  mentions: z.array(z.looseObject({ acct: z.string() })),
  tags: z.array(z.looseObject({ name: z.string() })),
  emojis: z.array(z.looseObject({ shortcode: z.string() })),
  quote: z
    .looseObject({ state: z.string(), quoted_status: z.looseObject({ uri: z.string() }).nullish() })
    .nullish(),
});
export const Status = BaseStatus.extend({ reblog: BaseStatus.nullish() });
export type Status = z.infer<typeof Status>;
export const Statuses = z.array(Status);
export const Notifications = z.array(
  z.looseObject({
    type: z.string(),
    account: z.looseObject({ uri: z.string() }),
    status: z.looseObject({ uri: z.string() }).nullish(),
  }),
);
export const Context = z.looseObject({ ancestors: Statuses, descendants: Statuses });
export const Search = z.looseObject({ accounts: z.array(Account), statuses: Statuses });
export const Relationships = z.array(
  z.looseObject({
    following: z.boolean(),
    followed_by: z.boolean(),
    requested: z.boolean(),
    requested_by: z.boolean().optional(),
  }),
);
export const Conversations = z.array(
  z.looseObject({
    id: z.string(),
    accounts: z.array(z.looseObject({ uri: z.string() })),
    last_status: z.looseObject({ uri: z.string(), visibility: z.string() }).nullish(),
  }),
);
export const Accounts = z.array(Account);
export const Media = z.looseObject({ id: z.string(), url: z.string().nullable() });
export const Anything = z.unknown();

export class StepFailure extends Error {}

/** Call a client API endpoint as `user`; a non-2xx answer or an unexpected body fails the step. */
export const call = async <T>(
  user: E2eUser,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; form?: FormData } = {},
): Promise<T> => {
  const method = init.method ?? "GET";
  const request: RequestInit =
    init.form !== undefined
      ? { method, headers: user.headers, body: init.form }
      : init.body !== undefined
        ? {
            method,
            headers: { ...user.headers, "Content-Type": "application/json" },
            body: JSON.stringify(init.body),
          }
        : { method, headers: user.headers };
  let response = await fetch(`${user.origin}${path}`, request);
  // Mastodon allows a user 1500 API requests per five minutes (Rack::Attack);
  // a second sweep right after the first reaches that. Wait for the window.
  const reset = Date.parse(response.headers.get("x-ratelimit-reset") ?? "");
  if (response.status === 429 && Number.isFinite(reset)) {
    const wait = Math.min(Math.max(reset - Date.now(), 0) + 1000, 330_000);
    console.log(`     rate limited as ${user.username}: waiting ${Math.round(wait / 1000)} s`);
    await response.arrayBuffer();
    await sleep(wait);
    response = await fetch(`${user.origin}${path}`, request);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new StepFailure(
      `${init.method ?? "GET"} ${user.origin}${path} → ${response.status} ${text.slice(0, 300)}`,
    );
  }
  const parsed = schema.safeParse(text.length > 0 ? JSON.parse(text) : undefined);
  if (!parsed.success) {
    throw new StepFailure(
      `${path} on ${user.origin}: ${z.prettifyError(parsed.error)} in ${text.slice(0, 300)}`,
    );
  }
  return parsed.data;
};

export const eventually = async <T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (let tries = 1; ; tries += 1) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new StepFailure(`${label}: not within ${timeoutMs} ms`);
    }
    await sleep(tries < 6 ? 500 : 1500);
  }
};

export const results: Array<{
  name: string;
  outcome: "ok" | "FAIL" | "gap" | "skip";
  detail: string;
}> = [];
/** Record a step that this run's configuration cannot exercise. */
export const skip = (name: string, reason: string): void => {
  results.push({ name, outcome: "skip", detail: reason });
  console.log(`skip ${name}\n     ${reason}`);
};

export const step = async (name: string, run: () => Promise<void>): Promise<boolean> => {
  try {
    await run();
    results.push({ name, outcome: "ok", detail: "" });
    console.log(`ok   ${name}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "FAIL", detail });
    console.log(`FAIL ${name}\n     ${detail}`);
    return false;
  }
};

/**
 * A step that fails for a gap `tracked` names (an `INT-*` row of
 * `docs/planning/open-todos.md`). Its failure is recorded as a known gap and
 * does not fail the sweep. Once it passes it fails the sweep, so the marker
 * is dropped with the fix.
 */
export const knownGap = async (
  name: string,
  tracked: string,
  run: () => Promise<void>,
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "gap", detail: `${tracked}: ${detail}` });
    console.log(`gap  ${name} (${tracked})\n     ${detail}`);
    return;
  }
  const detail = `passes now: make it a plain step and close the gap in ${tracked}`;
  results.push({ name, outcome: "FAIL", detail });
  console.log(`FAIL ${name}\n     ${detail}`);
};

export const post = (user: E2eUser, body: Record<string, unknown>): Promise<Status> =>
  call(user, "/api/v1/statuses", Status, {
    method: "POST",
    body: { visibility: "public", ...body },
  });

/** `viewer`'s copy of the status with this URI, resolved through search. */
export const resolveStatus = (viewer: E2eUser, uri: string): Promise<Status> =>
  eventually(`${viewer.username} resolves ${uri}`, async () => {
    const query = new URLSearchParams({ q: uri, resolve: "true", type: "statuses" });
    const found = await call(viewer, `/api/v2/search?${query.toString()}`, Search);
    return found.statuses.find((status) => status.uri === uri);
  });

/** `viewer`'s copy once it arrived by delivery: on the home timeline, never fetched. */
export const onHome = (
  viewer: E2eUser,
  uri: string,
  accept: (status: Status) => boolean = () => true,
) =>
  eventually(`${uri} on ${viewer.username}'s home`, async () => {
    const home = await call(viewer, "/api/v1/timelines/home?limit=40", Statuses);
    return home.find((status) => status.uri === uri && accept(status));
  });

export const notified = (user: E2eUser, type: string, from: E2eUser, statusUri?: string) =>
  eventually(`${user.username} is notified of ${type}`, async () => {
    const list = await call(user, `/api/v1/notifications?types[]=${type}&limit=40`, Notifications);
    return list.find(
      (item) =>
        item.type === type &&
        item.account.uri === from.uri &&
        (statusUri === undefined || item.status?.uri === statusUri),
    );
  });

export const resolveAccount = async (viewer: E2eUser, target: E2eUser) => {
  const query = new URLSearchParams({ q: target.acct, resolve: "true", type: "accounts" });
  const found = await call(viewer, `/api/v2/search?${query.toString()}`, Search);
  const account = found.accounts.find((candidate) => candidate.uri === target.uri);
  if (!account) {
    throw new StepFailure(`${viewer.username} cannot resolve ${target.acct}`);
  }
  return account;
};

export const relationship = async (viewer: E2eUser, accountId: string) => {
  const [state] = await call(
    viewer,
    `/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
    Relationships,
  );
  if (!state) {
    throw new StepFailure("no relationship");
  }
  return state;
};

export const follow = async (follower: E2eUser, followed: E2eUser): Promise<string> => {
  const account = await resolveAccount(follower, followed);
  await call(follower, `/api/v1/accounts/${account.id}/follow`, Anything, {
    method: "POST",
    body: {},
  });
  await eventually(`${followed.acct} accepts`, async () =>
    (await relationship(follower, account.id)).following ? true : undefined,
  );
  return account.id;
};

/** The same interaction, sent from each server to the other. */
export const bothWays = async (
  name: string,
  alice: E2eUser,
  mona: E2eUser,
  run: (from: E2eUser, to: E2eUser) => Promise<void>,
): Promise<void> => {
  await step(`${name}: tstodon → Mastodon`, () => run(alice, mona));
  await step(`${name}: Mastodon → tstodon`, () => run(mona, alice));
};

/** The first relationship state of `viewer` to the account that `accept` takes. */
export const relationshipBecomes = (
  viewer: E2eUser,
  accountId: string,
  label: string,
  accept: (state: z.infer<typeof Relationships>[number]) => boolean,
) =>
  eventually(label, async () => {
    const state = await relationship(viewer, accountId);
    return accept(state) ? state : undefined;
  });

/** `user`'s conversation whose last status has this URI. */
export const conversationOf = (user: E2eUser, statusUri: string) =>
  eventually(`${user.username} has the conversation of ${statusUri}`, async () => {
    const conversations = await call(user, "/api/v1/conversations?limit=40", Conversations);
    return conversations.find((entry) => entry.last_status?.uri === statusUri);
  });

/** `viewer`'s thread around its copy of a status. */
export const contextOf = (viewer: E2eUser, statusId: string) =>
  call(viewer, `/api/v1/statuses/${statusId}/context`, Context);

const composeDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * How many GET requests Mastodon's web process logged for `path` since
 * `since`, read from the container's log. `undefined` when Docker is not
 * reachable from this process.
 */
export const mastodonGetCount = (path: string, since: Date): number | undefined => {
  let log: string;
  try {
    log = execFileSync(
      "docker",
      ["compose", "logs", "--no-log-prefix", "--since", since.toISOString(), "web"],
      { cwd: composeDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return undefined;
  }
  return log.split("\n").filter((line) => line.includes(`method=GET path=${path} `)).length;
};
