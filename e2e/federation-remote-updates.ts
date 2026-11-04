#!/usr/bin/env node
/**
 * E2E: what Alice@A sees of Bob@B once she follows him, all through the client
 * API: Bob's profile on A backfills a post from before the follow, Bob boosts Carol's note (a reblog on Alice's home), Bob edits a post
 * (Alice sees the edit), and Bob posts a poll that Alice votes on (B counts
 * her vote; B's debounced Update(Question) brings Carol's vote back to A).
 *
 * The Update waits POLL_UPDATE_DELAY_SECONDS on B (5 s in e2e/b.wrangler.jsonc; 180 s by default).
 */
import { A, B, api, fail, followRemote, signUp, waitFor, waitOk } from "./lib.js";
import { ApiPoll, ApiStatus } from "./schemas.js";

const homeStatus = async (
  alice: Awaited<ReturnType<typeof signUp>>,
  label: string,
  match: (status: ApiStatus) => boolean,
): Promise<ApiStatus> =>
  waitFor(label, async () => {
    const home = await api(A, alice.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find(match);
  });

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice");
  const bob = await signUp(B, "bob");
  const carol = await signUp(B, "carol");
  console.log(`ok users ${alice.acct}, ${bob.acct}, ${carol.acct}`);
  const earlier = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob posts", {
    method: "POST",
    body: { status: `before anyone on A followed ${Date.now()}`, visibility: "public" },
  });
  const bobOnA = await followRemote(alice, bob);
  console.log("ok alice follows bob");

  await waitFor("A backfills bob's earlier post from his outbox", async () => {
    const statuses = await api(
      A,
      alice.headers,
      `/api/v1/accounts/${bobOnA.id}/statuses`,
      ApiStatus.parseMany,
      "bob's statuses on A",
    );
    return statuses.some((status) => status.uri === earlier.uri) ? true : undefined;
  });
  console.log("ok outbox backfill: bob's earlier post on his profile on A");

  const carolNote = await api(B, carol.headers, "/api/v1/statuses", ApiStatus.parse, "carol", {
    method: "POST",
    body: { status: `carol's note ${Date.now()}`, visibility: "public" },
  });
  await api(B, bob.headers, `/api/v1/statuses/${carolNote.id}/reblog`, ApiStatus.parse, "boost", {
    method: "POST",
  });
  const boost = await homeStatus(
    alice,
    "bob's boost on alice's home",
    (status) => status.reblog?.uri === carolNote.uri,
  );
  if (boost.account.uri !== bob.uri || boost.reblog?.account.uri !== carol.uri) {
    return fail("boost on alice's home is not bob reblogging carol", boost);
  }
  console.log("ok Announce: bob's boost of carol on alice's home", boost.id);
  // The peer's port stays in the handle, as Mastodon renders it.
  if (boost.account.acct !== bob.acct.replace(/^@/, "")) {
    return fail(`bob appears on A as ${boost.account.acct}, not ${bob.acct}`, boost);
  }
  console.log("ok remote acct keeps the port", boost.account.acct);

  const original = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob posts", {
    method: "POST",
    body: { status: `before the edit ${Date.now()}`, visibility: "public" },
  });
  const seen = await homeStatus(
    alice,
    "bob's post on alice's home",
    (status) => status.uri === original.uri,
  );
  const editedText = `after the edit ${Date.now()}`;
  await api(B, bob.headers, `/api/v1/statuses/${original.id}`, ApiStatus.parse, "bob edits", {
    method: "PUT",
    body: { status: editedText },
  });
  const edited = await waitFor("alice sees bob's edit", async () => {
    const status = await api(A, alice.headers, `/api/v1/statuses/${seen.id}`, ApiStatus.parse, "s");
    return status.content.includes(editedText) ? status : undefined;
  });
  if (!edited.edited_at) {
    return fail("edited status on A has no edited_at", edited);
  }
  console.log("ok Update: alice sees bob's edit, edited_at", edited.edited_at);

  const pollNote = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob's poll", {
    method: "POST",
    body: {
      status: `poll ${Date.now()}`,
      visibility: "public",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    },
  });
  const pollId = pollNote.poll?.id;
  if (!pollId) {
    return fail("bob's poll status has no poll", pollNote);
  }
  const remotePoll = await homeStatus(
    alice,
    "bob's poll on alice's home",
    (status) => status.uri === pollNote.uri,
  );
  const remotePollId = remotePoll.poll?.id;
  if (!remotePollId || remotePoll.poll?.options.length !== 2) {
    return fail("bob's poll on A has no options", remotePoll);
  }
  console.log("ok Question: bob's poll on alice's home");

  await api(A, alice.headers, `/api/v1/polls/${remotePollId}/votes`, ApiPoll.parse, "vote", {
    method: "POST",
    body: { choices: [0] },
  });
  await waitFor("B counts alice's vote", async () => {
    const poll = await api(B, bob.headers, `/api/v1/polls/${pollId}`, ApiPoll.parse, "poll on B");
    return poll.votes_count === 1 && poll.options[0]?.votes_count === 1 ? poll : undefined;
  });
  console.log("ok vote: B counts alice's vote");

  await api(B, carol.headers, `/api/v1/polls/${pollId}/votes`, ApiPoll.parse, "carol votes", {
    method: "POST",
    body: { choices: [1] },
  });
  const started = Date.now();
  const updated = await waitFor(
    "A gets B's poll Update with carol's vote",
    async () => {
      const poll = await api(A, alice.headers, `/api/v1/polls/${remotePollId}`, ApiPoll.parse, "p");
      return poll.votes_count === 2 && poll.options[1]?.votes_count === 1 ? poll : undefined;
    },
    60_000,
    2_000,
  );
  if (!updated.voted) {
    return fail("alice's poll on A forgot her vote", updated);
  }
  console.log(
    `ok Update(Question): A has both votes after ${Math.round((Date.now() - started) / 1000)} s`,
  );
  console.log("PASS federation remote updates");
};

main().catch((error: unknown) => fail("unhandled", error));
