import { describe, expect, it } from "vite-plus/test";
import { OutboxBackfill, type OutboxBackfillItem } from "./outbox-backfill";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const actorUri = "https://peer.test:8792/users/bob";
const open = { to: [PUBLIC], cc: [] };
const followersOnly = { to: [`${actorUri}/followers`], cc: [] };

const create = (overrides: Partial<OutboxBackfillItem> = {}): OutboxBackfillItem => ({
  type: "Create",
  id: `${actorUri}/statuses/1/activity`,
  actor: actorUri,
  object: { kind: "Embedded", uri: `${actorUri}/statuses/1`, audience: open },
  audience: open,
  ...overrides,
});

describe("OutboxBackfill.decide", () => {
  it("stores the actor's own public note from its host", () => {
    expect(OutboxBackfill.decide(actorUri, create())).toEqual({ kind: "StoreNote" });
    expect(
      OutboxBackfill.decide(
        actorUri,
        create({ object: { kind: "Uri", uri: `${actorUri}/statuses/1` } }),
      ),
    ).toEqual({ kind: "StoreNote" });
  });

  it("ignores an item attributed to someone else or published from another host", () => {
    expect(
      OutboxBackfill.decide(actorUri, create({ actor: "https://peer.test:8792/users/eve" })),
    ).toEqual({ kind: "Ignore" });
    expect(
      OutboxBackfill.decide(actorUri, create({ id: "https://peer.test/statuses/1/activity" })),
    ).toEqual({ kind: "Ignore" });
  });

  it("ignores a note from another host or one that is not public", () => {
    expect(
      OutboxBackfill.decide(
        actorUri,
        create({ object: { kind: "Uri", uri: "https://other.test/statuses/1" } }),
      ),
    ).toEqual({ kind: "Ignore" });
    expect(
      OutboxBackfill.decide(
        actorUri,
        create({
          audience: followersOnly,
          object: { kind: "Uri", uri: `${actorUri}/statuses/1` },
        }),
      ),
    ).toEqual({ kind: "Ignore" });
  });

  it("reads a Create's audience from its embedded note", () => {
    const unaddressed = { to: [], cc: [] };
    expect(OutboxBackfill.decide(actorUri, create({ audience: unaddressed }))).toEqual({
      kind: "StoreNote",
    });
    expect(
      OutboxBackfill.decide(
        actorUri,
        create({
          audience: open,
          object: { kind: "Embedded", uri: `${actorUri}/statuses/1`, audience: followersOnly },
        }),
      ),
    ).toEqual({ kind: "Ignore" });
  });

  it("stores a public boost, fetching a note announced from another host", () => {
    const announce = (uri: string): OutboxBackfillItem =>
      create({ type: "Announce", object: { kind: "Uri", uri } });
    expect(OutboxBackfill.decide(actorUri, announce(`${actorUri}/statuses/2`))).toEqual({
      kind: "StoreBoost",
    });
    expect(OutboxBackfill.decide(actorUri, announce("https://other.test/statuses/9"))).toEqual({
      kind: "FetchBoost",
    });
  });

  it("reads an Announce's audience from the activity, not the embedded note", () => {
    expect(
      OutboxBackfill.decide(
        actorUri,
        create({
          type: "Announce",
          audience: followersOnly,
          object: { kind: "Embedded", uri: `${actorUri}/statuses/2`, audience: open },
        }),
      ),
    ).toEqual({ kind: "Ignore" });
  });
});

describe("OutboxBackfill.onActorHost", () => {
  it("compares the authority, port included", () => {
    expect(OutboxBackfill.onActorHost("https://PEER.test:8792/outbox?page=2", actorUri)).toBe(true);
    expect(OutboxBackfill.onActorHost("https://peer.test/outbox?page=2", actorUri)).toBe(false);
  });
});
