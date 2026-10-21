import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { remoteActor } from "../test/remote-actor-fixture";

const storedNote = async (objectUri: string): Promise<number> =>
  (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_statuses WHERE object_uri = ?")
      .bind(objectUri)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("remote Delete", () => {
  it("removes a cached note only for its author", async () => {
    const author = await remoteActor("delete-author");
    const impostor = await remoteActor("delete-impostor", "elsewhere.example");
    const objectUri = "https://remote.example/notes/delete-me";
    expect(
      await author.send({
        id: "https://remote.example/activities/create-delete-me",
        type: "Create",
        object: {
          id: objectUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>mine</p>",
          published: "2026-10-20T00:00:00.000Z",
          to: ["https://www.w3.org/ns/activitystreams#Public"],
        },
      }),
    ).toBe(202);
    expect(await storedNote(objectUri)).toBe(1);

    // Someone else's Delete leaves it alone.
    expect(
      await impostor.send({
        id: "https://elsewhere.example/activities/delete-not-mine",
        type: "Delete",
        object: objectUri,
      }),
    ).toBe(202);
    expect(await storedNote(objectUri)).toBe(1);

    expect(
      await author.send({
        id: "https://remote.example/activities/delete-mine",
        type: "Delete",
        object: objectUri,
      }),
    ).toBe(202);
    expect(await storedNote(objectUri)).toBe(0);
  });
});
