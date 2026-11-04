#!/usr/bin/env node
/**
 * E2E: Alice@A favourites and boosts Bob@B's post through A's client API.
 * B receives the Like and the Announce: Bob gets both notifications and his
 * post counts them. Alice then unboosts and unfavourites, and B drops the
 * notifications and the counts again.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, B, api, fail, followRemote, signUp, waitFor, waitOk } from "./lib.js";
import { ApiStatus } from "./schemas.js";

const Counts = z
  .object({
    id: z.string(),
    favourited: z.boolean(),
    reblogged: z.boolean(),
    favourites_count: z.number(),
    reblogs_count: z.number(),
  })
  .passthrough();

const Notifications = z.array(
  z
    .object({
      type: z.string(),
      account: z.object({ uri: z.string() }).passthrough(),
      status: z.object({ id: z.string() }).passthrough().nullable().optional(),
    })
    .passthrough(),
);

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice");
  const bob = await signUp(B, "bob");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);
  await followRemote(alice, bob);
  console.log("ok alice follows bob");

  const post = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob posts", {
    method: "POST",
    body: { status: `engage with me ${Date.now()}`, visibility: "public" },
  });
  const onA = await waitFor("bob's post on alice's home", async () => {
    const home = await api(A, alice.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find((status) => status.uri === post.uri);
  });
  console.log("ok bob's post on A", onA.id);

  const act = (action: string) =>
    api(
      A,
      alice.headers,
      `/api/v1/statuses/${onA.id}/${action}`,
      schemaResult(z.unknown()),
      action,
      {
        method: "POST",
      },
    );
  const countsOnA = () =>
    api(A, alice.headers, `/api/v1/statuses/${onA.id}`, schemaResult(Counts), "status on A");
  const countsOnB = () =>
    api(B, bob.headers, `/api/v1/statuses/${post.id}`, schemaResult(Counts), "status on B");
  const bobsNotices = async () =>
    (
      await api(B, bob.headers, "/api/v1/notifications", schemaResult(Notifications), "notices")
    ).filter((notice) => notice.account.uri === alice.uri && notice.status?.id === post.id);

  await act("favourite");
  await act("reblog");
  const engaged = await countsOnA();
  if (!engaged.favourited || !engaged.reblogged || engaged.favourites_count !== 1) {
    return fail("alice's favourite and boost do not show on A", engaged);
  }
  console.log("ok A: favourited and reblogged");

  const notices = await waitFor("bob's favourite and reblog notifications from alice", async () => {
    const types = (await bobsNotices()).map((notice) => notice.type).toSorted();
    return types.join(",") === "favourite,reblog" ? types : undefined;
  });
  console.log("ok B: notifications", notices.join(", "));
  await waitFor("bob's post counts alice's favourite and boost", async () => {
    const counts = await countsOnB();
    return counts.favourites_count === 1 && counts.reblogs_count === 1 ? counts : undefined;
  });
  console.log("ok B: favourites_count 1, reblogs_count 1");

  await act("unreblog");
  await act("unfavourite");
  const withdrawn = await countsOnA();
  if (withdrawn.favourited || withdrawn.reblogged || withdrawn.favourites_count !== 0) {
    return fail("alice's favourite or boost still shows on A", withdrawn);
  }
  console.log("ok A: unfavourited and unreblogged");

  await waitFor("bob's notifications from alice are gone", async () =>
    (await bobsNotices()).length === 0 ? true : undefined,
  );
  await waitFor("bob's post counts drop to zero", async () => {
    const counts = await countsOnB();
    return counts.favourites_count === 0 && counts.reblogs_count === 0 ? counts : undefined;
  });
  console.log("ok B: Undo Like and Undo Announce applied");
  console.log("PASS federation remote engagement");
};

main().catch((error: unknown) => fail("unhandled", error));
