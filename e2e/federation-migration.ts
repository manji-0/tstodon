#!/usr/bin/env node
/**
 * E2E: Alice@A moves to Bob@B. Bob lists Alice as an alias on B's settings
 * page; Alice starts the move on A's settings page. B's Carol, who follows
 * Alice, ends up following Bob; A's Dave, a local follower, follows Bob
 * across instances; Alice shows as moved on both and can no longer post.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import {
  A,
  B,
  api,
  type E2eUser,
  fail,
  followRemote,
  getJson,
  signUp,
  waitFor,
  waitOk,
} from "./lib.js";
import { Relationship } from "./schemas.js";

const MovedAccount = schemaResult(
  z.object({ moved: z.object({ id: z.string(), uri: z.string() }).optional() }).passthrough(),
);
const Notifications = schemaResult(
  z.array(
    z
      .object({
        type: z.string(),
        account: z.object({ uri: z.string() }).passthrough(),
        target: z.object({ id: z.string(), uri: z.string() }).passthrough().optional(),
      })
      .passthrough(),
  ),
);

/** Post a settings form with the user's browser session; the page it answers with. */
const postSettings = async (
  user: E2eUser,
  path: string,
  fields: Record<string, string>,
  label: string,
): Promise<string> => {
  const response = await user.browser(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const page = await response.text();
  if (!response.ok) {
    return fail(`${label} (HTTP ${response.status})`, page);
  }
  return page;
};

const following = async (user: E2eUser, id: string) => {
  const [state] = await api(
    user.origin,
    user.headers,
    `/api/v1/accounts/relationships?id[]=${encodeURIComponent(id)}`,
    Relationship.parseMany,
    "relationship",
  );
  return state?.following === true ? state : undefined;
};

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice");
  const dave = await signUp(A, "dave");
  const bob = await signUp(B, "bob");
  const carol = await signUp(B, "carol");
  console.log(`ok users ${alice.acct}, ${dave.acct}, ${bob.acct}, ${carol.acct}`);

  const aliceOnB = await followRemote(carol, alice);
  await api(A, dave.headers, `/api/v1/accounts/${alice.id}/follow`, Relationship.parse, "follow", {
    method: "POST",
    body: {},
  });
  console.log("ok carol@B and dave@A follow alice");

  const aliases = await postSettings(
    bob,
    "/settings/aliases",
    { acct: alice.acct },
    "bob adds alice as an alias",
  );
  if (!aliases.includes(alice.username)) {
    return fail("alias page does not list alice", aliases);
  }
  console.log("ok bob@B lists alice as the account he moved from");

  const moved = await postSettings(
    alice,
    "/settings/migration",
    { acct: bob.acct },
    "alice moves to bob",
  );
  if (!moved.includes("Your followers are moving to")) {
    return fail("migration page did not confirm the move", moved);
  }
  const aliceOnA = await api(
    A,
    alice.headers,
    `/api/v1/accounts/${alice.id}`,
    MovedAccount,
    "alice",
  );
  if (aliceOnA.moved?.uri !== bob.uri) {
    return fail("alice on A is not moved to bob", aliceOnA);
  }
  const posted = await getJson(`${A}/api/v1/statuses`, {
    method: "POST",
    headers: { ...alice.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "after the move" }),
  });
  if (posted.status !== 403) {
    return fail(`alice posted after moving (HTTP ${posted.status})`, posted.body);
  }
  console.log("ok alice@A moved to bob and can no longer post");

  await waitFor("carol follows bob after the Move", () => following(carol, bob.id));
  const aliceSeenOnB = await waitFor("B shows alice as moved", async () => {
    const account = await api(
      B,
      carol.headers,
      `/api/v1/accounts/${aliceOnB.id}`,
      MovedAccount,
      "alice on B",
    );
    return account.moved ? account : undefined;
  });
  if (aliceSeenOnB.moved?.id !== bob.id) {
    return fail("alice on B is not moved to bob", aliceSeenOnB);
  }
  console.log("ok Move on B: carol follows bob, alice shows as moved to bob");

  const notice = await waitFor("dave hears of the move", async () => {
    const list = await api(
      A,
      dave.headers,
      "/api/v1/notifications",
      Notifications,
      "notifications",
    );
    return list.find((entry) => entry.type === "move" && entry.target?.uri === bob.uri);
  });
  const bobOnA = notice.target?.id ?? "";
  await waitFor("bob accepts dave's follow", () => following(dave, bobOnA));
  console.log("ok dave@A follows bob@B after alice's move");
  console.log("PASS federation migration");
};

main().catch((error: unknown) => fail("unhandled", error));
