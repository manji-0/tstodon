/** Sweep area INT-14: non-ASCII and mixed-case hashtags, hashtag search, followed hashtags, and featured hashtags. */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  onHome,
  post,
  resolveAccount,
  Statuses,
  StepFailure,
} from "./sweep.js";

const Tags = z.array(z.looseObject({ name: z.string() }));
const TagSearch = z.looseObject({ hashtags: Tags });
const FeaturedTags = z.array(z.looseObject({ id: z.string(), name: z.string() }));

const tagTimelineHas = (viewer: E2eUser, tag: string, uri: string) =>
  eventually(`${viewer.username}'s timeline of #${tag} has the post`, async () => {
    const timeline = await call(
      viewer,
      `/api/v1/timelines/tag/${encodeURIComponent(tag)}`,
      Statuses,
    );
    return timeline.some((status) => status.uri === uri) ? true : undefined;
  });

export const hashtagScenarios = async ({ stamp, mona, carol }: Cast): Promise<void> => {
  const alice = await signUp(A, "hana");
  const bob = await signUp(A, "hugo");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays("a hashtag in Japanese is indexed", alice, mona, async (from, to) => {
    const tag = `日本語${stamp}${from === alice ? "ts" : "ma"}`;
    const sent = await post(from, { status: `tagged #${tag}` });
    const copy = await onHome(to, sent.uri);
    if (!copy.tags.some((entry) => entry.name === tag)) {
      throw new StepFailure(`the copy's tags are ${JSON.stringify(copy.tags)}`);
    }
    await tagTimelineHas(to, tag, sent.uri);
  });

  await bothWays(
    "a mixed-case hashtag is found under its lower-case name",
    alice,
    mona,
    async (from, to) => {
      const tag = `CamelCase${stamp}${from === alice ? "Ts" : "Ma"}`;
      const sent = await post(from, { status: `tagged #${tag}` });
      const copy = await onHome(to, sent.uri);
      if (!copy.tags.some((entry) => entry.name === tag.toLowerCase())) {
        throw new StepFailure(`the copy's tags are ${JSON.stringify(copy.tags)}`);
      }
      await tagTimelineHas(to, tag.toLowerCase(), sent.uri);
      await tagTimelineHas(to, tag.toUpperCase(), sent.uri);
    },
  );

  await bothWays(
    "hashtag search finds the tag of a federated post",
    alice,
    mona,
    async (from, to) => {
      const tag = `findable${stamp}${from === alice ? "ts" : "ma"}`;
      const sent = await post(from, { status: `tagged #${tag}` });
      await onHome(to, sent.uri);
      await eventually("the search lists the hashtag", async () => {
        const query = new URLSearchParams({ q: `#${tag}`, type: "hashtags" });
        const found = await call(to, `/api/v2/search?${query.toString()}`, TagSearch);
        return found.hashtags.some((entry) => entry.name === tag) ? true : undefined;
      });
    },
  );

  await bothWays(
    "a followed hashtag brings a stranger's federated post home",
    alice,
    mona,
    async (from, to) => {
      // The post reaches the server because `to` follows its author; the
      // reader follows the hashtag only.
      const reader = to === alice ? bob : carol;
      const tag = `followed${stamp}${from === alice ? "ts" : "ma"}`;
      await call(reader, `/api/v1/tags/${tag}/follow`, Anything, { method: "POST", body: {} });
      try {
        const sent = await post(from, { status: `tagged #${tag}` });
        await onHome(to, sent.uri);
        await onHome(reader, sent.uri);
      } finally {
        await call(reader, `/api/v1/tags/${tag}/unfollow`, Anything, { method: "POST", body: {} });
      }
    },
    { toTstodon: "INT-14" },
  );

  await bothWays(
    "a featured hashtag shows on the remote profile",
    alice,
    mona,
    async (from, to) => {
      const tag = `featured${stamp}${from === alice ? "ts" : "ma"}`;
      await post(from, { status: `tagged #${tag}` });
      const featured = await call(
        from,
        "/api/v1/featured_tags",
        z.looseObject({ id: z.string() }),
        {
          method: "POST",
          body: { name: tag },
        },
      );
      try {
        const { id } = await resolveAccount(to, from);
        await eventually("the remote profile lists the featured hashtag", async () => {
          const tags = await call(to, `/api/v1/accounts/${id}/featured_tags`, FeaturedTags);
          return tags.some((entry) => entry.name.toLowerCase() === tag) ? true : undefined;
        });
      } finally {
        // Mastodon allows an account ten featured hashtags, and mona outlives the run.
        await call(from, `/api/v1/featured_tags/${featured.id}`, Anything, { method: "DELETE" });
      }
    },
    { toMastodon: "INT-14", toTstodon: "INT-14" },
  );
};
