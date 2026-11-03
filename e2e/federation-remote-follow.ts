#!/usr/bin/env node
/**
 * E2E: Alice@A follows Bob@B through the client API, with no host-driven hops.
 * A resolves Bob, sends Follow; B accepts; Bob's new post reaches Alice's
 * home, public, hashtag and list timelines and their streams; Bob deletes it
 * and it leaves her home; Alice unfollows and B drops her as a follower.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, B, api, fail, followRemote, openStream, signUp, waitFor, waitOk } from "./lib.js";
import { ApiAccount, ApiStatus, Relationship } from "./schemas.js";

const ListSchema = { parse: schemaResult(z.object({ id: z.string().min(1) }).passthrough()) };
const Anything = schemaResult(z.unknown());

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice");
  const bob = await signUp(B, "bob");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);

  const bobOnA = await followRemote(alice, bob);
  console.log("ok Follow → Accept: alice follows bob", bobOnA.id);
  await waitFor("B counts alice as a follower", async () => {
    const account = await api(
      B,
      bob.headers,
      `/api/v1/accounts/${bob.id}`,
      ApiAccount.parse,
      "bob",
    );
    return account.followers_count === 1 ? account : undefined;
  });
  console.log("ok B counts alice as bob's follower");

  const list = await api(A, alice.headers, "/api/v1/lists", ListSchema.parse, "create list", {
    method: "POST",
    body: { title: "remote friends" },
  });
  await api(A, alice.headers, `/api/v1/lists/${list.id}/accounts`, Anything, "add bob to list", {
    method: "POST",
    body: { account_ids: [bobOnA.id] },
  });
  const tag = `e2e${Date.now().toString(36)}`;
  const streams = {
    user: await openStream(A, alice.headers, { stream: "user" }),
    public: await openStream(A, alice.headers, { stream: "public" }),
    hashtag: await openStream(A, alice.headers, { stream: "hashtag", tag }),
    list: await openStream(A, alice.headers, { stream: "list", list: list.id }),
  };

  const text = `bob to his followers #${tag} ${Date.now()}`;
  const posted = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob posts", {
    method: "POST",
    body: { status: text, visibility: "public" },
  });
  const timelines = {
    home: "/api/v1/timelines/home",
    public: "/api/v1/timelines/public",
    hashtag: `/api/v1/timelines/tag/${tag}`,
    list: `/api/v1/timelines/list/${list.id}`,
  };
  for (const [name, path] of Object.entries(timelines)) {
    const found = await waitFor(`bob's post on alice's ${name} timeline`, async () => {
      const statuses = await api(A, alice.headers, path, ApiStatus.parseMany, name);
      return statuses.find((status) => status.uri === posted.uri);
    });
    if (!found.content.includes(tag) || found.account.uri !== bob.uri) {
      return fail(`${name} timeline status does not match bob's post`, found);
    }
  }
  console.log("ok bob's post on alice's home, public, hashtag and list timelines");
  for (const [name, stream] of Object.entries(streams)) {
    await waitFor(`bob's post on alice's ${name} stream`, async () =>
      stream.updated.has(posted.uri) ? true : undefined,
    );
    stream.close();
  }
  console.log("ok bob's post streamed to alice's user, public, hashtag and list streams");

  await api(B, bob.headers, `/api/v1/statuses/${posted.id}`, Anything, "bob deletes", {
    method: "DELETE",
  });
  await waitFor("bob's deleted post leaves alice's home", async () => {
    const home = await api(A, alice.headers, timelines.home, ApiStatus.parseMany, "home");
    return home.some((status) => status.uri === posted.uri) ? undefined : true;
  });
  console.log("ok Delete: bob's post left alice's home");

  await api(
    A,
    alice.headers,
    `/api/v1/accounts/${bobOnA.id}/unfollow`,
    Relationship.parse,
    "unfollow",
    {
      method: "POST",
    },
  );
  await waitFor("B drops alice after Undo Follow", async () => {
    const account = await api(
      B,
      bob.headers,
      `/api/v1/accounts/${bob.id}`,
      ApiAccount.parse,
      "bob",
    );
    return account.followers_count === 0 ? account : undefined;
  });
  console.log("ok Undo Follow: B dropped alice");
  console.log("PASS federation remote follow");
};

main().catch((error: unknown) => fail("unhandled", error));
