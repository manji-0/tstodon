/** Sweep area INT-5: quote policies (nobody, followers, manual), a revoked quote, a deleted quoted post, a policy change, the quote notification, and quotes that wait for an answer. */
import { z } from "zod";
import { A, signUp, sleep, type E2eUser } from "../lib.js";
import {
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  mastodonDeliver,
  mastodonRails,
  notified,
  Notifications,
  onHome,
  post,
  resolveStatus,
  Status,
  Statuses,
  step,
  StepFailure,
  fetchWaitingOutRateLimit,
  tstodonSql,
} from "./sweep.js";

const QuoteApproval = z.looseObject({
  quote_approval: z.looseObject({ current_user: z.string() }).optional(),
});

/**
 * `quoter` tries to quote its copy `targetId`. The state its server settles
 * on: `refused` when the API does not take the post at all.
 */
const quoteState = async (quoter: E2eUser, targetId: string, text: string): Promise<string> => {
  const response = await fetchWaitingOutRateLimit(quoter, `/api/v1/statuses`, {
    method: "POST",
    headers: { ...quoter.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ status: text, visibility: "public", quoted_status_id: targetId }),
  });
  const body: unknown = await response.json();
  if (response.status >= 400 && response.status < 500) {
    return "refused";
  }
  const sent = Status.parse(body);
  return eventually("the quote leaves pending", async () => {
    const now = await call(quoter, `/api/v1/statuses/${sent.id}`, Status);
    return now.quote && now.quote.state !== "pending" ? now.quote.state : undefined;
  });
};

/** A quote of `target` that both servers show accepted; the quoting post, and the quoted author's copy of it. */
const acceptedQuote = async (
  quoter: E2eUser,
  author: E2eUser,
  target: Status,
  text: string,
): Promise<{ sent: Status; copy: Status }> => {
  const targetOnQuoter = await onHome(quoter, target.uri);
  const sent = await post(quoter, { status: text, quoted_status_id: targetOnQuoter.id });
  await eventually("the quoter's server shows the quote accepted", async () =>
    (await call(quoter, `/api/v1/statuses/${sent.id}`, Status)).quote?.state === "accepted"
      ? true
      : undefined,
  );
  const copy = await onHome(author, sent.uri);
  return { sent, copy };
};

const stateBecomes = async (
  viewer: E2eUser,
  statusId: string,
  label: string,
  accept: (state: string | undefined) => boolean,
): Promise<void> => {
  let last: string | undefined;
  await eventually(label, async () => {
    last = (await call(viewer, `/api/v1/statuses/${statusId}`, Status)).quote?.state;
    return accept(last) ? true : undefined;
  }).catch((error: unknown) => {
    throw new StepFailure(
      `${error instanceof Error ? error.message : String(error)}; the state is ${String(last)}`,
    );
  });
};

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** The terms of Mastodon's own contexts for a quote policy and a quote request. */
const QUOTE_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  {
    gts: "https://gotosocial.org/ns#",
    interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
    canQuote: { "@id": "gts:canQuote", "@type": "@id" },
    automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
    manualApproval: { "@id": "gts:manualApproval", "@type": "@id" },
    QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest",
  },
];

/**
 * A public note from `author` that anyone may quote with the author's manual
 * approval, delivered to `reader`'s inbox. Mastodon never writes
 * `manualApproval` (its `NoteSerializer#interaction_policy` writes the
 * automatic policy only), though its `StatusParser#quote_policy` reads it, as
 * GoToSocial writes it. Mastodon holds no status under the note's URI, so it
 * drops the `QuoteRequest` that names it (`QuoteRequest#perform` finds no
 * quoted status): the quote waits, as for an author yet to decide.
 */
const deliverManualNote = (author: E2eUser, reader: E2eUser, slug: string): string => {
  const noteUri = `${author.uri}/statuses/${slug}`;
  const published = new Date().toISOString();
  mastodonDeliver(
    author,
    {
      "@context": QUOTE_CONTEXT,
      id: `${noteUri}/activity`,
      type: "Create",
      actor: author.uri,
      published,
      to: [PUBLIC],
      cc: [`${author.uri}/followers`],
      object: {
        id: noteUri,
        type: "Note",
        attributedTo: author.uri,
        content: `<p>${slug}</p>`,
        published,
        to: [PUBLIC],
        cc: [`${author.uri}/followers`],
        interactionPolicy: { canQuote: { manualApproval: [PUBLIC] } },
      },
    },
    `${A}/users/${reader.username}/inbox`,
  );
  return noteUri;
};

const QuoteRow = z.object({ activity_uri: z.string() });
/**
 * The id of the `QuoteRequest` tstodon sent for its local status
 * `quotingId`, once tstodon delivered it to the quoted author's inbox.
 */
const deliveredQuoteRequest = (quotingId: string): Promise<string> =>
  eventually("tstodon delivered the QuoteRequest", async () => {
    const [quote] = tstodonSql(
      `SELECT activity_uri FROM status_quotes WHERE status_id = '${quotingId}'`,
    );
    const parsed = QuoteRow.safeParse(quote);
    if (!parsed.success) {
      return undefined;
    }
    const uri = parsed.data.activity_uri;
    const delivered = tstodonSql(
      `SELECT 1 FROM outbox_deliveries d JOIN outbound_activities a ON a.id = d.activity_id
       WHERE a.kind = 'QuoteRequest' AND json_extract(a.payload_json, '$.id') = '${uri}'
         AND d.inbox_url IS NOT NULL AND d.kind = 'Delivered'`,
    );
    return delivered.length > 0 ? uri : undefined;
  });

/**
 * The quoted author's answer to a held `QuoteRequest`, as Mastodon's
 * `AcceptQuoteRequestSerializer` and `RejectQuoteRequestSerializer` write
 * it, sent from Mastodon with the author's key.
 */
const answerQuoteRequest = (
  author: E2eUser,
  quoter: E2eUser,
  answer: "Accept" | "Reject",
  request: Readonly<{ id: string; noteUri: string; quotingUri: string; slug: string }>,
): void => {
  mastodonDeliver(
    author,
    {
      "@context": QUOTE_CONTEXT,
      id: `${author.uri}#${answer === "Accept" ? "accepts" : "rejects"}/quote_requests/${request.slug}`,
      type: answer,
      actor: author.uri,
      object: {
        id: request.id,
        type: "QuoteRequest",
        actor: quoter.uri,
        object: request.noteUri,
        instrument: request.quotingUri,
      },
      ...(answer === "Accept"
        ? { result: `${author.uri}/quote_authorizations/${request.slug}` }
        : {}),
    },
    `${A}/users/${quoter.username}/inbox`,
  );
};

/** How long a held request is left unanswered before the quote must still be pending. */
const HELD_MS = 3000;

/**
 * Quotes that wait. Mastodon v4.7.5 has no manual approval to wait on: no
 * client API sets a manual policy, its notes advertise the automatic policy
 * only, and a `QuoteRequest` that only a manual policy lets in is accepted
 * at once (`StatusPolicy#quote?` asks for anything but `:denied`). A quote
 * still waits on either server from the moment its note is out until the
 * quoted author's answer arrives; these steps hold that moment open.
 */
const waitingQuotes = async (
  stamp: string,
  { alice, bob, mona, carol }: Readonly<Record<"alice" | "bob" | "mona" | "carol", E2eUser>>,
): Promise<void> => {
  await step(
    "a manual quote policy in Mastodon's database: Mastodon's users may quote, tstodon sees the author-only policy Mastodon federates",
    async () => {
      const target = await post(mona, { status: `manual approval only ${stamp}` });
      const copy = await onHome(alice, target.uri);
      const set = mastodonRails(`
        status = Status.find(${JSON.stringify(target.id)})
        status.update!(quote_approval_policy: InteractionPolicy::POLICY_FLAGS[:public])
        DistributionWorker.perform_async(status.id, { 'update' => true, 'skip_notifications' => true })
        ActivityPub::StatusUpdateDistributionWorker.perform_async(status.id, { 'updated_at' => Time.now.utc.iso8601 })
        puts "MANUAL #{status.quote_policy_for_account(Account.find_local!(${JSON.stringify(carol.username)}))}"
      `);
      if (!set.includes("MANUAL manual")) {
        throw new StepFailure(`the manual policy was not set: ${set.slice(-300)}`);
      }
      const carolsCopy = await resolveStatus(carol, target.uri);
      const carolsApproval = QuoteApproval.parse(carolsCopy).quote_approval?.current_user;
      if (carolsApproval !== "manual") {
        throw new StepFailure(`carol's copy says ${String(carolsApproval)}`);
      }
      // Mastodon accepts its own user's quote at once: `attach_quote!` asks `quote?`.
      const carolsQuote = await post(carol, {
        status: `quoting a manual policy ${stamp}`,
        quoted_status_id: carolsCopy.id,
      });
      if (carolsQuote.quote?.state !== "accepted") {
        throw new StepFailure(`carol's quote is ${String(carolsQuote.quote?.state)}`);
      }
      let last: string | undefined;
      await eventually("tstodon's copy says the follower may not quote", async () => {
        last = (await call(alice, `/api/v1/statuses/${copy.id}`, QuoteApproval)).quote_approval
          ?.current_user;
        return last === "denied" ? true : undefined;
      }).catch((error: unknown) => {
        throw new StepFailure(
          `${error instanceof Error ? error.message : String(error)}; quote_approval.current_user is ${String(last)}`,
        );
      });
      const state = await quoteState(alice, copy.id, `quoting a manual policy ${stamp}`);
      if (state !== "refused") {
        throw new StepFailure(`tstodon took the quote: ${state}`);
      }
    },
  );

  for (const answer of ["Accept", "Reject"] as const) {
    await step(
      `a quote waits for the quoted author's manual approval, then gets a ${answer}: tstodon → Mastodon`,
      async () => {
        const slug = `manual-${answer.toLowerCase()}-${stamp}`;
        const noteUri = deliverManualNote(mona, alice, slug);
        const copy = await onHome(alice, noteUri);
        const approval = QuoteApproval.parse(copy).quote_approval?.current_user;
        if (approval !== "manual") {
          throw new StepFailure(
            `tstodon's copy says quote_approval.current_user ${String(approval)}`,
          );
        }
        const quoting = await post(alice, {
          status: `asking to quote ${stamp}`,
          quoted_status_id: copy.id,
        });
        const quoted = await post(bob, {
          status: `quoting the asking post ${stamp}`,
          quoted_status_id: quoting.id,
        });
        const requestId = await deliveredQuoteRequest(quoting.id);
        await sleep(HELD_MS);
        const held = await call(alice, `/api/v1/statuses/${quoting.id}`, Status);
        if (held.quote?.state !== "pending" || held.quote.quoted_status) {
          throw new StepFailure(`the held quote reads ${JSON.stringify(held.quote)}`);
        }
        answerQuoteRequest(mona, alice, answer, {
          id: requestId,
          noteUri,
          quotingUri: quoting.uri,
          slug,
        });
        if (answer === "Reject") {
          await stateBecomes(alice, quoting.id, "the quote is rejected", (s) => s === "rejected");
          return;
        }
        await stateBecomes(alice, quoting.id, "the quote is accepted", (s) => s === "accepted");
        const now = await call(alice, `/api/v1/statuses/${quoting.id}`, Status);
        if (now.quote?.quoted_status?.uri !== noteUri) {
          throw new StepFailure(`the accepted quote shows ${JSON.stringify(now.quote)}`);
        }
        // As `accept_quote!` distributes the note as an update with notifications.
        await notified(bob, "quoted_update", alice, quoted.uri);
      },
    );
  }

  await step(
    "a quote waits until its QuoteRequest reaches the quoted author: Mastodon → tstodon",
    async () => {
      const target = await post(alice, { status: `quote me when asked ${stamp}` });
      const monasCopy = await onHome(mona, target.uri);
      const text = Buffer.from(`quoting, asking later ${stamp}`, "utf8").toString("base64");
      // `PostStatusService` with its `QuoteRequestWorker` held back: the note
      // goes out, the request does not.
      const out = mastodonRails(`
        ActivityPub::QuoteRequestWorker.singleton_class.prepend(Module.new { def perform_async(*) = nil })
        status = PostStatusService.new.call(
          Account.find_local!(${JSON.stringify(mona.username)}),
          text: Base64.strict_decode64("${text}").force_encoding("UTF-8"),
          visibility: "public",
          quoted_status: Status.find(${JSON.stringify(monasCopy.id)}),
          quote_approval_policy: InteractionPolicy::POLICY_FLAGS[:public] << 16,
        )
        puts "HELD #{status.id}"
      `);
      const sentId = /HELD (\d+)/.exec(out)?.[1];
      if (sentId === undefined) {
        throw new StepFailure(`Mastodon made no quote: ${out.slice(-300)}`);
      }
      const sent = await call(mona, `/api/v1/statuses/${sentId}`, Status);
      if (sent.quote?.state !== "pending") {
        throw new StepFailure(`Mastodon's quote is ${String(sent.quote?.state)}`);
      }
      const copy = await onHome(alice, sent.uri);
      if (copy.quote?.state !== "pending" || copy.quote.quoted_status) {
        throw new StepFailure(`tstodon's copy reads ${JSON.stringify(copy.quote)}`);
      }
      const listed = await call(alice, `/api/v1/statuses/${target.id}/quotes`, Statuses);
      if (listed.some((status) => status.uri === sent.uri)) {
        throw new StepFailure("tstodon lists the pending quote");
      }
      const notifications = await call(alice, "/api/v1/notifications?types[]=quote", Notifications);
      if (notifications.some((item) => item.status?.uri === sent.uri)) {
        throw new StepFailure("tstodon notified the quote while it was pending");
      }
      mastodonRails(
        `ActivityPub::QuoteRequestWorker.perform_async(Status.find(${JSON.stringify(sentId)}).quote.id)`,
      );
      await stateBecomes(mona, sentId, "Mastodon's quote is accepted", (s) => s === "accepted");
      await stateBecomes(alice, copy.id, "tstodon's copy is accepted", (s) => s === "accepted");
      await notified(alice, "quote", mona, sent.uri);
    },
  );
};

export const quoteScenarios = async ({ stamp, mona, carol }: Cast): Promise<void> => {
  const alice = await signUp(A, "quinn");
  const bob = await signUp(A, "quincy");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays("a quote notifies the quoted author", alice, mona, async (from, to) => {
    const target = await post(to, { status: `quote me, notify me ${stamp}` });
    const { sent } = await acceptedQuote(from, to, target, `quoting, notifying ${stamp}`);
    await notified(to, "quote", from, sent.uri);
  });

  await bothWays(
    "a post that lets nobody quote it is not quoted",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, {
        status: `nobody quotes me ${stamp}`,
        quote_approval_policy: "nobody",
      });
      const copy = await onHome(from, target.uri);
      const approval = QuoteApproval.parse(copy).quote_approval?.current_user;
      if (approval !== "denied") {
        throw new StepFailure(
          `the follower's copy says quote_approval.current_user ${String(approval)}`,
        );
      }
      const state = await quoteState(from, copy.id, `quoting nobody ${stamp}`);
      if (state === "accepted") {
        throw new StepFailure("the quote was accepted");
      }
    },
  );

  await bothWays(
    "a post that lets followers quote it: a follower's quote is accepted, a stranger's is not",
    alice,
    mona,
    async (from, to) => {
      const stranger = from === alice ? bob : carol;
      const target = await post(to, {
        status: `followers quote me ${stamp}`,
        quote_approval_policy: "followers",
      });
      await acceptedQuote(from, to, target, `a follower quoting ${stamp}`);
      const strangersCopy = await resolveStatus(stranger, target.uri);
      const state = await quoteState(stranger, strangersCopy.id, `a stranger quoting ${stamp}`);
      if (state === "accepted") {
        throw new StepFailure("the stranger's quote was accepted");
      }
    },
  );

  await bothWays("the author revokes a quote", alice, mona, async (from, to) => {
    const target = await post(to, { status: `quote me, then lose it ${stamp}` });
    const { sent, copy } = await acceptedQuote(from, to, target, `quoting, to be revoked ${stamp}`);
    await call(to, `/api/v1/statuses/${target.id}/quotes/${copy.id}/revoke`, Anything, {
      method: "POST",
      body: {},
    });
    await stateBecomes(
      from,
      sent.id,
      "the quoter's server shows the quote revoked",
      (state) => state === "revoked",
    );
    await eventually("the author's server no longer lists the quote", async () => {
      const quotes = await call(to, `/api/v1/statuses/${target.id}/quotes`, Statuses);
      return quotes.some((status) => status.uri === sent.uri) ? undefined : true;
    });
  });

  await bothWays("a deleted quoted post leaves the quote empty", alice, mona, async (from, to) => {
    const target = await post(to, { status: `quote me, then I go ${stamp}` });
    const { sent } = await acceptedQuote(from, to, target, `quoting, to be orphaned ${stamp}`);
    await call(to, `/api/v1/statuses/${target.id}`, Anything, { method: "DELETE" });
    await stateBecomes(
      from,
      sent.id,
      "the quoter's server shows the quoted post deleted",
      (state) => state === "deleted",
    );
  });

  await bothWays("a deleted quote leaves the quoted post's list", alice, mona, async (from, to) => {
    const target = await post(to, { status: `quote me, then unquote ${stamp}` });
    const { sent } = await acceptedQuote(from, to, target, `quoting, to be deleted ${stamp}`);
    await eventually("the author's server lists the quote", async () => {
      const quotes = await call(to, `/api/v1/statuses/${target.id}/quotes`, Statuses);
      return quotes.some((status) => status.uri === sent.uri) ? true : undefined;
    });
    await call(from, `/api/v1/statuses/${sent.id}`, Anything, { method: "DELETE" });
    await eventually("the author's server no longer lists the quote", async () => {
      const quotes = await call(to, `/api/v1/statuses/${target.id}/quotes`, Statuses);
      return quotes.some((status) => status.uri === sent.uri) ? undefined : true;
    });
  });

  await bothWays(
    "an edit that closes a post to quotes reaches the other server",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, { status: `quotable for now ${stamp}` });
      const copy = await onHome(from, target.uri);
      await call(to, `/api/v1/statuses/${target.id}`, Status, {
        method: "PUT",
        body: {
          status: `quotable no more ${stamp}`,
          spoiler_text: "",
          quote_approval_policy: "nobody",
        },
      });
      let last: string | undefined;
      await eventually("the copy says the follower may not quote", async () => {
        const now = await call(from, `/api/v1/statuses/${copy.id}`, QuoteApproval);
        last = now.quote_approval?.current_user;
        return last === "denied" ? true : undefined;
      }).catch((error: unknown) => {
        throw new StepFailure(
          `${error instanceof Error ? error.message : String(error)}; quote_approval.current_user is ${String(last)}`,
        );
      });
    },
  );

  await waitingQuotes(stamp, { alice, bob, mona, carol });
};
