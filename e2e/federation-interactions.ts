#!/usr/bin/env node
/**
 * E2E interactions, each sent by B's Worker through B's client API: Bob@B
 * follows Alice@A, favourites and boosts her post, unfavourites it, then
 * unfollows her. A applies the Like, the Announce, the Undo Like and the
 * Undo Follow.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, B, api, fail, followRemote, signUp, waitFor, waitOk } from "./lib.js";
import { ApiAccount, ApiStatus, MastodonStatus, Relationship } from "./schemas.js";

const Anything = schemaResult(z.unknown());

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice-ix");
  const bob = await signUp(B, "bob-ix");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);

  const aliceOnB = await followRemote(bob, alice);
  const followersOnA = (count: number) =>
    waitFor(`A counts ${count} followers of alice`, async () => {
      const account = await api(
        A,
        alice.headers,
        `/api/v1/accounts/${alice.id}`,
        ApiAccount.parse,
        "alice",
      );
      return account.followers_count === count ? account : undefined;
    });
  await followersOnA(1);
  console.log("ok Follow");

  const posted = await api(A, alice.headers, "/api/v1/statuses", ApiStatus.parse, "alice posts", {
    method: "POST",
    body: { status: `interact me ${Date.now()}`, visibility: "public" },
  });
  const onB = await waitFor("alice's post on bob's home", async () => {
    const home = await api(B, bob.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find((status) => status.uri === posted.uri);
  });
  console.log(`ok alice status ${posted.id} on B as ${onB.id}`);

  const act = (action: string) =>
    api(B, bob.headers, `/api/v1/statuses/${onB.id}/${action}`, Anything, action, {
      method: "POST",
    });
  const countsOnA = (favourites: number, reblogs: number, label: string) =>
    waitFor(label, async () => {
      const status = await api(
        A,
        alice.headers,
        `/api/v1/statuses/${posted.id}`,
        MastodonStatus.parse,
        "status on A",
      );
      return status.favourites_count === favourites && status.reblogs_count === reblogs
        ? status
        : undefined;
    });

  await act("favourite");
  await countsOnA(1, 0, "A counts bob's Like");
  console.log("ok Like");
  await act("reblog");
  await countsOnA(1, 1, "A counts bob's Announce");
  console.log("ok Announce");
  await act("unfavourite");
  await countsOnA(0, 1, "A drops bob's Like after Undo Like");
  console.log("ok Undo Like");

  await api(
    B,
    bob.headers,
    `/api/v1/accounts/${aliceOnB.id}/unfollow`,
    Relationship.parse,
    "unfollow",
    {
      method: "POST",
    },
  );
  await followersOnA(0);
  console.log("ok Undo Follow");

  console.log("PASS federation interactions");
};

main().catch((error: unknown) => fail("unhandled", error));
