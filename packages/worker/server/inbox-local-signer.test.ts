import { schemaResult } from "@tstodon/core";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiNotification, ApiRelationship, ApiStatus } from "@tstodon/api";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { signInboxRequest } from "./http-signature";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

/** POST an activity to the shared inbox, signed with a local account's key. */
const postSignedBy = async (
  email: string,
  activity: Readonly<{ id: string; type: string; object: unknown }>,
): Promise<number> => {
  const account = await signedInAccount(email);
  const actor = `https://example.com/users/${account.username}`;
  const body = JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    actor,
    ...activity,
  });
  const headers = await signInboxRequest(
    new URL("https://example.com/inbox"),
    account.privateKeyJwk,
    `${actor}#main-key`,
    body,
  );
  if (headers.isErr()) {
    throw new Error(headers.error.message);
  }
  const response = await SELF.fetch("https://example.com/inbox", {
    method: "POST",
    headers: headers.value,
    body,
  });
  return response.status;
};

const postStatus = async (email: string, text: string) => {
  const created = await json("/api/v1/statuses", {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify({ status: text }),
  });
  expect(created.status).toBe(200);
  const status = read(ApiStatus, created.body);
  return {
    ...status,
    uri: `https://example.com/users/${status.account.username}/statuses/${status.id}`,
  };
};

describe("inbox activities signed by a local account", () => {
  it("follows on Follow and unfollows on Undo", async () => {
    const target = await signedInAccount("ls-follow-target@example.com");
    const targetUri = `https://example.com/users/${target.username}`;
    const following = async () => {
      const relationships = await json(`/api/v1/accounts/relationships?id=${target.id}`, {
        headers: await authHeaders("ls-follower@example.com"),
      });
      return read(z.array(ApiRelationship), relationships.body)[0]?.following;
    };

    expect(
      await postSignedBy("ls-follower@example.com", {
        id: "https://example.com/activities/ls-follow",
        type: "Follow",
        object: targetUri,
      }),
    ).toBe(202);
    expect(await following()).toBe(true);

    expect(
      await postSignedBy("ls-follower@example.com", {
        id: "https://example.com/activities/ls-undo-follow",
        type: "Undo",
        object: targetUri,
      }),
    ).toBe(202);
    expect(await following()).toBe(false);
  });

  it("notifies once when the same Follow arrives under a second activity id", async () => {
    const target = await signedInAccount("ls-refollow-target@example.com");
    const targetUri = `https://example.com/users/${target.username}`;
    for (const id of ["ls-refollow-1", "ls-refollow-2"]) {
      expect(
        await postSignedBy("ls-refollower@example.com", {
          id: `https://example.com/activities/${id}`,
          type: "Follow",
          object: targetUri,
        }),
      ).toBe(202);
    }
    const notifications = await json("/api/v1/notifications", {
      headers: await authHeaders("ls-refollow-target@example.com"),
    });
    expect(read(z.array(ApiNotification), notifications.body).map((n) => n.type)).toEqual([
      "follow",
    ]);
  });

  it("refuses a Follow of an account that blocks the follower", async () => {
    const target = await signedInAccount("ls-blocking-target@example.com");
    const follower = await signedInAccount("ls-blocked-follower@example.com");
    const blocked = await json(`/api/v1/accounts/${follower.id}/block`, {
      method: "POST",
      headers: await authHeaders("ls-blocking-target@example.com"),
    });
    expect(blocked.status).toBe(200);

    expect(
      await postSignedBy("ls-blocked-follower@example.com", {
        id: "https://example.com/activities/ls-blocked-follow",
        type: "Follow",
        object: `https://example.com/users/${target.username}`,
      }),
    ).toBe(202);
    const relationships = await json(`/api/v1/accounts/relationships?id=${target.id}`, {
      headers: await authHeaders("ls-blocked-follower@example.com"),
    });
    expect(read(z.array(ApiRelationship), relationships.body)[0]?.following).toBe(false);
  });

  it("favourites a local status on Like", async () => {
    const status = await postStatus("ls-like-author@example.com", "like me");
    expect(
      await postSignedBy("ls-liker@example.com", {
        id: "https://example.com/activities/ls-like",
        type: "Like",
        object: status.uri,
      }),
    ).toBe(202);
    const seen = await json(`/api/v1/statuses/${status.id}`, {
      headers: await authHeaders("ls-liker@example.com"),
    });
    const parsed = read(ApiStatus, seen.body);
    expect(parsed.favourited).toBe(true);
    expect(parsed.favourites_count).toBe(1);
  });

  it("boosts a local status on Announce", async () => {
    const status = await postStatus("ls-boost-author@example.com", "boost me");
    expect(
      await postSignedBy("ls-booster@example.com", {
        id: "https://example.com/activities/ls-announce",
        type: "Announce",
        object: status.uri,
      }),
    ).toBe(202);
    const seen = await json(`/api/v1/statuses/${status.id}`, {
      headers: await authHeaders("ls-booster@example.com"),
    });
    expect(read(ApiStatus, seen.body).reblogs_count).toBe(1);
  });

  it("accepts and ignores a Create, which only remote signers deliver", async () => {
    expect(
      await postSignedBy("ls-creator@example.com", {
        id: "https://example.com/activities/ls-create",
        type: "Create",
        object: { id: "https://example.com/notes/ls-create", type: "Note", content: "hi" },
      }),
    ).toBe(202);
  });
});
