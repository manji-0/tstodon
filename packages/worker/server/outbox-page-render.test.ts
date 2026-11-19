import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { ApiStatus, type ApiStatusJSON } from "@tstodon/api";
import { ACTIVITY_JSON } from "../test/activity-json";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { sampleUploadFor } from "../test/image-fixtures";
import { meter, patchD1, resetMeter, settle } from "../test/meter";
import { remoteActor } from "../test/remote-actor-fixture";
import { findAccountByUsername } from "./account-store";
import { announceActivity, noteCreateActivity } from "./activitypub";
import { loadCustomEmojis } from "./custom-emoji-store";
import { parseRows } from "./d1";
import { loadLocalNoteDocument } from "./local-note-document";
import { statusTargetRef } from "./quote-uri";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusesByIds } from "./status-store";

/**
 * An outbox page renders its notes as each note's own URI serves it, with
 * the media, mentions, parent, poll, quote and quote policy of every note
 * read for the whole page at once, so its D1 statements do not grow with
 * the notes on it.
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
/** D1 statements an outbox page of 20 varied statuses may make. */
const PAGE_STATEMENTS = 40;

const post = async (email: string, body: Record<string, unknown>): Promise<ApiStatusJSON> => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ visibility: "public", ...body }),
  });
  expect(response.status, JSON.stringify(body)).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const reblog = async (email: string, statusId: string) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/statuses/${statusId}/reblog`, {
    method: "POST",
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
};

const upload = async (email: string, description: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([sampleUploadFor("image/png")], "image.png", { type: "image/png" }));
  form.set("description", description);
  const response = await SELF.fetch(`${ORIGIN}/api/v2/media`, {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.object({ id: z.string() }))(await response.json());
  if (parsed.isErr()) throw new Error("media upload rejected");
  return parsed.value.id;
};

const OutboxPage = z.object({ orderedItems: z.array(z.unknown()) });

describe("an outbox page", () => {
  it(
    "renders every note as the note renderer does, in a handful of statements",
    { timeout: 60_000 },
    async () => {
      const authorEmail = "outbox-batch@example.com";
      const author = await signedInAccount(authorEmail);
      const [alice, bob] = await Promise.all([
        signedInAccount("outbox-batch-alice@example.com"),
        signedInAccount("outbox-batch-bob@example.com"),
      ]);
      const friend = await post("outbox-batch-alice@example.com", { status: "a local note" });
      const remote = await remoteActor("outbox-batch-remote", "outbox-batch.example");
      const remoteNote = {
        id: "https://outbox-batch.example/notes/1",
        type: "Note",
        attributedTo: remote.actorUri,
        content: "<p>a remote note</p>",
        published: new Date().toISOString(),
        to: [PUBLIC],
        interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
      };
      expect(
        await remote.send({ id: `${remoteNote.id}/create`, type: "Create", object: remoteNote }),
      ).toBe(202);
      const [remoteRow] = parseRows(
        z.object({ id: z.string() }),
        (
          await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
            .bind(remoteNote.id)
            .all()
        ).results,
      );
      if (!remoteRow) throw new Error("remote note not stored");

      // Oldest first: the page lists them newest first.
      await post(authorEmail, { status: "plain" });
      await post(authorEmail, {
        status: "with media",
        media_ids: [await upload(authorEmail, "first"), await upload(authorEmail, "second")],
      });
      await post(authorEmail, {
        status: "sensitive media",
        sensitive: true,
        media_ids: [await upload(authorEmail, "third")],
      });
      const mentionsBoth = await post(authorEmail, {
        status: `@${bob.username} @${alice.username} hello`,
      });
      const mentionsOne = await post(authorEmail, { status: `@${alice.username} again` });
      // Remote mentions, stored as a note that names a cached remote actor stores them.
      for (const status of [mentionsBoth, mentionsOne]) {
        await env.DB.prepare(
          "INSERT INTO status_remote_mentions (status_id, actor_uri) VALUES (?, ?)",
        )
          .bind(status.id, remote.actorUri)
          .run();
      }
      await post(authorEmail, { status: "a local reply", in_reply_to_id: friend.id });
      await post(authorEmail, { status: "a remote reply", in_reply_to_id: remoteRow.id });
      await post(authorEmail, {
        status: "a poll",
        poll: { options: ["yes", "no"], expires_in: 3600 },
      });
      await post(authorEmail, { status: "quoting local", quoted_status_id: friend.id });
      await post(authorEmail, { status: "quoting remote", quoted_status_id: remoteRow.id });
      await post(authorEmail, { status: "nobody quotes", quote_approval_policy: "nobody" });
      await post(authorEmail, { status: "followers quote", quote_approval_policy: "followers" });
      await reblog(authorEmail, friend.id);
      await reblog(authorEmail, remoteRow.id);
      const own = await post(authorEmail, { status: "own" });
      await post(authorEmail, { status: "self reply", in_reply_to_id: own.id });
      await post(authorEmail, { status: "unlisted", visibility: "unlisted" });
      for (let n = 0; n < 4; n += 1) {
        await post(authorEmail, { status: `filler ${n}` });
      }

      patchD1();
      await settle();
      resetMeter();
      const response = await SELF.fetch(
        `${ORIGIN}/users/${author.username}/outbox?page=true`,
        ACTIVITY_JSON,
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      await settle();
      const statements = meter.tally.statements;

      const identity = parseInstanceIdentity(env);
      const account = await findAccountByUsername(env.DB, author.username);
      if (identity.isErr() || account.isErr() || !account.value) throw new Error("setup");
      const ids = parseRows(
        z.object({ id: z.string() }),
        (
          await env.DB.prepare(
            "SELECT id FROM statuses WHERE account_id = ? ORDER BY id DESC LIMIT 20",
          )
            .bind(author.id)
            .all()
        ).results,
      ).map((row) => row.id);
      const statuses = await findStatusesByIds(env.DB, ids);
      if (statuses.isErr()) throw new Error("statuses");
      const emojis = await loadCustomEmojis(env, identity.value.mediaPublicBaseUrl);
      const expected = [];
      for (const id of ids) {
        const status = statuses.value.get(id);
        if (status?.kind === "LocalNote") {
          const note = await loadLocalNoteDocument(env, identity.value, account.value, status, {
            emojis,
          });
          if (note.isErr()) throw new Error("note");
          expected.push(noteCreateActivity(identity.value, account.value, note.value));
        } else if (status?.kind === "LocalReblog") {
          const ref = await statusTargetRef(env, identity.value, status.target);
          if (ref.isErr() || !ref.value) throw new Error("boost");
          expected.push(announceActivity(identity.value, account.value, status, ref.value));
        }
      }
      const page = OutboxPage.parse(JSON.parse(body));
      expect(page.orderedItems).toHaveLength(20);
      expect(JSON.stringify(page.orderedItems)).toBe(JSON.stringify(expected));
      expect(
        statements,
        `the outbox page of ${page.orderedItems.length} statuses made ${statements} statements`,
      ).toBeLessThan(PAGE_STATEMENTS);
    },
  );
});
