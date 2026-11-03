import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { OUTBOX_BACKFILL_ITEM_LIMIT, requestRemoteOutboxBackfill } from "./remote-outbox-backfill";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const EntrySchema = z.object({
  id: z.string(),
  uri: z.string(),
  reblog: z.object({ uri: z.string() }).nullable(),
});

/** Each entry as the URI a reader sees: the boosted status's for a boost. */
const entryUris = (entries: ReadonlyArray<z.infer<typeof EntrySchema>>): string[] =>
  entries.map((entry) => entry.reblog?.uri ?? entry.uri);

const profileUris = async (remote: Remote, query = ""): Promise<string[]> =>
  entryUris(
    read(
      z.array(EntrySchema),
      (await json(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/statuses${query}`))
        .body,
    ),
  );

const homeUris = async (email: string): Promise<string[]> =>
  entryUris(
    read(
      z.array(EntrySchema),
      (await json("/api/v1/timelines/home", { headers: await authHeaders(email) })).body,
    ),
  );

const origin = (remote: Remote): string => new URL(remote.actorUri).origin;

const noteUri = (remote: Remote, slug: string): string => `${origin(remote)}/notes/${slug}`;

const noteDocument = (
  remote: Remote,
  slug: string,
  published: string,
  extra: Record<string, unknown> = {},
) => ({
  id: noteUri(remote, slug),
  type: "Note",
  attributedTo: remote.actorUri,
  content: `<p>${slug}</p>`,
  published,
  to: [PUBLIC],
  cc: [`${remote.actorUri}/followers`],
  ...extra,
});

const createItem = (
  remote: Remote,
  slug: string,
  published: string,
  object: unknown = noteDocument(remote, slug, published),
  extra: Record<string, unknown> = {},
) => ({
  id: `${noteUri(remote, slug)}/activity`,
  type: "Create",
  actor: remote.actorUri,
  published,
  to: [PUBLIC],
  cc: [`${remote.actorUri}/followers`],
  object,
  ...extra,
});

const announceItem = (remote: Remote, slug: string, object: string, published: string) => ({
  id: `${origin(remote)}/boosts/${slug}/activity`,
  type: "Announce",
  actor: remote.actorUri,
  published,
  to: [PUBLIC],
  cc: [`${remote.actorUri}/followers`],
  object,
});

const outboxUri = (remote: Remote): string => `${remote.actorUri}/outbox`;

const featuredUri = (remote: Remote): string => `${remote.actorUri}/collections/featured`;

/**
 * The documents a remote server serves for `remote`: its actor document
 * (with an outbox), the outbox, and its first page holding `items`; with
 * `featured`, a featured collection embedding those items, as Mastodon's does.
 */
const outboxDocuments = (
  remote: Remote,
  items: ReadonlyArray<unknown>,
  featured?: ReadonlyArray<unknown>,
): ReadonlyMap<string, unknown> =>
  new Map<string, unknown>([
    ...(featured
      ? [
          [
            featuredUri(remote),
            { id: featuredUri(remote), type: "OrderedCollection", orderedItems: featured },
          ] as const,
        ]
      : []),
    [
      remote.actorUri,
      {
        id: remote.actorUri,
        type: "Person",
        preferredUsername: new URL(remote.actorUri).pathname.split("/").at(-1),
        inbox: `${remote.actorUri}/inbox`,
        outbox: outboxUri(remote),
        ...(featured ? { featured: featuredUri(remote) } : {}),
        publicKey: {
          id: `${remote.actorUri}#main-key`,
          owner: remote.actorUri,
          publicKeyPem: remote.publicKeyPem,
        },
      },
    ],
    [
      outboxUri(remote),
      {
        id: outboxUri(remote),
        type: "OrderedCollection",
        totalItems: items.length,
        first: `${outboxUri(remote)}?page=true`,
      },
    ],
    [
      `${outboxUri(remote)}?page=true`,
      { id: `${outboxUri(remote)}?page=true`, type: "OrderedCollectionPage", orderedItems: items },
    ],
  ]);

/** Run `body` while `fetch` serves `documents` by URL and 404s anything else. */
const serving = async <T>(
  documents: ReadonlyMap<string, unknown>,
  body: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  const fetched: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  globalThis.fetch = fetched;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
};

type QueueSend = Readonly<{ message: unknown }>;

/** The Worker's env with a queue that records what is sent to it. */
const recordingEnv = () => {
  const sent: QueueSend[] = [];
  const queue = {
    send: async (message: unknown) => {
      sent.push({ message });
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) => (key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key)),
  });
  return { env: proxied, sent };
};

const sentKinds = (sent: ReadonlyArray<QueueSend>): string[] =>
  sent.map((entry) => read(z.object({ kind: z.string() }), entry.message).kind);

const runBackfill = async (remote: Remote, target: Env = env): Promise<void> => {
  const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri: remote.actorUri });
  if (job.isErr()) {
    throw new Error("backfill job rejected");
  }
  expect(await processOutboxJob(target, job.value)).toBe("ok");
};

const storedCount = async (remote: Remote): Promise<number> =>
  (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?")
      .bind(remote.actorUri)
      .first<{ n: number }>()
  )?.n ?? 0;

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  const followed = await json(
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    {
      method: "POST",
      headers: { ...(await authHeaders(email)), "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(followed.status).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

describe("requesting a remote outbox backfill", () => {
  it("queues one job for concurrent views and none again within a day", async () => {
    const remote = await remoteActor("backfill-claim", "backfill.example");
    const recording = recordingEnv();

    await Promise.all([
      requestRemoteOutboxBackfill(recording.env, remote.actorUri),
      requestRemoteOutboxBackfill(recording.env, remote.actorUri),
    ]);
    expect(recording.sent.map((entry) => entry.message)).toEqual([
      { kind: "BackfillRemoteOutbox", actorUri: remote.actorUri },
    ]);

    await requestRemoteOutboxBackfill(recording.env, remote.actorUri);
    expect(recording.sent).toHaveLength(1);

    await env.DB.prepare("UPDATE remote_actors SET outbox_fetched_at = ? WHERE actor_uri = ?")
      .bind(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), remote.actorUri)
      .run();
    await requestRemoteOutboxBackfill(recording.env, remote.actorUri);
    expect(recording.sent).toHaveLength(2);
  });

  it("is claimed by a view of the remote profile's statuses", async () => {
    const remote = await remoteActor("backfill-view", "backfill.example");

    expect(await profileUris(remote)).toEqual([]);

    const row = await env.DB.prepare(
      "SELECT outbox_fetched_at FROM remote_actors WHERE actor_uri = ?",
    )
      .bind(remote.actorUri)
      .first<{ outbox_fetched_at: string | null }>();
    expect(row?.outbox_fetched_at).not.toBeNull();
  });
});

describe("backfilling a remote outbox", () => {
  it("stores the first page's notes and boosts, so the profile lists them", async () => {
    const remote = await remoteActor("backfill-store", "backfill.example");
    const author = await remoteActor("backfill-store-author", "third.example");
    const referenced = noteDocument(remote, "store-referenced", "2024-03-02T00:00:00.000Z");
    const boosted = noteDocument(author, "store-boosted", "2024-01-01T00:00:00.000Z");
    const documents = new Map([
      ...outboxDocuments(remote, [
        createItem(remote, "store-embedded", "2024-03-03T00:00:00.000Z"),
        createItem(remote, "store-referenced", "2024-03-02T00:00:00.000Z", referenced.id),
        announceItem(remote, "store-boost", boosted.id, "2024-03-01T00:00:00.000Z"),
      ]),
      [referenced.id, referenced],
      [boosted.id, boosted],
    ]);

    await serving(documents, () => runBackfill(remote));

    const expected = [
      noteUri(remote, "store-embedded"),
      noteUri(remote, "store-referenced"),
      boosted.id,
    ];
    expect(await profileUris(remote)).toEqual(expected);
    const actorRow = await env.DB.prepare(
      "SELECT outbox_uri FROM remote_actors WHERE actor_uri = ?",
    )
      .bind(remote.actorUri)
      .first<{ outbox_uri: string | null }>();
    expect(actorRow?.outbox_uri).toBe(outboxUri(remote));

    await serving(documents, () => runBackfill(remote));
    expect(await profileUris(remote)).toEqual(expected);
    expect(await storedCount(remote)).toBe(2);
  });

  it("ignores notes attributed to someone else, from another host, or not public", async () => {
    const remote = await remoteActor("backfill-foreign", "backfill.example");
    const other = await remoteActor("backfill-foreign-other", "backfill.example");
    const published = "2024-03-03T00:00:00.000Z";
    const elsewhere = {
      ...noteDocument(remote, "foreign-elsewhere", published),
      id: "https://elsewhere.example/notes/foreign-elsewhere",
    };
    const documents = new Map([
      ...outboxDocuments(remote, [
        createItem(
          remote,
          "foreign-attributed",
          published,
          noteDocument(other, "foreign-attributed", published),
        ),
        createItem(other, "foreign-actor", published),
        createItem(remote, "foreign-elsewhere", published, elsewhere),
        createItem(
          remote,
          "foreign-private",
          published,
          noteDocument(remote, "foreign-private", published, {
            to: [`${remote.actorUri}/followers`],
            cc: [],
          }),
          { to: [`${remote.actorUri}/followers`], cc: [] },
        ),
      ]),
      [elsewhere.id, elsewhere],
    ]);

    await serving(documents, () => runBackfill(remote));

    expect(await storedCount(remote)).toBe(0);
    expect(await storedCount(other)).toBe(0);
  });

  it(`processes at most ${OUTBOX_BACKFILL_ITEM_LIMIT} items`, async () => {
    const remote = await remoteActor("backfill-cap", "backfill.example");
    const items = Array.from({ length: OUTBOX_BACKFILL_ITEM_LIMIT + 5 }, (_, index) =>
      createItem(
        remote,
        `cap-${index}`,
        new Date(Date.UTC(2024, 0, 31) - index * 60_000).toISOString(),
      ),
    );

    await serving(outboxDocuments(remote, items), () => runBackfill(remote));

    expect(await storedCount(remote)).toBe(OUTBOX_BACKFILL_ITEM_LIMIT);
    const stored = await profileUris(remote, `?limit=40`);
    expect(stored).toHaveLength(OUTBOX_BACKFILL_ITEM_LIMIT);
    expect(stored).not.toContain(noteUri(remote, `cap-${OUTBOX_BACKFILL_ITEM_LIMIT}`));
  });

  it("puts old posts at their publish time on a follower's home, telling no one", async () => {
    const remote = await remoteActor("backfill-home", "backfill.example");
    const author = await remoteActor("backfill-home-author", "third.example");
    const email = "backfill-home-follower@example.com";
    const follower = await signedInAccount(email);
    await acceptedFollow(email, remote, "home");
    const live = noteDocument(remote, "home-live", new Date().toISOString());
    expect(await remote.send({ id: `${live.id}/activity`, type: "Create", object: live })).toBe(
      202,
    );
    const mentionUrl = `https://example.com/users/${follower.username}`;
    const boosted = noteDocument(author, "home-boosted", "2017-06-01T00:00:00.000Z");
    const recording = recordingEnv();

    await serving(
      new Map([
        ...outboxDocuments(remote, [
          createItem(
            remote,
            "home-old",
            "2017-07-01T00:00:00.000Z",
            noteDocument(remote, "home-old", "2017-07-01T00:00:00.000Z", {
              cc: [`${remote.actorUri}/followers`, mentionUrl],
              tag: [{ type: "Mention", href: mentionUrl, name: `@${follower.username}` }],
            }),
          ),
          announceItem(remote, "home-boost", boosted.id, "2017-06-02T00:00:00.000Z"),
        ]),
        [boosted.id, boosted],
      ]),
      () => runBackfill(remote, recording.env),
    );

    expect(await homeUris(email)).toEqual([live.id, noteUri(remote, "home-old"), boosted.id]);
    expect(sentKinds(recording.sent)).not.toContain("FanOutHome");
    const notifications = read(
      z.array(z.object({ type: z.string() })),
      (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
    );
    expect(notifications).toEqual([]);
  });
});

describe("backfilling a remote actor's pinned notes", () => {
  it("serves its featured notes for pinned=true, replacing them on each backfill", async () => {
    const remote = await remoteActor("backfill-pins", "backfill.example");
    const other = await remoteActor("backfill-pins-other", "backfill.example");
    const first = noteDocument(remote, "pins-first", "2023-05-01T00:00:00.000Z");
    const second = noteDocument(remote, "pins-second", "2024-05-01T00:00:00.000Z");
    const foreign = noteDocument(other, "pins-foreign", "2024-05-02T00:00:00.000Z");
    const documents = new Map([
      ...outboxDocuments(remote, [], [first, second.id, foreign]),
      [second.id, second],
    ]);

    await serving(documents, () => runBackfill(remote));

    expect(await profileUris(remote, "?pinned=true")).toEqual([first.id, second.id]);
    expect(await profileUris(remote)).toEqual([second.id, first.id]);

    await serving(outboxDocuments(remote, [], [second.id]), () => runBackfill(remote));

    expect(await profileUris(remote, "?pinned=true")).toEqual([second.id]);
  });
});
