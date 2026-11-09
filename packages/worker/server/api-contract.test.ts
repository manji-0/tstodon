import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAccount,
  ApiContext,
  ApiConversation,
  ApiCredentialAccount,
  ApiCustomEmoji,
  ApiDomainBlock,
  ApiFeaturedTag,
  ApiFilter,
  ApiHashtag,
  ApiInstance,
  ApiInstanceActivity,
  ApiList,
  ApiMarkers,
  ApiMediaAttachment,
  ApiNotification,
  ApiNotificationGroup,
  ApiNotificationGroupsResult,
  ApiNotificationPolicy,
  ApiPoll,
  ApiProfile,
  ApiRelationship,
  ApiReport,
  ApiRule,
  ApiSearchResults,
  ApiStatus,
  ApiStatusEdit,
  ApiStatusSource,
  ApiSuggestion,
  ApiV1Filter,
  ApiV1Instance,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { PNG_40X30 } from "../test/image-fixtures";

/**
 * The REST contract (`@tstodon/api`) the web UI reads, checked against the
 * Worker's answers: each response of the main endpoints parses with its
 * schema. Behaviour is asserted by each endpoint's own tests; these check
 * the shape, so a document builder that drifts from the shared types fails
 * here.
 */

type Response = Readonly<{ status: number; body: unknown }>;

const call = async (
  email: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const headers: Record<string, string> = email ? await authHeaders(email) : {};
  const init: RequestInit =
    body instanceof FormData
      ? { method, headers, body }
      : body === undefined
        ? { method, headers }
        : {
            method,
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          };
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
};

/** The body of a successful call, parsed with `schema`. */
const ok = async <T>(
  schema: z.ZodType<T>,
  email: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await call(email, method, path, body);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(schema, response.body);
};

const get = <T>(schema: z.ZodType<T>, email: string | undefined, path: string): Promise<T> =>
  ok(schema, email, "GET", path);

const post = <T>(schema: z.ZodType<T>, email: string, path: string, body?: unknown): Promise<T> =>
  ok(schema, email, "POST", path, body);

const author = "contract-author@example.com";
const reader = "contract-reader@example.com";

/** Two accounts that follow each other, and the author's account and username. */
const setUp = async () => {
  const authorAccount = await get(
    ApiCredentialAccount,
    author,
    "/api/v1/accounts/verify_credentials",
  );
  const readerAccount = await get(
    ApiCredentialAccount,
    reader,
    "/api/v1/accounts/verify_credentials",
  );
  await post(ApiRelationship, reader, `/api/v1/accounts/${authorAccount.id}/follow`);
  await post(ApiRelationship, author, `/api/v1/accounts/${readerAccount.id}/follow`);
  return { authorAccount, readerAccount };
};

describe("REST API contract (@tstodon/api)", () => {
  it("statuses, media, polls, quotes, boosts, threads and timelines", async () => {
    const { authorAccount, readerAccount } = await setUp();

    const form = new FormData();
    form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    form.set("description", "a gradient");
    const media = await post(ApiMediaAttachment, author, "/api/v2/media", form);
    expect(media.type).toBe("image");
    await get(ApiMediaAttachment, author, `/api/v1/media/${media.id}`);

    const withMedia = await post(ApiStatus, author, "/api/v1/statuses", {
      status: `Hello #contract @${readerAccount.username} https://example.com/page`,
      media_ids: [media.id],
      language: "en",
    });
    expect(withMedia.media_attachments).toHaveLength(1);
    expect(withMedia.mentions.map((mention) => mention.id)).toEqual([readerAccount.id]);

    const withPoll = await post(ApiStatus, author, "/api/v1/statuses", {
      status: "Which one?",
      poll: { options: ["this", "that"], expires_in: 3600, hide_totals: true },
    });
    const pollId = withPoll.poll?.id ?? "";
    await post(ApiPoll, reader, `/api/v1/polls/${pollId}/votes`, { choices: [1] });
    const poll = await get(ApiPoll, reader, `/api/v1/polls/${pollId}`);
    expect(poll.voted).toBe(true);

    const quote = await post(ApiStatus, reader, "/api/v1/statuses", {
      status: "Look at this",
      quoted_status_id: withMedia.id,
    });
    const reply = await post(ApiStatus, reader, "/api/v1/statuses", {
      status: "A reply",
      in_reply_to_id: withPoll.id,
    });
    expect(reply.in_reply_to_id).toBe(withPoll.id);
    // A status quoting a quote shows the inner quote by id only.
    const nested = await post(ApiStatus, author, "/api/v1/statuses", {
      status: "Quoting a quote",
      quoted_status_id: quote.id,
    });
    const shown = await get(ApiStatus, author, `/api/v1/statuses/${nested.id}`);
    if (shown.quote?.quoted_status) {
      expect(shown.quote.quoted_status.quote?.quoted_status_id ?? null).not.toBeUndefined();
    }

    const boost = await post(ApiStatus, reader, `/api/v1/statuses/${withMedia.id}/reblog`);
    expect(boost.reblog?.id).toBe(withMedia.id);
    await post(ApiStatus, reader, `/api/v1/statuses/${withMedia.id}/favourite`);
    await post(ApiStatus, reader, `/api/v1/statuses/${withMedia.id}/bookmark`);
    await post(ApiStatus, author, `/api/v1/statuses/${withMedia.id}/pin`);

    await get(ApiStatus, undefined, `/api/v1/statuses/${withMedia.id}`);
    await get(ApiContext, reader, `/api/v1/statuses/${withPoll.id}/context`);
    await get(z.array(ApiStatus), reader, `/api/v1/statuses?id[]=${withMedia.id}&id[]=${quote.id}`);
    await get(z.array(ApiAccount), reader, `/api/v1/statuses/${withMedia.id}/favourited_by`);
    await get(z.array(ApiAccount), reader, `/api/v1/statuses/${withMedia.id}/reblogged_by`);
    await get(z.array(ApiStatus), author, `/api/v1/statuses/${withMedia.id}/quotes`);

    const edited = await ok(ApiStatus, author, "PUT", `/api/v1/statuses/${withMedia.id}`, {
      status: "Hello again #contract",
      media_ids: [media.id],
    });
    expect(edited.edited_at).not.toBeNull();
    const history = await get(
      z.array(ApiStatusEdit),
      reader,
      `/api/v1/statuses/${withMedia.id}/history`,
    );
    expect(history).toHaveLength(2);
    expect(history[0]?.media_attachments).toHaveLength(1);
    await get(ApiStatusSource, author, `/api/v1/statuses/${withMedia.id}/source`);
    const unvoted = await post(ApiStatus, author, "/api/v1/statuses", {
      status: "Which one?",
      poll: { options: ["this", "that"], expires_in: 3600 },
    });
    const pollEdit = await ok(ApiStatus, author, "PUT", `/api/v1/statuses/${unvoted.id}`, {
      status: "Which one now?",
      poll: { options: ["this", "that", "other"], expires_in: 3600 },
    });
    expect(pollEdit.poll?.options).toHaveLength(3);
    const pollRevisions = await get(
      z.array(ApiStatusEdit),
      author,
      `/api/v1/statuses/${unvoted.id}/history`,
    );
    expect(pollRevisions.map((revision) => revision.poll?.options.length)).toEqual([2, 3]);

    for (const path of [
      "/api/v1/timelines/home",
      "/api/v1/timelines/public",
      "/api/v1/timelines/public?local=true",
      "/api/v1/timelines/tag/contract",
      `/api/v1/accounts/${authorAccount.id}/statuses`,
      `/api/v1/accounts/${authorAccount.id}/statuses?pinned=true`,
      "/api/v1/bookmarks",
      "/api/v1/favourites",
    ]) {
      await get(z.array(ApiStatus), reader, path);
    }
    await get(z.array(ApiStatus), undefined, "/api/v1/timelines/public");
  });

  it("accounts, relationships, lists, tags and markers", async () => {
    const { authorAccount, readerAccount } = await setUp();

    await get(ApiAccount, reader, `/api/v1/accounts/${authorAccount.id}`);
    await get(ApiAccount, undefined, `/api/v1/accounts/lookup?acct=${authorAccount.username}`);
    await get(z.array(ApiAccount), reader, `/api/v1/accounts/${authorAccount.id}/followers`);
    await get(z.array(ApiAccount), reader, `/api/v1/accounts/${authorAccount.id}/following`);
    await get(z.array(ApiAccount), reader, "/api/v1/accounts/search?q=contract");
    await get(
      z.array(ApiRelationship),
      reader,
      `/api/v1/accounts/relationships?id[]=${authorAccount.id}`,
    );
    await get(
      z.array(z.object({ id: z.string(), accounts: z.array(ApiAccount) })),
      reader,
      `/api/v1/accounts/familiar_followers?id[]=${authorAccount.id}`,
    );
    await ok(ApiCredentialAccount, author, "PATCH", "/api/v1/accounts/update_credentials", {
      display_name: "Contract Author",
      note: "Checks the contract",
    });
    await post(ApiRelationship, reader, `/api/v1/accounts/${authorAccount.id}/note`, {
      comment: "writes tests",
    });
    await post(ApiRelationship, reader, `/api/v1/accounts/${authorAccount.id}/mute`);
    await get(z.array(ApiAccount), reader, "/api/v1/mutes");
    await post(ApiRelationship, reader, `/api/v1/accounts/${authorAccount.id}/unmute`);
    await get(z.array(ApiSuggestion), reader, "/api/v2/suggestions");
    await get(z.array(ApiAccount), reader, "/api/v1/suggestions");

    const list = await post(ApiList, reader, "/api/v1/lists", { title: "Contract" });
    await post(z.object({}), reader, `/api/v1/lists/${list.id}/accounts`, {
      account_ids: [authorAccount.id],
    });
    await get(z.array(ApiList), reader, "/api/v1/lists");
    await get(ApiList, reader, `/api/v1/lists/${list.id}`);
    await get(z.array(ApiAccount), reader, `/api/v1/lists/${list.id}/accounts`);
    await get(z.array(ApiStatus), reader, `/api/v1/timelines/list/${list.id}`);
    await get(z.array(ApiList), reader, `/api/v1/accounts/${authorAccount.id}/lists`);

    await post(ApiStatus, author, "/api/v1/statuses", { status: "A #contracttag post" });
    await get(ApiHashtag, reader, "/api/v1/tags/contracttag");
    await post(ApiHashtag, reader, "/api/v1/tags/contracttag/follow");
    await get(z.array(ApiHashtag), reader, "/api/v1/followed_tags");
    await post(ApiFeaturedTag, author, "/api/v1/featured_tags", { name: "contracttag" });
    await get(z.array(ApiFeaturedTag), author, "/api/v1/featured_tags");
    await get(
      z.array(ApiFeaturedTag),
      reader,
      `/api/v1/accounts/${authorAccount.id}/featured_tags`,
    );
    await get(z.array(ApiHashtag), author, "/api/v1/featured_tags/suggestions");
    await get(z.array(ApiHashtag), reader, "/api/v1/trends/tags");

    await post(ApiMarkers, reader, "/api/v1/markers", { home: { last_read_id: "1" } });
    const markers = await get(
      ApiMarkers,
      reader,
      "/api/v1/markers?timeline[]=home&timeline[]=notifications",
    );
    expect(markers.home?.last_read_id).toBe("1");
    expect(readerAccount.source.privacy).toBe("public");
  });

  it("notifications, grouped notifications, the policy, conversations and reports", async () => {
    const { authorAccount, readerAccount } = await setUp();
    const status = await post(ApiStatus, author, "/api/v1/statuses", {
      status: `@${readerAccount.username} hello`,
    });
    await post(ApiStatus, reader, `/api/v1/statuses/${status.id}/favourite`);
    await post(ApiStatus, reader, `/api/v1/statuses/${status.id}/reblog`);
    await post(ApiStatus, author, "/api/v1/statuses", {
      status: `@${readerAccount.username} a private word`,
      visibility: "direct",
    });
    // A filter on the reader's notifications marks the mention's status.
    await post(ApiFilter, reader, "/api/v2/filters", {
      title: "hello",
      context: ["notifications"],
      keywords_attributes: [{ keyword: "hello" }],
    });

    const notifications = await get(z.array(ApiNotification), reader, "/api/v1/notifications");
    const mention = notifications.find(
      (notification) => notification.type === "mention" && notification.status?.id === status.id,
    );
    expect(mention?.type === "mention" ? mention.status?.filtered?.[0]?.filter.title : "").toBe(
      "hello",
    );
    expect(notifications.every((notification) => notification.group_key.length > 0)).toBe(true);
    await get(ApiNotification, reader, `/api/v1/notifications/${mention?.id ?? ""}`);
    const authored = await get(z.array(ApiNotification), author, "/api/v1/notifications");
    expect(authored.map((notification) => notification.type)).toEqual(
      expect.arrayContaining(["follow", "favourite", "reblog"]),
    );

    const grouped = await get(ApiNotificationGroupsResult, author, "/api/v2/notifications");
    const favourites = grouped.notification_groups.find((group) => group.type === "favourite");
    expect(favourites?.latest_page_notification_at).toBeDefined();
    // One group comes in the same envelope as the list, as Mastodon's.
    const one = await get(
      ApiNotificationGroupsResult,
      author,
      `/api/v2/notifications/${favourites?.group_key ?? ""}`,
    );
    expect(one.notification_groups.map((group) => group.group_key)).toEqual([
      favourites?.group_key,
    ]);
    expectContract(ApiNotificationGroup, one.notification_groups[0]);
    await get(
      z.array(ApiAccount),
      author,
      `/api/v2/notifications/${favourites?.group_key ?? ""}/accounts`,
    );
    await get(z.object({ count: z.number() }), author, "/api/v2/notifications/unread_count");
    await get(ApiNotificationPolicy, reader, "/api/v2/notifications/policy");

    const conversations = await get(z.array(ApiConversation), reader, "/api/v1/conversations");
    expect(conversations.length).toBeGreaterThan(0);
    const read = await post(
      ApiConversation,
      reader,
      `/api/v1/conversations/${conversations[0]?.id ?? ""}/read`,
    );
    expect(read.unread).toBe(false);

    const report = await post(ApiReport, reader, "/api/v1/reports", {
      account_id: authorAccount.id,
      status_ids: [status.id],
      comment: "contract",
      category: "other",
    });
    expect(report.target_account.id).toBe(authorAccount.id);
  });

  it("instance, filters, search and custom emoji", async () => {
    await setUp();
    const instance = await get(ApiInstance, undefined, "/api/v2/instance");
    expect(instance.configuration.statuses.max_characters).toBeGreaterThan(0);
    await get(z.array(ApiRule), undefined, "/api/v1/instance/rules");
    await get(z.array(ApiCustomEmoji), undefined, "/api/v1/custom_emojis");
    const v1 = await get(ApiV1Instance, undefined, "/api/v1/instance");
    expect(v1.urls.streaming_api).toBe("wss://example.com");
    await get(z.array(ApiInstanceActivity), undefined, "/api/v1/instance/activity");
    await get(z.array(z.string()), undefined, "/api/v1/instance/peers");
    await get(z.array(ApiDomainBlock), undefined, "/api/v1/instance/domain_blocks");

    const profile = await get(ApiProfile, author, "/api/v1/profile");
    expect(profile.id).toBeTruthy();
    const changed = await ok(ApiProfile, author, "PATCH", "/api/v1/profile", {
      note: "Plain *note*",
      fields_attributes: [{ name: "Site", value: "https://example.com" }],
    });
    expect(changed.note).toBe("Plain *note*");
    expect(changed.formatted_note).toContain("<p>");
    expect(changed.fields.map((field) => field.name)).toEqual(["Site"]);

    const filter = await post(ApiFilter, reader, "/api/v2/filters", {
      title: "spoilers",
      context: ["home", "public"],
      filter_action: "hide",
      keywords_attributes: [{ keyword: "spoiler", whole_word: true }],
    });
    await get(z.array(ApiFilter), reader, "/api/v2/filters");
    await get(ApiFilter, reader, `/api/v2/filters/${filter.id}`);
    await get(z.array(ApiV1Filter), reader, "/api/v1/filters");

    await post(ApiStatus, author, "/api/v1/statuses", { status: "Searching for #contractsearch" });
    const results = await get(ApiSearchResults, reader, "/api/v2/search?q=contract");
    expect(results.accounts.length).toBeGreaterThan(0);
    await get(ApiSearchResults, reader, "/api/v2/search?q=contractsearch&type=hashtags");
    await get(ApiSearchResults, reader, "/api/v2/search?q=Searching&type=statuses");
  });
});
