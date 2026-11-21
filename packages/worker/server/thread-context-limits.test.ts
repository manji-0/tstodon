import { SELF, env } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { listThreadDescendantIds } from "./generated/prisma/sql";
import { parseInstanceIdentity } from "./runtime-config";
import { queryTyped } from "./typed-sql";
import { InstanceIdentity } from "@tstodon/domain";

/** An 18-digit status id, as the id generator makes them, from a per-test base. */
const statusId = (base: number, index: number): string =>
  String(base * 1_000_000 + index).padStart(18, "0");

const noteUri = (author: Remote, id: string): string =>
  `${new URL(author.actorUri).origin}/notes/${id}`;

type Note = Readonly<{ id: string; author: Remote; parent?: string; visibility?: string }>;

/** Store remote notes straight into D1, each replying to `parent` (an id among them). */
const store = async (notes: ReadonlyArray<Note>): Promise<void> => {
  const byId = new Map(notes.map((note) => [note.id, note]));
  // Whom a reply answers, as the store sets it: a reply to its author's own
  // reply carries that one's over (Mastodon's `carried_over_reply_to_account_id`).
  const answered = (note: Note): string | null => {
    const parent = note.parent === undefined ? undefined : byId.get(note.parent);
    if (parent === undefined) {
      return null;
    }
    return parent.author === note.author && parent.parent !== undefined
      ? answered(parent)
      : parent.author.actorUri;
  };
  const statements = notes.map((note) => {
    const parent = note.parent === undefined ? undefined : byId.get(note.parent);
    return env.DB.prepare(
      `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, in_reply_to_uri, in_reply_to_actor_uri)
       VALUES (?, ?, ?, '<p>note</p>', ?, '2024-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      note.id,
      note.author.actorUri,
      noteUri(note.author, note.id),
      note.visibility ?? "public",
      parent ? noteUri(parent.author, parent.id) : null,
      answered(note),
    );
  });
  for (let start = 0; start < statements.length; start += 500) {
    await env.DB.batch(statements.slice(start, start + 500));
  }
};

const chain = (base: number, author: Remote, length: number): Note[] =>
  Array.from({ length }, (_, index) => ({
    id: statusId(base, index),
    author,
    ...(index > 0 ? { parent: statusId(base, index - 1) } : {}),
  }));

const ContextSchema = z.object({
  ancestors: z.array(z.object({ id: z.string() })),
  descendants: z.array(z.object({ id: z.string() })),
});

const contextIds = async (id: string) => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}/context`);
  expect(response.status).toBe(200);
  const parsed = schemaResult(ContextSchema)(await response.json());
  if (parsed.isErr()) {
    throw new Error("context schema rejected");
  }
  return {
    ancestors: parsed.value.ancestors.map((status) => status.id),
    descendants: parsed.value.descendants.map((status) => status.id),
  };
};

describe("an anonymous reader's context limits, as Mastodon's ContextsController", () => {
  it("gives the 40 nearest ancestors", async () => {
    const author = await remoteActor("limits-ancestors", "limits.example");
    const notes = chain(910, author, 45);
    await store(notes);

    const context = await contextIds(statusId(910, 44));

    expect(context.ancestors).toEqual(notes.slice(4, 44).map((note) => note.id));
  });

  it("gives 60 descendants", async () => {
    const author = await remoteActor("limits-wide", "limits.example");
    const root = { id: statusId(911, 0), author };
    const replies = Array.from({ length: 65 }, (_, index) => ({
      id: statusId(911, index + 1),
      author,
      parent: root.id,
    }));
    await store([root, ...replies]);

    const context = await contextIds(root.id);

    expect(context.descendants).toEqual(replies.slice(0, 60).map((note) => note.id));
  });

  it("gives descendants 20 deep", async () => {
    const author = await remoteActor("limits-deep", "limits.example");
    const notes = chain(912, author, 25);
    await store(notes);

    const context = await contextIds(statusId(912, 0));

    expect(context.descendants).toEqual(notes.slice(1, 21).map((note) => note.id));
  });
});

describe("context descendants", () => {
  it("promote a reply that answers its own author when its parent does not load", async () => {
    const [other, self] = await Promise.all([
      remoteActor("promote-unloaded-other", "promote.example"),
      remoteActor("promote-unloaded-self", "promote.example"),
    ]);
    const notes: Note[] = [
      { id: statusId(913, 0), author: self },
      { id: statusId(913, 1), author: other, parent: statusId(913, 0) },
      // A row that does not read as a status: the context leaves it out.
      { id: statusId(913, 2), author: self, parent: statusId(913, 0), visibility: "unknown" },
      { id: statusId(913, 3), author: self, parent: statusId(913, 2) },
    ];
    await store(notes);

    const context = await contextIds(statusId(913, 0));

    expect(context.descendants).toEqual([statusId(913, 3), statusId(913, 1)]);
  });
});

const DescendantRow = z.object({ id: z.string() }).passthrough();

describe("the descendant tree query", () => {
  // Mastodon's own query walks a reply chain this long for a signed-in reader
  // (CONTEXT_LIMIT); it must cost time in proportion to the chain, not its square.
  it("walks a 4096-reply chain in linear time", async () => {
    const author = await remoteActor("limits-long", "limits.example");
    const notes = chain(914, author, 4097);
    await store(notes);
    const prefix = `${InstanceIdentity.actorUrl(parseInstanceIdentity(env)._unsafeUnwrap(), "")}`;

    const started = performance.now();
    const rows = await queryTyped(
      env.DB,
      listThreadDescendantIds("Remote", statusId(914, 0), prefix, 4096, 4097),
      DescendantRow,
    );
    const elapsed = performance.now() - started;

    expect(rows.map((row) => row.id)).toEqual(notes.slice(1).map((note) => note.id));
    expect(elapsed).toBeLessThan(250);
  });
});
