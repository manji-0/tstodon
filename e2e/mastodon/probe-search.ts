/**
 * Sweep area INT-1: what search resolves from a URL or an acct, each way,
 * and the remote interaction a WebFinger `subscribe` template opens.
 */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Account,
  bothWays,
  call,
  type Cast,
  mastodonGetCount,
  mastodonRails,
  post,
  Search,
  step,
  StepFailure,
} from "./sweep.js";

const search = (viewer: E2eUser, q: string, type?: "accounts" | "statuses") => {
  const query = new URLSearchParams({ q, resolve: "true", ...(type ? { type } : {}) });
  return call(viewer, `/api/v2/search?${query.toString()}`, Search);
};

/** The search answers exactly this account, and no status. */
const expectOnlyAccount = (found: z.infer<typeof Search>, target: E2eUser, q: string): void => {
  if (found.accounts.length !== 1 || found.accounts[0]?.uri !== target.uri) {
    throw new StepFailure(
      `q=${q} answered accounts ${JSON.stringify(found.accounts.map((account) => account.uri))}`,
    );
  }
  if (found.statuses.length > 0) {
    throw new StepFailure(`q=${q} answered ${found.statuses.length} statuses beside the account`);
  }
};

const pageUrl = (user: E2eUser): string => `${user.origin}/@${user.username}`;

export const searchScenarios = async ({ stamp, carol, dana, longName }: Cast): Promise<void> => {
  const viewer = await signUp(A, "sven");
  const local = await signUp(A, "lars");
  const longLocal = await signUp(A, "long-interop-name-check");
  const mastodonViewer = dana;

  await step("search resolves a profile page URL, no type: tstodon → Mastodon", async () => {
    const since = new Date(Date.now() - 1000);
    const q = pageUrl(longName);
    expectOnlyAccount(await search(viewer, q), longName, q);
    const pageGets = mastodonGetCount(new URL(q).pathname, since);
    const actorGets = mastodonGetCount(new URL(longName.uri).pathname, since);
    if (pageGets !== undefined && actorGets !== undefined && (pageGets > 1 || actorGets > 1)) {
      throw new StepFailure(
        `Mastodon served ${q} ${pageGets} times and ${longName.uri} ${actorGets} times for one search`,
      );
    }
  });

  await step("search resolves a profile page URL, no type: Mastodon → tstodon", async () => {
    const q = pageUrl(local);
    expectOnlyAccount(await search(mastodonViewer, q), local, q);
  });

  await step("search resolves an actor URI in one fetch: tstodon → Mastodon", async () => {
    const since = new Date(Date.now() - 1000);
    expectOnlyAccount(await search(viewer, carol.uri), carol, carol.uri);
    const gets = mastodonGetCount(new URL(carol.uri).pathname, since);
    if (gets !== undefined && gets > 1) {
      throw new StepFailure(`Mastodon served ${carol.uri} ${gets} times for one search`);
    }
  });

  await step("search resolves an actor URI: Mastodon → tstodon", async () => {
    expectOnlyAccount(await search(mastodonViewer, local.uri), local, local.uri);
  });

  await bothWays(
    "search resolves a post's page URL (/@user/id)",
    local,
    carol,
    async (author, other) => {
      const reader = other === carol ? mastodonViewer : viewer;
      const sent = await post(author, { status: `find me by page URL ${stamp}` });
      const q = `${author.origin}/@${author.username}/${sent.id}`;
      if (q === sent.uri) {
        throw new StepFailure(`the page URL is the post's URI: ${q}`);
      }
      const found = await search(reader, q);
      if (found.statuses.length !== 1 || found.statuses[0]?.uri !== sent.uri) {
        throw new StepFailure(
          `q=${q} answered statuses ${JSON.stringify(found.statuses.map((status) => status.uri))}`,
        );
      }
      if (found.accounts.length > 0) {
        throw new StepFailure(`q=${q} answered ${found.accounts.length} accounts beside the post`);
      }
    },
  );

  await bothWays(
    "search resolves @user@host and user@host",
    local,
    carol,
    async (target, other) => {
      const reader = other === carol ? mastodonViewer : viewer;
      for (const q of [target.acct, target.acct.slice(1)]) {
        const found = await search(reader, q, "accounts");
        if (found.accounts[0]?.uri !== target.uri) {
          throw new StepFailure(
            `q=${q} answered ${JSON.stringify(found.accounts.map((account) => account.uri))}`,
          );
        }
      }
    },
  );

  await bothWays(
    "accounts/lookup finds a resolved user@host",
    local,
    carol,
    async (target, other) => {
      const reader = other === carol ? mastodonViewer : viewer;
      await search(reader, target.acct, "accounts");
      const acct = target.acct.slice(1);
      const found = await call(
        reader,
        `/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
        Account,
      );
      if (found.uri !== target.uri) {
        throw new StepFailure(`acct=${acct} answered ${found.uri}`);
      }
    },
  );

  for (const [server, reader, target] of [
    ["tstodon", viewer, local],
    ["Mastodon", mastodonViewer, carol],
  ] as const) {
    await step(`search names a local account by its full acct and URLs: ${server}`, async () => {
      // Mastodon 4.7.5 does not look up its own `/ap/users/<id>` actor URIs.
      const uris = server === "tstodon" ? [target.uri] : [];
      for (const q of [target.acct, target.acct.slice(1), pageUrl(target), ...uris]) {
        const found = await search(reader, q);
        const [account] = found.accounts;
        if (found.accounts.length !== 1 || account?.id !== target.id) {
          throw new StepFailure(
            `q=${q} answered ${JSON.stringify(found.accounts.map((entry) => [entry.id, entry.acct]))}, not ${target.id}`,
          );
        }
        if (account.acct !== target.username) {
          throw new StepFailure(`q=${q} answered the acct ${account.acct}, not ${target.username}`);
        }
      }
    });
  }

  await bothWays("accounts/search resolves user@host", local, carol, async (target, other) => {
    const reader = other === carol ? mastodonViewer : viewer;
    const query = new URLSearchParams({ q: target.acct.slice(1), resolve: "true" });
    const found = await call(
      reader,
      `/api/v1/accounts/search?${query.toString()}`,
      z.array(Account),
    );
    if (found[0]?.uri !== target.uri) {
      throw new StepFailure(`answered ${JSON.stringify(found.map((account) => account.uri))}`);
    }
  });

  await step(
    "Mastodon's WebFinger of a tstodon user names /authorize_interaction, which opens a Mastodon post",
    async () => {
      const acct = local.acct.slice(1);
      const template = mastodonRails(`
        puts Webfinger.new(${JSON.stringify(`acct:${acct}`)}).perform
          .link("http://ostatus.org/schema/1.0/subscribe", "template")
      `).trim();
      if (template !== `${local.origin}/authorize_interaction?uri={uri}`) {
        throw new StepFailure(`Mastodon read the subscribe template ${JSON.stringify(template)}`);
      }
      const sent = await post(carol, { status: `interact with me from tstodon ${stamp}` });
      const page = sent.url ?? sent.uri;
      const opened = new URL(template.replace("{uri}", encodeURIComponent(page)));
      const response = await local.browser(opened.pathname + opened.search);
      const location = response.headers.get("location") ?? "";
      const id = /^\/@carol@[^/]+\/(\d+)$/.exec(location)?.[1];
      if (response.status !== 302 || id === undefined) {
        throw new StepFailure(`${page} answered ${response.status} to ${JSON.stringify(location)}`);
      }
      const shown = await call(local, `/api/v1/statuses/${id}`, z.looseObject({ uri: z.string() }));
      if (shown.uri !== sent.uri) {
        throw new StepFailure(`${location} is ${shown.uri}, not ${sent.uri}`);
      }
    },
  );

  await bothWays("a long acct resolves", longLocal, longName, async (target, other) => {
    const reader = other === longName ? mastodonViewer : viewer;
    const found = await search(reader, target.acct, "accounts");
    const account = found.accounts.find((candidate) => candidate.uri === target.uri);
    if (!account) {
      throw new StepFailure(`q=${target.acct} (${target.acct.length} bytes) resolved nothing`);
    }
    const expected = target.acct.slice(1);
    if (account.acct !== expected) {
      throw new StepFailure(`the account's acct is ${account.acct}, not ${expected}`);
    }
    const again = await search(reader, target.acct.slice(1), "accounts");
    if (again.accounts[0]?.id !== account.id) {
      throw new StepFailure(`the second lookup of ${expected} answered another account`);
    }
  });
};
