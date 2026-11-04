import { OutboxJob, type ImportModeValue, type ImportTypeValue } from "@tstodon/domain";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ORIGIN, signUp } from "../test/passkey-browser";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { blockAccount, muteAccount } from "./block-mute-store";
import { type Entry, listEntriesPage } from "./csv-entries-store";
import {
  IMPORT_PAGE_DELAY_SECONDS,
  IMPORT_PAGE_SIZE,
  processCsvImportJob,
  startCsvImport,
} from "./csv-import-apply";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseImportFile } from "./csv-import-file";
import { createCsvImport, findCsvImport, IMPORTS_KEPT, listFailedRows } from "./csv-import-store";
import { blockDomain } from "./domain-block-store";
import { followAccount } from "./follow-store";
import { newEntityId } from "./ids";
import { addListMembers, createList } from "./list-store";
import { insertOutboundFollow, updateOutboundFollowOptions } from "./outbound-follow-store";
import { parseInstanceIdentity } from "./runtime-config";
import { bookmarkStatus } from "./status-interaction-store";

type User = Readonly<{
  name: string;
  id: string;
  fetcher: Awaited<ReturnType<typeof signUp>>["fetcher"];
}>;

const user = async (name: string): Promise<User> => {
  const { fetcher } = await signUp(name);
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE username = ?")
    .bind(name)
    .first<{ id: string }>();
  if (!row) {
    throw new Error(`no account ${name}`);
  }
  return { name, id: row.id, fetcher };
};

const identity = () => {
  const parsed = parseInstanceIdentity(env);
  if (parsed.isErr()) {
    throw new Error("identity");
  }
  return parsed.value;
};

type Sent = Readonly<{ job: OutboxJob; delaySeconds: number | undefined }>;

/** The Worker's env with a queue that records what is sent to it, for driving import jobs by hand. */
const queueEnv = () => {
  const sent: Sent[] = [];
  const queue = {
    send: async (message: unknown, options?: { delaySeconds?: number }) => {
      const job = OutboxJob.parse(message);
      if (job.isOk()) {
        sent.push({ job: job.value, delaySeconds: options?.delaySeconds });
      }
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) => (key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key)),
  });
  return { env: proxied, sent };
};

type Queue = ReturnType<typeof queueEnv>;

/** Run the next queued import job; its job, or `undefined` when none is queued. */
const step = async (queue: Queue) => {
  const next = queue.sent.find((entry) => entry.job.kind === "ProcessCsvImport");
  if (!next || next.job.kind !== "ProcessCsvImport") {
    return undefined;
  }
  queue.sent.splice(queue.sent.indexOf(next), 1);
  expect(await processCsvImportJob(queue.env, next.job)).toBe("ok");
  return next;
};

const drain = async (queue: Queue) => {
  for (let guard = 0; guard < 1000; guard += 1) {
    if (!(await step(queue))) {
      return;
    }
  }
  throw new Error("import did not finish");
};

const startImport = async (
  queue: Queue,
  owner: User,
  type: ImportTypeValue["kind"],
  mode: ImportModeValue["kind"],
  text: string,
): Promise<string> => {
  const lines = parseImportFile({ kind: type }, new TextEncoder().encode(text), {
    localDomain: identity().domain,
    publicOrigin: identity().publicOrigin,
  });
  if (lines.isErr()) {
    throw new Error(lines.error.kind);
  }
  const created = await createCsvImport(env.DB, {
    accountId: owner.id,
    type: { kind: type },
    mode: { kind: mode },
    lines: lines.value,
  });
  if (created.isErr() || !created.value) {
    throw new Error("import not created");
  }
  if (created.value.state === "Queued") {
    expect(await startCsvImport(queue.env, created.value.id)).toBe(true);
  }
  return created.value.id;
};

const runImport = async (
  owner: User,
  type: ImportTypeValue["kind"],
  mode: ImportModeValue["kind"],
  text: string,
  queue: Queue = queueEnv(),
): Promise<string> => {
  const id = await startImport(queue, owner, type, mode, text);
  await drain(queue);
  return id;
};

const entriesOf = async (owner: User, type: ImportTypeValue["kind"]): Promise<Entry[]> => {
  const all: Entry[] = [];
  let after = "";
  for (;;) {
    const page = await listEntriesPage(env.DB, identity(), owner.id, { kind: type }, after, 50);
    if (page.isErr()) {
      throw new Error(page.error.message);
    }
    all.push(...page.value.entries);
    if (page.value.next === undefined) {
      return all;
    }
    after = page.value.next;
  }
};

const keysOf = async (owner: User, type: ImportTypeValue["kind"]) =>
  (await entriesOf(owner, type)).map((entry) => entry.key).sort();

/** What an entry holds besides where it is stored, so two accounts' entries compare. */
const shape = (entry: Entry) => {
  switch (entry.kind) {
    case "Following":
      return [entry.key, entry.reblogs, entry.notify, entry.languages];
    case "Mutes":
      return [entry.key, entry.hideNotifications];
    default:
      return [entry.key];
  }
};

const shapesOf = async (owner: User, type: ImportTypeValue["kind"]) =>
  (await entriesOf(owner, type))
    .map(shape)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const download = async (owner: User, file: string): Promise<string> => {
  const response = await owner.fetcher(`/settings/exports/${file}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${file}"`);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return response.text();
};

const followRemote = async (
  owner: User,
  remote: Remote,
  options: Readonly<{ reblogs: boolean; notify: boolean; languages: string[] }>,
) => {
  const id = newEntityId();
  expect(
    (
      await insertOutboundFollow(env.DB, {
        id,
        accountId: owner.id,
        actorUri: remote.actorUri,
        followActivityId: `https://example.com/follows/${id}`,
      })
    ).isOk(),
  ).toBe(true);
  await updateOutboundFollowOptions(env.DB, owner.id, remote.actorUri, options);
  await env.DB.prepare(
    "UPDATE outbound_follows SET state = 'Accepted' WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(owner.id, remote.actorUri)
    .run();
};

const seedNote = async (author: User, visibility = "public"): Promise<string> => {
  const id = newEntityId();
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, created_at, updated_at)
     VALUES (?, ?, 'LocalNote', 'hello', '<p>hello</p>', ?, ?, ?)`,
  )
    .bind(id, author.id, visibility, stamp, stamp)
    .run();
  return id;
};

const statusUri = (author: User, statusId: string) =>
  `${ORIGIN}/users/${author.name}/statuses/${statusId}`;

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** A multipart/form-data body written by hand, so the request carries a Content-Length. */
const multipart = (
  fields: Readonly<{ type: string; mode: string }>,
  content: string,
): Readonly<{ body: string; headers: Record<string, string> }> => {
  const boundary = "----tstodon-test";
  const part = (name: string, value: string, file = false) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? '; filename="data.csv"\r\nContent-Type: text/csv' : ""}\r\n\r\n${value}\r\n`;
  return {
    body: `${part("type", fields.type)}${part("mode", fields.mode)}${part("data", content, true)}--${boundary}--\r\n`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
};

const upload = (
  owner: User,
  type: string,
  mode: string,
  content: string,
  extra: Record<string, string> = {},
) => {
  const form = multipart({ type, mode }, content);
  return owner.fetcher("/settings/import", {
    method: "POST",
    body: form.body,
    headers: { ...form.headers, ...extra },
  });
};

describe("data export and import", () => {
  it("round-trips follows, lists, blocks, mutes, domain blocks, and bookmarks", async () => {
    const alice = await user("rt_alice");
    const carol = await user("rt_carol");
    const bob = await user("rt_bob");
    const dave = await user("rt_dave");
    const remoteFriend = await remoteActor("rt_friend", "remote.example");
    const remoteBlocked = await remoteActor("rt_blocked", "other.example");
    const remoteMuted = await remoteActor("rt_muted", "remote.example");

    expect(
      (
        await followAccount(env.DB, alice.id, bob.id, false, {
          reblogs: false,
          notify: true,
          languages: ["en", "ja"],
        })
      ).isOk(),
    ).toBe(true);
    await followRemote(alice, remoteFriend, { reblogs: true, notify: false, languages: [] });
    await blockAccount(env.DB, alice.id, dave.id, `${ORIGIN}/users/${dave.name}`);
    await blockAccount(env.DB, alice.id, null, remoteBlocked.actorUri);
    await muteAccount(env.DB, alice.id, dave.id, `${ORIGIN}/users/${dave.name}`, {
      notifications: false,
      expiresAt: null,
    });
    await muteAccount(env.DB, alice.id, null, remoteMuted.actorUri, {
      notifications: true,
      expiresAt: null,
    });
    await blockDomain(env.DB, alice.id, "spam.example");
    await blockDomain(env.DB, alice.id, "ads.example");
    const close = await createList(env.DB, alice.id, { title: 'Close, "best" friends' });
    const news = await createList(env.DB, alice.id, { title: "News" });
    if (close.isErr() || news.isErr()) {
      throw new Error("lists");
    }
    await addListMembers(env.DB, close.value.id, [
      { kind: "LocalAccount", accountId: bob.id },
      { kind: "RemoteActor", actorUri: remoteFriend.actorUri },
    ]);
    await addListMembers(env.DB, news.value.id, [{ kind: "LocalAccount", accountId: dave.id }]);
    const first = await seedNote(bob);
    const second = await seedNote(bob);
    await bookmarkStatus(env.DB, alice.id, first);
    await bookmarkStatus(env.DB, alice.id, second);

    const files = {
      follows: await download(alice, "follows.csv"),
      lists: await download(alice, "lists.csv"),
      blocks: await download(alice, "blocks.csv"),
      mutes: await download(alice, "mutes.csv"),
      domains: await download(alice, "domain_blocks.csv"),
      bookmarks: await download(alice, "bookmarks.csv"),
    };

    // Mastodon's layouts.
    expect(lines(files.follows)[0]).toBe(
      "Account address,Show boosts,Notify on new posts,Languages",
    );
    expect(lines(files.follows).slice(1).sort()).toEqual([
      `rt_bob@example.com,false,true,"en, ja"`,
      "rt_friend@remote.example,true,false,",
    ]);
    expect(lines(files.mutes)[0]).toBe("Account address,Hide notifications");
    expect(lines(files.mutes).slice(1).sort()).toEqual([
      "rt_dave@example.com,false",
      "rt_muted@remote.example,true",
    ]);
    expect(lines(files.blocks).sort()).toEqual(["rt_blocked@other.example", "rt_dave@example.com"]);
    expect(lines(files.domains)).toEqual(["ads.example", "spam.example"]);
    expect(lines(files.lists).sort()).toEqual([
      '"Close, ""best"" friends",rt_bob@example.com',
      '"Close, ""best"" friends",rt_friend@remote.example',
      "News,rt_dave@example.com",
    ]);
    expect(lines(files.bookmarks).sort()).toEqual(
      [statusUri(bob, first), statusUri(bob, second)].sort(),
    );

    // Import them into another account: follows first, since a list takes followed accounts.
    const queue = queueEnv();
    await runImport(carol, "Following", "Merge", files.follows, queue);
    await env.DB.prepare("UPDATE outbound_follows SET state = 'Accepted' WHERE account_id = ?")
      .bind(carol.id)
      .run();
    await runImport(carol, "Lists", "Merge", files.lists, queue);
    await runImport(carol, "Blocks", "Merge", files.blocks, queue);
    await runImport(carol, "Mutes", "Merge", files.mutes, queue);
    await runImport(carol, "DomainBlocks", "Merge", files.domains, queue);
    await runImport(carol, "Bookmarks", "Merge", files.bookmarks, queue);

    for (const type of [
      "Following",
      "Lists",
      "Blocks",
      "Mutes",
      "DomainBlocks",
      "Bookmarks",
    ] as const) {
      const imported = await shapesOf(carol, type);
      expect(imported, type).toEqual(await shapesOf(alice, type));
      expect(imported.length, type).toBeGreaterThan(0);
    }
    // And the files match, byte for byte, apart from the order of rows.
    expect(lines(await download(carol, "follows.csv")).sort()).toEqual(lines(files.follows).sort());
    expect(lines(await download(carol, "lists.csv")).sort()).toEqual(lines(files.lists).sort());
  });

  it("exports an empty account as headers only, and nothing for types without a header", async () => {
    const empty = await user("ex_empty");
    expect(await download(empty, "follows.csv")).toBe(
      "Account address,Show boosts,Notify on new posts,Languages\n",
    );
    expect(await download(empty, "mutes.csv")).toBe("Account address,Hide notifications\n");
    expect(await download(empty, "blocks.csv")).toBe("");
    expect(await download(empty, "bookmarks.csv")).toBe("");
  });

  it("exports every row of a long list, a page at a time, each once and in order", async () => {
    const owner = await user("ex_long");
    const total = 450;
    await env.DB.batch(
      Array.from({ length: total }, (_, index) =>
        env.DB.prepare("INSERT INTO account_domain_blocks (account_id, domain) VALUES (?, ?)").bind(
          owner.id,
          `d${String(index).padStart(4, "0")}.example`,
        ),
      ),
    );
    const exported = lines(await download(owner, "domain_blocks.csv"));
    expect(exported).toHaveLength(total);
    expect(exported).toEqual([...exported].sort());
    expect(new Set(exported).size).toBe(total);
  });

  it("merges into what the account has, and an overwrite removes what the file leaves out", async () => {
    const owner = await user("ow_owner");
    const bob = await user("ow_bob");
    const carol = await user("ow_carol");
    const dan = await user("ow_dan");
    await remoteActor("ow_kept", "remote.example");
    const remoteDropped = await remoteActor("ow_dropped", "remote.example");
    const remoteFollowed = await remoteActor("ow_followed", "remote.example");

    await blockAccount(env.DB, owner.id, bob.id, `${ORIGIN}/users/${bob.name}`);
    await blockDomain(env.DB, owner.id, "old.example");
    await runImport(owner, "Blocks", "Merge", "ow_carol\n");
    expect(await keysOf(owner, "Blocks")).toEqual(["ow_bob@example.com", "ow_carol@example.com"]);
    await runImport(owner, "Blocks", "Overwrite", "ow_carol@example.com\now_kept@remote.example\n");
    expect(await keysOf(owner, "Blocks")).toEqual([
      "ow_carol@example.com",
      "ow_kept@remote.example",
    ]);
    // Other types are not touched by a blocks import.
    expect(await keysOf(owner, "DomainBlocks")).toEqual(["old.example"]);

    await runImport(owner, "DomainBlocks", "Overwrite", "new.example\n");
    expect(await keysOf(owner, "DomainBlocks")).toEqual(["new.example"]);

    await followAccount(env.DB, owner.id, bob.id, false, {});
    await followRemote(owner, remoteDropped, { reblogs: true, notify: false, languages: [] });
    await runImport(
      owner,
      "Following",
      "Overwrite",
      "ow_dan\now_followed@remote.example,false,true,en\n",
    );
    expect(await shapesOf(owner, "Following")).toEqual([["ow_dan@example.com", true, false, []]]);
    const followRows = await env.DB.prepare(
      "SELECT actor_uri, reblogs, notify, languages_json FROM outbound_follows WHERE account_id = ?",
    )
      .bind(owner.id)
      .all<{ actor_uri: string; reblogs: number; notify: number; languages_json: string }>();
    expect(followRows.results).toEqual([
      {
        actor_uri: remoteFollowed.actorUri,
        reblogs: 0,
        notify: 1,
        languages_json: '["en"]',
      },
    ]);

    // Lists: an overwrite empties only the lists the file names.
    await runImport(owner, "Lists", "Merge", "Friends,ow_bob\nFriends,ow_carol\nOther,ow_bob\n");
    expect(await keysOf(owner, "Lists")).toEqual([
      "Friends\u001fow_bob@example.com",
      "Friends\u001fow_carol@example.com",
      "Other\u001fow_bob@example.com",
    ]);
    await runImport(owner, "Lists", "Overwrite", "Friends,ow_carol\n");
    expect(await keysOf(owner, "Lists")).toEqual([
      "Friends\u001fow_carol@example.com",
      "Other\u001fow_bob@example.com",
    ]);
    expect(new Set([carol.id, bob.id, dan.id]).size).toBe(3);
  });

  it("applies bookmarks through the bookmark function, and refuses posts it cannot show", async () => {
    const owner = await user("bm_owner");
    const author = await user("bm_author");
    const open = await seedNote(author);
    const direct = await seedNote(author, "direct");
    const id = await runImport(
      owner,
      "Bookmarks",
      "Merge",
      [
        statusUri(author, open),
        statusUri(author, direct),
        statusUri(author, "999999999999999999"),
        "https://remote.example/users/x/statuses/1",
      ].join("\n"),
    );
    expect(await keysOf(owner, "Bookmarks")).toEqual([open]);
    const failed = await listFailedRows(env.DB, id, 10);
    expect(failed.isOk() && failed.value.map((row) => [row.position, row.failure.kind])).toEqual([
      [2, "Unsupported"],
      [3, "Unsupported"],
      [4, "Unsupported"],
    ]);
  });

  it("records a row per outcome: unknown account, refused, not followed, malformed", async () => {
    const owner = await user("out_owner");
    const target = await user("out_target");
    const remote = await remoteActor("out_remote", "remote.example");
    await blockAccount(env.DB, target.id, owner.id, `${ORIGIN}/users/${owner.name}`);
    const original = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const id = await runImport(
        owner,
        "Following",
        "Merge",
        [
          "out_target", // blocked by the target: refused
          "out_owner", // oneself: refused
          "out_remote@remote.example", // cached: no lookup
          "ghost@nowhere.example", // looked up, not found
          "ghost2@nowhere.example",
          "not a handle", // malformed
        ].join("\n"),
      );
      const imported = await findCsvImport(env.DB, owner.id, id);
      expect(imported.isOk() && imported.value?.counts).toEqual({
        pending: 0,
        applied: 1,
        failed: 5,
      });
      const failed = await listFailedRows(env.DB, id, 10);
      expect(failed.isOk() && failed.value.map((row) => [row.position, row.failure.kind])).toEqual([
        [1, "Refused"],
        [2, "Refused"],
        [4, "UnknownAccount"],
        [5, "UnknownAccount"],
        [6, "Malformed"],
      ]);
      expect(failed.isOk() && failed.value.at(-1)?.input).toBe("not a handle");
      // The cached remote account cost no request; each unknown one is looked up on its own.
      expect(fetched.every((url) => url.includes("nowhere.example"))).toBe(true);
      expect(fetched.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
    expect(remote.actorUri).toContain("out_remote");

    const noFollow = await runImport(
      owner,
      "Lists",
      "Merge",
      "L,out_remote@remote.example\nL,out_target\n",
    );
    const listFailures = await listFailedRows(env.DB, noFollow, 10);
    expect(listFailures.isOk() && listFailures.value.map((row) => row.failure.kind)).toEqual([
      "NotFollowed",
    ]);
  });

  it("applies a page of rows per job and queues the next after a delay", async () => {
    const owner = await user("pg_owner");
    const total = IMPORT_PAGE_SIZE * 2 + 3;
    const text = Array.from({ length: total }, (_, i) => `p${i}.example`).join("\n");
    const queue = queueEnv();
    const id = await startImport(queue, owner, "DomainBlocks", "Merge", text);

    const progress = async () => {
      const found = await findCsvImport(env.DB, owner.id, id);
      return found.isOk() ? found.value : undefined;
    };
    expect((await progress())?.counts).toEqual({ pending: total, applied: 0, failed: 0 });
    const first = await step(queue);
    expect(first?.job).toMatchObject({ step: { kind: "Rows", afterPosition: 0 } });
    expect(first?.delaySeconds).toBe(IMPORT_PAGE_DELAY_SECONDS);
    expect((await progress())?.counts.applied).toBe(IMPORT_PAGE_SIZE);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      job: { step: { kind: "Rows", afterPosition: IMPORT_PAGE_SIZE } },
      delaySeconds: IMPORT_PAGE_DELAY_SECONDS,
    });
    expect((await progress())?.state).toBe("Queued");

    // Running the same job again changes nothing: its rows are no longer pending.
    if (first) {
      queue.sent.unshift(first);
    }
    await step(queue);
    expect((await progress())?.counts.applied).toBe(IMPORT_PAGE_SIZE * 2);
    await drain(queue);
    expect((await progress())?.counts).toEqual({ pending: 0, applied: total, failed: 0 });
    expect((await progress())?.state).toBe("Finished");
    expect(await keysOf(owner, "DomainBlocks")).toHaveLength(total);
  });

  it("allows one running import per account, and keeps only the latest few", async () => {
    const owner = await user("one_owner");
    const other = await user("one_other");
    const queue = queueEnv();
    const make = (account: User, text: string) =>
      createCsvImport(env.DB, {
        accountId: account.id,
        type: { kind: "DomainBlocks" },
        mode: { kind: "Merge" },
        lines: (() => {
          const parsed = parseImportFile({ kind: "DomainBlocks" }, new TextEncoder().encode(text), {
            localDomain: "example.com",
            publicOrigin: ORIGIN,
          });
          if (parsed.isErr()) {
            throw new Error("parse");
          }
          return parsed.value;
        })(),
      });
    const first = await make(owner, "a.example");
    expect(first.isOk() && first.value?.state).toBe("Queued");
    expect((await make(owner, "b.example")).isOk()).toBe(true);
    expect((await make(owner, "b.example"))._unsafeUnwrap()).toBeUndefined();
    // Another account is not held up by it.
    expect((await make(other, "c.example"))._unsafeUnwrap()?.state).toBe("Queued");
    expect(queue.sent).toHaveLength(0);

    for (let round = 0; round < IMPORTS_KEPT + 2; round += 1) {
      await env.DB.prepare("UPDATE csv_imports SET state = 'Finished' WHERE account_id = ?")
        .bind(owner.id)
        .run();
      expect((await make(owner, `r${round}.example`))._unsafeUnwrap()?.state).toBe("Queued");
    }
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM csv_imports WHERE account_id = ?")
      .bind(owner.id)
      .first<{ n: number }>();
    expect(kept?.n).toBeLessThanOrEqual(IMPORTS_KEPT);
  });

  it("does not let an overwrite touch another account's entries", async () => {
    const owner = await user("iso_owner");
    const bystander = await user("iso_bystander");
    const target = await user("iso_target");
    await blockAccount(env.DB, bystander.id, target.id, `${ORIGIN}/users/${target.name}`);
    await blockDomain(env.DB, bystander.id, "keep.example");
    await runImport(owner, "Blocks", "Overwrite", "iso_target\n");
    await runImport(owner, "DomainBlocks", "Overwrite", "mine.example\n");
    expect(await keysOf(bystander, "Blocks")).toEqual(["iso_target@example.com"]);
    expect(await keysOf(bystander, "DomainBlocks")).toEqual(["keep.example"]);
  });
});

describe("/settings/export and /settings/import pages", () => {
  it("send a signed-out browser to sign in", async () => {
    for (const path of [
      "/settings/export",
      "/settings/exports/follows.csv",
      "/settings/import",
      "/settings/imports",
      "/settings/imports/123",
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        redirect: "manual",
      });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        `/auth/sign_in?return_to=${encodeURIComponent(path)}`,
      );
    }
  });

  it("are linked from the preferences index, and the export page links every file", async () => {
    const owner = await user("pg_links");
    const index = await (await owner.fetcher("/settings/preferences")).text();
    expect(index).toContain('href="/settings/export"');
    expect(index).toContain('href="/settings/import"');
    const exportPage = await (await owner.fetcher("/settings/export")).text();
    for (const file of ["follows", "lists", "blocks", "mutes", "domain_blocks", "bookmarks"]) {
      expect(exportPage).toContain(`href="/settings/exports/${file}.csv"`);
    }
    expect((await owner.fetcher("/settings/exports/other.csv")).status).toBe(404);
    expect((await owner.fetcher("/settings/exports/follows.json")).status).toBe(404);
  });

  it("take an upload, show its progress, and list the rows that failed (escaped)", async () => {
    const owner = await user("up_owner");
    const target = await user("up_target");
    const response = await upload(
      owner,
      "Blocks",
      "Merge",
      `${target.name}\n<script>alert(1)</script>\nnobody_at_all@nowhere.invalid/x\n`,
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/settings\/imports\/\d+$/);
    const detail = await (await owner.fetcher(location)).text();
    expect(detail).toContain("Blocked users import");
    expect(detail).toContain("Row 2:");
    expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(detail).not.toContain("<script>alert(1)");
    expect(detail).toContain("Row 3:");
    expect(detail).toContain("This row is not a valid row for this type of file.");
    const list = await (await owner.fetcher("/settings/import")).text();
    expect(list).toContain(`href="${location}"`);
  });

  it("refuse an overwrite whose file has a row that cannot be read, and store nothing", async () => {
    const owner = await user("up_overwrite");
    const response = await upload(owner, "Blocks", "Overwrite", "fine_user\n???\n");
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("1 rows cannot be read, so nothing was imported");
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM csv_imports WHERE account_id = (SELECT id FROM accounts WHERE username = ?)",
    )
      .bind("up_overwrite")
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("enforce the size, row, and format limits", async () => {
    const owner = await user("up_caps");
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `u${i}.example`).join("\n");
    const tooMany = await upload(owner, "DomainBlocks", "Merge", rows);
    expect(tooMany.status).toBe(422);
    expect(await tooMany.text()).toContain(`more than ${MAX_IMPORT_ROWS} rows`);

    const tooBig = await upload(owner, "DomainBlocks", "Merge", "x".repeat(MAX_IMPORT_BYTES + 1));
    expect(tooBig.status).toBe(413);
    // A file whose declared size is over the limit plus the envelope is refused before it is read.
    const huge = await upload(
      owner,
      "DomainBlocks",
      "Merge",
      "x".repeat(MAX_IMPORT_BYTES + 20_000),
    );
    expect(huge.status).toBe(413);

    const notText = await owner.fetcher("/settings/import", {
      method: "POST",
      body: new Blob([
        '--b\r\nContent-Disposition: form-data; name="type"\r\n\r\nBlocks\r\n--b\r\nContent-Disposition: form-data; name="mode"\r\n\r\nMerge\r\n--b\r\nContent-Disposition: form-data; name="data"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n',
        new Uint8Array([0xff, 0xfe, 0x00, 0xfd]),
        "\r\n--b--\r\n",
      ]),
      headers: { "content-type": "multipart/form-data; boundary=b" },
    });
    // A Blob body has a known length.
    expect(notText.status).toBe(422);
    expect(await notText.text()).toContain("not UTF-8 text");

    const badType = await upload(owner, "Everything", "Merge", "a.example");
    expect(badType.status).toBe(422);
    const badMode = await upload(owner, "Blocks", "Delete", "a");
    expect(badMode.status).toBe(422);
    const urlEncoded = await owner.fetcher("/settings/import", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "type=Blocks&mode=Merge&data=a",
    });
    expect(urlEncoded.status).toBe(422);
    const empty = await upload(owner, "Blocks", "Merge", "\n\n");
    expect(empty.status).toBe(422);
    expect(await empty.text()).toContain("no rows");
  });

  it("refuse a cross-site post and store nothing", async () => {
    const owner = await user("up_csrf");
    const form = multipart({ type: "DomainBlocks", mode: "Merge" }, "evil.example\n");
    const refused = await owner.fetcher("/settings/import", {
      method: "POST",
      body: form.body,
      headers: {
        ...form.headers,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(refused.status).toBe(403);
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM csv_imports WHERE account_id = (SELECT id FROM accounts WHERE username = ?)",
    )
      .bind("up_csrf")
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it("do not show another account's import", async () => {
    const owner = await user("see_owner");
    const stranger = await user("see_stranger");
    const response = await upload(owner, "DomainBlocks", "Merge", "private.example\n");
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect((await owner.fetcher(location)).status).toBe(200);
    const asStranger = await stranger.fetcher(location);
    expect(asStranger.status).toBe(404);
    expect(await asStranger.text()).not.toContain("private.example");
    expect(await (await stranger.fetcher("/settings/import")).text()).not.toContain(location);
  });
});
