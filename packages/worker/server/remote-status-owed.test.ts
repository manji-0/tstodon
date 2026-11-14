import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { unsignedFetch } from "./federated-fetch";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { parseInstanceIdentity } from "./runtime-config";
import { handleScheduled } from "./scheduled-handler";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const DAY_MS = 24 * 60 * 60 * 1000;

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

const runCron = async (schedule: string): Promise<void> => {
  vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  const ctx = createExecutionContext();
  await handleScheduled({ cron: schedule, scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);
  await waitOnExecutionContext(ctx);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sweep of owed remote status work", () => {
  it("deletes the markers no redelivery finished within a week, and logs how many", async () => {
    const author = await remoteActor("owed-sweep");
    const object = {
      id: "https://remote.example/notes/owed-sweep",
      type: "Note",
      attributedTo: author.actorUri,
      content: "<p>hello</p>",
      published: "2026-10-20T00:00:00.000Z",
      to: [PUBLIC],
    };
    expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
    const insert = env.DB.prepare(
      `INSERT INTO remote_status_owed (status_id, kind, token, created_at)
       SELECT id, ?, 'token', ? FROM remote_statuses WHERE object_uri = ?`,
    );
    await env.DB.batch([
      insert.bind("Created", new Date(Date.now() - 8 * DAY_MS).toISOString(), object.id),
      insert.bind("Edited", new Date(Date.now() - 6 * DAY_MS).toISOString(), object.id),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron("17 */6 * * *");

    const kept = parseRows(
      z.object({ kind: z.string() }),
      (await env.DB.prepare("SELECT kind FROM remote_status_owed").all()).results,
    );
    expect(kept).toEqual([{ kind: "Edited" }]);
    expect(warn.mock.calls.map(([line]) => line)).toContain(
      JSON.stringify({ kind: "RemoteStatusOwedAbandoned", created: 1, edited: 0, unstreamed: 0 }),
    );
  });

  it("deletes the marker of a note a QuoteRequest stored that no Create delivered, and warns of nothing", async () => {
    const author = await remoteActor("owed-sweep-unstreamed");
    const object = {
      id: "https://remote.example/notes/owed-sweep-unstreamed",
      type: "Note",
      attributedTo: author.actorUri,
      content: "<p>hello</p>",
      published: "2026-10-20T00:00:00.000Z",
      to: [PUBLIC],
    };
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
      ._unsafeUnwrap()
      .get(author.actorUri);
    if (!signer) {
      throw new Error("signer fixture rejected");
    }
    const stored = await persistRemoteObject(env, identity, signer, object, {
      fetchSigner: unsignedFetch,
      delivery: "QuoteRequest",
    });
    const id = stored.isOk() ? (stored.value?.id ?? "") : "";
    const markers = async () =>
      parseRows(
        z.object({ kind: z.string(), stream_only: z.number() }),
        (
          await env.DB.prepare(
            "SELECT kind, stream_only FROM remote_status_owed WHERE status_id = ?",
          )
            .bind(id)
            .all()
        ).results,
      );
    expect(await markers()).toEqual([{ kind: "Created", stream_only: 1 }]);
    await env.DB.prepare("UPDATE remote_status_owed SET created_at = ? WHERE status_id = ?")
      .bind(new Date(Date.now() - 8 * DAY_MS).toISOString(), id)
      .run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron("17 */6 * * *");

    expect(await markers()).toEqual([]);
    expect(
      warn.mock.calls.filter(([line]) => String(line).includes("RemoteStatusOwedAbandoned")),
    ).toEqual([]);
  });
});
