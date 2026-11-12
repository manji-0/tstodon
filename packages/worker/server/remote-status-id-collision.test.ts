import { env } from "cloudflare:test";
import { IsoInstant, RemoteStatus, StatusId } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { remoteActor } from "../test/remote-actor-fixture";
import { entityIdAt } from "./ids";
import { findRemoteStatusByObjectUri, upsertRemoteStatus } from "./remote-status-store";

const note = (actorUri: string, objectUri: string, id: string) => {
  const parsedId = StatusId.parse(id);
  const publishedAt = IsoInstant.parse("2024-03-03T00:00:00.000Z");
  if (parsedId.isErr() || publishedAt.isErr()) {
    throw new Error("fixture rejected");
  }
  const status = RemoteStatus.fromFetched({
    id: parsedId.value,
    actorUri,
    objectUri,
    contentHtml: "<p>same second</p>",
    spoilerText: "",
    visibility: { kind: "Public" },
    sensitive: false,
    language: { kind: "None" },
    publishedAt: publishedAt.value,
  });
  if (status.isErr()) {
    throw new Error("remote status fixture rejected");
  }
  return status.value;
};

describe("remote status ids", () => {
  it("stores two notes whose generated ids collide, at the same instant", async () => {
    const author = await remoteActor("id_collision");
    const id = entityIdAt(Date.parse("2024-03-03T00:00:00.000Z"));
    const first = `${author.actorUri}/statuses/first`;
    const second = `${author.actorUri}/statuses/second`;

    const stored = await upsertRemoteStatus(env.DB, note(author.actorUri, first, id), []);
    const collided = await upsertRemoteStatus(env.DB, note(author.actorUri, second, id), []);

    expect(stored.isOk() && collided.isOk()).toBe(true);
    const a = await findRemoteStatusByObjectUri(env.DB, first);
    const b = await findRemoteStatusByObjectUri(env.DB, second);
    const aId = a.isOk() ? a.value?.id : undefined;
    const bId = b.isOk() ? b.value?.id : undefined;
    expect(aId).toBe(id);
    expect(bId).toBeDefined();
    expect(bId).not.toBe(id);
    // The retried id keeps the instant, so the note still sorts where it was published.
    expect(BigInt(bId ?? "0") >> 16n).toBe(BigInt(id) >> 16n);
  });
});
