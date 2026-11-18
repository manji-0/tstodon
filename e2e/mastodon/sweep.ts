/**
 * What the sweep's scenario files share: the response shapes they read, the
 * client API call, the step recorder and the lookups both servers answer.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appToken, sleep, type E2eUser } from "../lib.js";
import { mastodonUser } from "./lib.js";

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
  note: z.string(),
  avatar: z.string(),
  header: z.string(),
  locked: z.boolean(),
  bot: z.boolean(),
  fields: z.array(z.looseObject({ name: z.string(), value: z.string() })),
  emojis: z.array(z.looseObject({ shortcode: z.string(), url: z.string() })),
  moved: z.looseObject({ uri: z.string() }).nullish(),
  followers_count: z.number(),
});
export const Poll = z.looseObject({
  id: z.string(),
  votes_count: z.number(),
  voters_count: z.number().nullish(),
  multiple: z.boolean(),
  expired: z.boolean(),
  expires_at: z.string().nullable(),
  voted: z.boolean().optional(),
  own_votes: z.array(z.number()).optional(),
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
  spoiler_text: z.string(),
  sensitive: z.boolean(),
  favourited: z.boolean().optional(),
  reblogged: z.boolean().optional(),
  account: z.looseObject({ uri: z.string() }),
  poll: Poll.nullish(),
  media_attachments: z.array(
    z.looseObject({
      id: z.string(),
      type: z.string(),
      description: z.string().nullable(),
      url: z.string().nullable(),
      preview_url: z.string().nullable(),
      blurhash: z.string().nullish(),
      meta: z
        .looseObject({
          focus: z.looseObject({ x: z.number(), y: z.number() }).optional(),
          original: z
            .looseObject({ width: z.number().optional(), height: z.number().optional() })
            .optional(),
        })
        .nullish(),
    }),
  ),
  mentions: z.array(z.looseObject({ acct: z.string() })),
  tags: z.array(z.looseObject({ name: z.string() })),
  emojis: z.array(z.looseObject({ shortcode: z.string(), url: z.string() })),
  quote: z
    .looseObject({ state: z.string(), quoted_status: z.looseObject({ uri: z.string() }).nullish() })
    .nullish(),
});
export const Status = BaseStatus.extend({ reblog: BaseStatus.nullish() });
export type Status = z.infer<typeof Status>;
export const Statuses = z.array(Status);
export type Poll = z.infer<typeof Poll>;
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
    blocked_by: z.boolean().optional(),
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

/**
 * `fetch` as `user`, once more after the rate-limit window when the answer is
 * a 429. Mastodon allows a user 1500 API requests per five minutes
 * (Rack::Attack); a second sweep right after the first reaches that.
 */
export const fetchWaitingOutRateLimit = async (
  user: E2eUser,
  path: string,
  request: RequestInit = { headers: user.headers },
): Promise<Response> => {
  const response = await fetch(`${user.origin}${path}`, request);
  const reset = Date.parse(response.headers.get("x-ratelimit-reset") ?? "");
  if (response.status !== 429 || !Number.isFinite(reset)) {
    return response;
  }
  const wait = Math.min(Math.max(reset - Date.now(), 0) + 1000, 330_000);
  console.log(`     rate limited as ${user.username}: waiting ${Math.round(wait / 1000)} s`);
  await response.arrayBuffer();
  await sleep(wait);
  return fetch(`${user.origin}${path}`, request);
};

/** Vite's error page for a request it could not hand to workerd. */
const isDevTransportFailure = (body: string): boolean =>
  body.includes("<title>Error</title>") && body.includes('"message":"fetch failed"');

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
  let response = await fetchWaitingOutRateLimit(user, path, request);
  let text = await response.text();
  // `vp dev` answers 500 with its own error page when its connection to
  // workerd drops ("fetch failed"): the request never reached the Worker.
  // Read requests are safe to send again; anything else fails the step.
  if (method === "GET" && response.status === 500 && isDevTransportFailure(text)) {
    console.log(`     dev server lost its connection to workerd on GET ${path}: retrying once`);
    await sleep(500);
    response = await fetch(`${user.origin}${path}`, request);
    text = await response.text();
  }
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

/** How long `eventually` waits when its caller names no time; `knownGap` shortens it. */
let patienceMs = 20_000;

export const eventually = async <T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = patienceMs,
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
 * is dropped with the fix. The step is expected to time out, so its waits
 * are shorter than a plain step's.
 */
export const knownGap = async (
  name: string,
  tracked: string,
  run: () => Promise<void>,
): Promise<void> => {
  const patience = patienceMs;
  patienceMs = 8000;
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, outcome: "gap", detail: `${tracked}: ${detail}` });
    console.log(`gap  ${name} (${tracked})\n     ${detail}`);
    return;
  } finally {
    patienceMs = patience;
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

/**
 * The same interaction, sent from each server to the other. `gaps` names the
 * tracked gap of a direction that is known to fail (`knownGap`).
 */
export const bothWays = async (
  name: string,
  alice: E2eUser,
  mona: E2eUser,
  run: (from: E2eUser, to: E2eUser) => Promise<void>,
  gaps: Readonly<{ toMastodon?: string; toTstodon?: string }> = {},
): Promise<void> => {
  const directions = [
    [`${name}: tstodon → Mastodon`, gaps.toMastodon, alice, mona],
    [`${name}: Mastodon → tstodon`, gaps.toTstodon, mona, alice],
  ] as const;
  for (const [label, tracked, from, to] of directions) {
    await (tracked === undefined
      ? step(label, () => run(from, to))
      : knownGap(label, tracked, () => run(from, to)));
  }
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
const repositoryRoot = dirname(dirname(composeDirectory));

const run = (command: string, args: readonly string[], cwd: string, input?: string): string => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StepFailure(`${command} ${args.slice(0, 6).join(" ")}: ${detail.slice(-800)}`);
  }
};

/**
 * Run a Ruby script in Mastodon's Rails environment (`rails runner`, about
 * ten seconds), for what its client API does not offer: an account
 * migration, an account deletion, a poll that ends in seconds. Its standard
 * output.
 */
export const mastodonRails = (script: string): string =>
  run(
    "docker",
    ["compose", "exec", "-T", "web", "bin/rails", "runner", "-"],
    composeDirectory,
    script,
  );

/**
 * Fresh Mastodon users for one run, made by `provision.rb` as the standing
 * ones are. A scenario that changes an account for good (a move, a deletion)
 * uses these. A name ending in `_admin` gets the Owner role.
 */
export const mastodonUsers = async (names: readonly string[]): Promise<E2eUser[]> => {
  const out = run(
    "docker",
    ["compose", "exec", "-T", "web", "bin/rails", "runner", "/provision.rb", ...names],
    composeDirectory,
  );
  const users: E2eUser[] = [];
  for (const name of names) {
    const token = out
      .split("\n")
      .find((line) => line.startsWith(`PROVISIONED ${name} `))
      ?.split(" ")[2];
    if (!token) {
      throw new StepFailure(`provision.rb made no token for ${name}: ${out.slice(-300)}`);
    }
    process.env[`E2E_MASTODON_TOKEN_${name.toUpperCase()}`] = token;
    users.push(await mastodonUser(name));
  }
  return users;
};

/**
 * Give a tstodon user the admin role, as an operator does in the database;
 * the same user with a token for the admin API.
 */
export const tstodonAdmin = async (user: E2eUser): Promise<E2eUser> => {
  run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "tstodon-e2e-mastodon",
      "--local",
      "--config",
      "e2e/mastodon/tstodon.wrangler.jsonc",
      "--persist-to",
      ".wrangler/e2e-mastodon",
      "--command",
      `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE id = '${user.id}')`,
    ],
    repositoryRoot,
  );
  const headers = await appToken(
    user.origin,
    user.browser,
    "read write follow push admin:read admin:write",
    user.username,
  );
  return { ...user, headers };
};

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
