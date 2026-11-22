/** Sweep area INT-5: quote policies (nobody, followers), a revoked quote, a deleted quoted post, a policy change, and the quote notification. */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  notified,
  onHome,
  post,
  resolveStatus,
  Status,
  Statuses,
  StepFailure,
  fetchWaitingOutRateLimit,
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
};
