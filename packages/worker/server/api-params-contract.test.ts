import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAccount,
  ApiConversation,
  ApiCredentialAccount,
  ApiFamiliarFollowers,
  ApiFeaturedTag,
  ApiFilter,
  ApiFilterStatus,
  ApiHashtag,
  ApiList,
  ApiMediaAttachment,
  ApiNotification,
  ApiNotificationGroupsResult,
  ApiNotificationPolicy,
  ApiPoll,
  ApiProfileDocument,
  ApiRelationship,
  ApiSearchResults,
  ApiStatus,
  ApiSuggestion,
  ApiTrendsLink,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { PNG_40X30 } from "../test/image-fixtures";

/**
 * The request side of the REST contract: the params schemas in
 * `@tstodon/api` (`params/`) describe what a JSON client sends, and the
 * Worker folds forms and query strings into that shape before parsing
 * (`server/request-params.ts`). Each endpoint the web UI's TypeScript
 * wrappers call gets the JSON body and its form-encoded equivalent (or, for
 * a `GET`, the `key[]=` query axios sends and its plain-key equivalent), and
 * both must be accepted the same way.
 */

type Answer = Readonly<{ status: number; body: unknown }>;

type FormEntries = ReadonlyArray<readonly [string, string]>;

const answer = async (response: globalThis.Response): Promise<Answer> => {
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
};

const sendJson = async (
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> =>
  answer(
    await SELF.fetch(`https://example.com${path}`, {
      method,
      headers: { ...(await authHeaders(email)), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const sendForm = async (
  email: string,
  method: string,
  path: string,
  entries: FormEntries,
): Promise<Answer> =>
  answer(
    await SELF.fetch(`https://example.com${path}`, {
      method,
      headers: {
        ...(await authHeaders(email)),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(entries.map(([key, value]) => [key, value])).toString(),
    }),
  );

const sendDelete = async (email: string, path: string): Promise<Answer> =>
  answer(
    await SELF.fetch(`https://example.com${path}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    }),
  );

const sendGet = async (email: string, path: string): Promise<Answer> =>
  answer(await SELF.fetch(`https://example.com${path}`, { headers: await authHeaders(email) }));

/** A 200 answer, parsed with `schema`. */
const accepted = <T>(schema: z.ZodType<T>, response: Answer, label: string): T => {
  expect(response.status, label).toBe(200);
  return expectContract(schema, response.body);
};

/** The JSON and form-encoded requests both answer 200, parsed with `schema`. */
const bothAccepted = async <T>(
  schema: z.ZodType<T>,
  label: string,
  json: Promise<Answer>,
  form: Promise<Answer>,
): Promise<readonly [T, T]> => [
  accepted(schema, await json, `${label} (JSON)`),
  accepted(schema, await form, `${label} (form)`),
];

const credentials = async (email: string) =>
  accepted(
    ApiCredentialAccount,
    await sendGet(email, "/api/v1/accounts/verify_credentials"),
    "verify_credentials",
  );

const postStatus = async (email: string, body: Readonly<Record<string, unknown>>) =>
  accepted(ApiStatus, await sendJson(email, "POST", "/api/v1/statuses", body), "post status");

const ids = (accounts: ReadonlyArray<Readonly<{ id: string }>>): string[] =>
  accounts.map((account) => account.id).toSorted();

describe("REST request params (@tstodon/api params)", () => {
  it("lists: create, update, and add or remove members", async () => {
    const owner = "params-list-owner@example.com";
    const member = await credentials("params-list-member@example.com");
    await credentials(owner);
    await sendJson(owner, "POST", `/api/v1/accounts/${member.id}/follow`);

    const [jsonList, formList] = await bothAccepted(
      ApiList,
      "POST /api/v1/lists",
      sendJson(owner, "POST", "/api/v1/lists", {
        title: "Friends",
        replies_policy: "none",
        exclusive: true,
      }),
      sendForm(owner, "POST", "/api/v1/lists", [
        ["title", "Friends"],
        ["replies_policy", "none"],
        ["exclusive", "true"],
      ]),
    );
    expect({ ...formList, id: jsonList.id }).toEqual(jsonList);
    expect(jsonList).toMatchObject({ title: "Friends", replies_policy: "none", exclusive: true });

    const [jsonUpdated, formUpdated] = await bothAccepted(
      ApiList,
      "PUT /api/v1/lists/:id",
      sendJson(owner, "PUT", `/api/v1/lists/${jsonList.id}`, {
        title: "Close friends",
        exclusive: false,
      }),
      sendForm(owner, "PUT", `/api/v1/lists/${formList.id}`, [
        ["title", "Close friends"],
        ["exclusive", "0"],
      ]),
    );
    expect({ ...formUpdated, id: jsonUpdated.id }).toEqual(jsonUpdated);
    expect(jsonUpdated).toMatchObject({ title: "Close friends", exclusive: false });

    const members = async (listId: string) =>
      ids(
        accepted(
          z.array(ApiAccount),
          await sendGet(owner, `/api/v1/lists/${listId}/accounts?limit=0`),
          "list members",
        ),
      );
    await bothAccepted(
      z.object({}),
      "POST /api/v1/lists/:id/accounts",
      sendJson(owner, "POST", `/api/v1/lists/${jsonList.id}/accounts`, {
        account_ids: [member.id],
      }),
      sendForm(owner, "POST", `/api/v1/lists/${formList.id}/accounts`, [
        ["account_ids[]", member.id],
      ]),
    );
    expect(await members(jsonList.id)).toEqual([member.id]);
    expect(await members(formList.id)).toEqual([member.id]);

    // The web UI sends the DELETE's account ids in the query (`account_ids[]=`).
    await bothAccepted(
      z.object({}),
      "DELETE /api/v1/lists/:id/accounts",
      sendJson(owner, "DELETE", `/api/v1/lists/${jsonList.id}/accounts`, {
        account_ids: [member.id],
      }),
      sendDelete(owner, `/api/v1/lists/${formList.id}/accounts?account_ids[]=${member.id}`),
    );
    expect(await members(jsonList.id)).toEqual([]);
    expect(await members(formList.id)).toEqual([]);
  });

  it("accounts: note, follow options, featured tags, and the id[] lookups", async () => {
    const viewer = "params-account-viewer@example.com";
    const first = await credentials("params-account-first@example.com");
    const second = await credentials("params-account-second@example.com");
    await credentials(viewer);

    const [jsonNote, formNote] = await bothAccepted(
      ApiRelationship,
      "POST /api/v1/accounts/:id/note",
      sendJson(viewer, "POST", `/api/v1/accounts/${first.id}/note`, { comment: "met at a talk" }),
      sendForm(viewer, "POST", `/api/v1/accounts/${second.id}/note`, [
        ["comment", "met at a talk"],
      ]),
    );
    expect(jsonNote.note).toBe("met at a talk");
    expect(formNote.note).toBe("met at a talk");

    const [jsonFollow, formFollow] = await bothAccepted(
      ApiRelationship,
      "POST /api/v1/accounts/:id/follow",
      sendJson(viewer, "POST", `/api/v1/accounts/${first.id}/follow`, {
        reblogs: false,
        notify: true,
        languages: ["ja"],
      }),
      sendForm(viewer, "POST", `/api/v1/accounts/${second.id}/follow`, [
        ["reblogs", "false"],
        ["notify", "true"],
        ["languages[]", "ja"],
      ]),
    );
    for (const relationship of [jsonFollow, formFollow]) {
      expect(relationship).toMatchObject({
        following: true,
        showing_reblogs: false,
        notifying: true,
        languages: ["ja"],
      });
    }

    const [jsonTag, formTag] = await bothAccepted(
      ApiFeaturedTag,
      "POST /api/v1/featured_tags",
      sendJson(viewer, "POST", "/api/v1/featured_tags", { name: "paramsjson" }),
      sendForm(viewer, "POST", "/api/v1/featured_tags", [["name", "paramsform"]]),
    );
    expect(jsonTag.name).toBe("paramsjson");
    expect(formTag.name).toBe("paramsform");

    const [bracketed, plain] = await bothAccepted(
      z.array(ApiAccount),
      "GET /api/v1/accounts",
      sendGet(viewer, `/api/v1/accounts?id[]=${first.id}&id[]=${second.id}`),
      sendGet(viewer, `/api/v1/accounts?id=${first.id}&id=${second.id}`),
    );
    expect(ids(bracketed)).toEqual(ids([first, second]));
    expect(ids(plain)).toEqual(ids(bracketed));

    const [familiarBracketed, familiarPlain] = await bothAccepted(
      ApiFamiliarFollowers,
      "GET /api/v1/accounts/familiar_followers",
      sendGet(viewer, `/api/v1/accounts/familiar_followers?id[]=${first.id}`),
      sendGet(viewer, `/api/v1/accounts/familiar_followers?id=${first.id}`),
    );
    expect(familiarBracketed.map((group) => group.id)).toEqual([first.id]);
    expect(familiarPlain).toEqual(familiarBracketed);
  });

  it("profile: flags and fields_attributes as JSON and as a form", async () => {
    const jsonEmail = "params-profile-json@example.com";
    const formEmail = "params-profile-form@example.com";
    const [jsonProfile, formProfile] = await bothAccepted(
      ApiProfileDocument,
      "PATCH /api/v1/profile",
      sendJson(jsonEmail, "PATCH", "/api/v1/profile", {
        display_name: "Params",
        note: "A bio",
        bot: true,
        locked: true,
        discoverable: false,
        fields_attributes: [{ name: "Site", value: "example.com" }],
      }),
      sendForm(formEmail, "PATCH", "/api/v1/profile", [
        ["display_name", "Params"],
        ["note", "A bio"],
        ["bot", "1"],
        ["locked", "true"],
        ["discoverable", "0"],
        ["fields_attributes[0][name]", "Site"],
        ["fields_attributes[0][value]", "example.com"],
      ]),
    );
    for (const profile of [jsonProfile, formProfile]) {
      expect(profile).toMatchObject({
        display_name: "Params",
        note: "A bio",
        bot: true,
        locked: true,
        discoverable: false,
        fields: [{ name: "Site", value: "example.com" }],
      });
    }
  });

  it("media, boosts and poll votes", async () => {
    const author = "params-status-author@example.com";
    const reader = "params-status-reader@example.com";
    const authorAccount = await credentials(author);
    await credentials(reader);
    await sendJson(reader, "POST", `/api/v1/accounts/${authorAccount.id}/follow`);

    const upload = async () => {
      const form = new FormData();
      form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
      return accepted(
        ApiMediaAttachment,
        await answer(
          await SELF.fetch("https://example.com/api/v2/media", {
            method: "POST",
            headers: await authHeaders(author),
            body: form,
          }),
        ),
        "upload",
      );
    };
    const [firstMedia, secondMedia] = [await upload(), await upload()];
    const [jsonMedia, formMedia] = await bothAccepted(
      ApiMediaAttachment,
      "PUT /api/v1/media/:id",
      sendJson(author, "PUT", `/api/v1/media/${firstMedia.id}`, {
        description: "a gradient",
        focus: "0.5,-0.5",
      }),
      sendForm(author, "PUT", `/api/v1/media/${secondMedia.id}`, [
        ["description", "a gradient"],
        ["focus", "0.5,-0.5"],
      ]),
    );
    expect(jsonMedia.description).toBe("a gradient");
    expect(formMedia.description).toBe(jsonMedia.description);
    expect(jsonMedia).toMatchObject({ meta: { focus: { x: 0.5, y: -0.5 } } });
    expect(formMedia.meta).toEqual(jsonMedia.meta);

    const [firstNote, secondNote] = [
      await postStatus(author, { status: "boost me" }),
      await postStatus(author, { status: "boost me too" }),
    ];
    const [jsonBoost, formBoost] = await bothAccepted(
      ApiStatus,
      "POST /api/v1/statuses/:id/reblog",
      sendJson(reader, "POST", `/api/v1/statuses/${firstNote.id}/reblog`, {
        visibility: "private",
      }),
      sendForm(reader, "POST", `/api/v1/statuses/${secondNote.id}/reblog`, [
        ["visibility", "private"],
      ]),
    );
    expect(jsonBoost.visibility).toBe("private");
    expect(formBoost.visibility).toBe("private");

    const poll = { options: ["this", "that"], expires_in: 3600 };
    const [firstPoll, secondPoll] = [
      await postStatus(author, { status: "Which one?", poll }),
      await postStatus(author, { status: "Which one now?", poll }),
    ];
    const [jsonVote, formVote] = await bothAccepted(
      ApiPoll,
      "POST /api/v1/polls/:id/votes",
      sendJson(reader, "POST", `/api/v1/polls/${firstPoll.poll?.id ?? ""}/votes`, {
        choices: ["1"],
      }),
      sendForm(reader, "POST", `/api/v1/polls/${secondPoll.poll?.id ?? ""}/votes`, [
        ["choices[]", "1"],
      ]),
    );
    expect(jsonVote.own_votes).toEqual([1]);
    expect(formVote.own_votes).toEqual([1]);
  });

  it("notifications: policy (PUT and PATCH), requests, and the list queries", async () => {
    const email = "params-notifications@example.com";
    await credentials(email);

    const [putPolicy, patchPolicy] = await bothAccepted(
      ApiNotificationPolicy,
      "PUT / PATCH /api/v2/notifications/policy",
      sendJson(email, "PUT", "/api/v2/notifications/policy", {
        for_not_following: "filter",
        filter_new_accounts: true,
      }),
      sendForm(email, "PATCH", "/api/v2/notifications/policy", [
        ["for_not_following", "filter"],
        ["filter_new_accounts", "1"],
      ]),
    );
    expect(putPolicy).toMatchObject({ for_not_following: "filter", for_new_accounts: "filter" });
    expect(patchPolicy).toEqual(putPolicy);

    for (const action of ["accept", "dismiss"]) {
      await bothAccepted(
        z.object({}),
        `POST /api/v1/notifications/requests/${action}`,
        sendJson(email, "POST", `/api/v1/notifications/requests/${action}`, { id: ["1", "2"] }),
        sendForm(email, "POST", `/api/v1/notifications/requests/${action}`, [
          ["id[]", "1"],
          ["id[]", "2"],
        ]),
      );
    }

    const [v1Bracketed, v1Plain] = await bothAccepted(
      z.array(ApiNotification),
      "GET /api/v1/notifications",
      sendGet(email, "/api/v1/notifications?types[]=follow&include_filtered=true&limit=5"),
      sendGet(email, "/api/v1/notifications?types=follow&include_filtered=1&limit=5"),
    );
    expect(v1Plain).toEqual(v1Bracketed);

    const [v2Bracketed, v2Plain] = await bothAccepted(
      ApiNotificationGroupsResult,
      "GET /api/v2/notifications",
      sendGet(
        email,
        "/api/v2/notifications?grouped_types[]=favourite&grouped_types[]=reblog&exclude_types[]=mention",
      ),
      sendGet(
        email,
        "/api/v2/notifications?grouped_types=favourite&grouped_types=reblog&exclude_types=mention",
      ),
    );
    expect(v2Plain).toEqual(v2Bracketed);

    await bothAccepted(
      z.array(z.unknown()),
      "GET /api/v1/notifications/requests",
      sendGet(email, "/api/v1/notifications/requests?limit=5"),
      sendGet(email, "/api/v1/notifications/requests?limit=5&max_id="),
    );
  });

  it("search, directory and suggestions read string booleans and numbers", async () => {
    const email = "params-discovery@example.com";
    const other = await credentials("params-discovery-other@example.com");
    await credentials(email);

    const [searchBoolean, searchString] = await bothAccepted(
      ApiSearchResults,
      "GET /api/v2/search",
      sendGet(email, `/api/v2/search?q=${other.username}&type=accounts&resolve=false&limit=5`),
      sendGet(email, `/api/v2/search?q=${other.username}&type=accounts&resolve=0&limit=5`),
    );
    expect(searchBoolean.accounts.map((account) => account.id)).toContain(other.id);
    expect(searchString).toEqual(searchBoolean);

    const [directoryBoolean, directoryString] = await bothAccepted(
      z.array(ApiAccount),
      "GET /api/v1/directory",
      sendGet(email, "/api/v1/directory?order=new&local=true&limit=2&offset=0"),
      sendGet(email, "/api/v1/directory?order=new&local=1&limit=2&offset=0"),
    );
    expect(directoryBoolean.length).toBeLessThanOrEqual(2);
    expect(ids(directoryString)).toEqual(ids(directoryBoolean));

    const [suggestions] = await bothAccepted(
      z.array(ApiSuggestion),
      "GET /api/v2/suggestions",
      sendGet(email, "/api/v2/suggestions?limit=1"),
      sendGet(email, "/api/v2/suggestions?limit=1&limit=5"),
    );
    expect(suggestions.length).toBeLessThanOrEqual(1);
  });
});

describe("REST request params of the actions moved to TypeScript", () => {
  const statusIds = (statuses: ReadonlyArray<Readonly<{ id: string }>>): string[] =>
    statuses.map((status) => status.id);

  it("timelines: home, public, tag, list, link and account statuses queries", async () => {
    const email = "params-timelines@example.com";
    const account = await credentials(email);
    const tagged = await postStatus(email, { status: "#paramstag #paramsone tagged" });
    const plain = await postStatus(email, { status: "#paramstag untagged" });

    const [homeJson, homePlain] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/timelines/home",
      sendGet(email, `/api/v1/timelines/home?limit=1`),
      sendGet(email, `/api/v1/timelines/home?limit=1&limit=5`),
    );
    expect(homeJson.length).toBe(1);
    expect(homePlain).toEqual(homeJson);

    const [publicBoolean, publicString] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/timelines/public",
      sendGet(email, `/api/v1/timelines/public?local=true&only_media=false&max_id=${plain.id}`),
      sendGet(email, `/api/v1/timelines/public?local=1&only_media=0&max_id=${plain.id}`),
    );
    expect(statusIds(publicBoolean)).toContain(tagged.id);
    expect(statusIds(publicBoolean)).not.toContain(plain.id);
    expect(publicString).toEqual(publicBoolean);

    const [tagBracketed, tagPlain] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/timelines/tag/:hashtag",
      sendGet(email, "/api/v1/timelines/tag/paramstag?any[]=paramsone&local=true"),
      sendGet(email, "/api/v1/timelines/tag/paramstag?any=%23paramsone&local=1"),
    );
    expect(statusIds(tagBracketed)).toEqual([tagged.id]);
    expect(tagPlain).toEqual(tagBracketed);

    const list = accepted(
      ApiList,
      await sendJson(email, "POST", "/api/v1/lists", { title: "Timeline params" }),
      "create list",
    );
    const [listJson, listPlain] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/timelines/list/:id",
      sendGet(email, `/api/v1/timelines/list/${list.id}?limit=5`),
      sendGet(email, `/api/v1/timelines/list/${list.id}?limit=5&since_id=`),
    );
    expect(listPlain).toEqual(listJson);

    // Not a trending link: both answer the same 404.
    const linkUrl = encodeURIComponent("https://example.org/story");
    const [linkOne, linkRepeated] = [
      await sendGet(email, `/api/v1/timelines/link?url=${linkUrl}&limit=5`),
      await sendGet(email, `/api/v1/timelines/link?url=${linkUrl}&url=other&limit=5`),
    ];
    expect(linkOne.status).toBe(404);
    expect(linkRepeated).toEqual(linkOne);

    const [repliesBoolean, repliesString] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/accounts/:id/statuses",
      sendGet(
        email,
        `/api/v1/accounts/${account.id}/statuses?exclude_replies=true&exclude_reblogs=true&only_media=false&tagged=paramsone`,
      ),
      sendGet(
        email,
        `/api/v1/accounts/${account.id}/statuses?exclude_replies=1&exclude_reblogs=1&only_media=0&tagged=paramsone`,
      ),
    );
    expect(statusIds(repliesBoolean)).toEqual([tagged.id]);
    expect(repliesString).toEqual(repliesBoolean);

    accepted(
      ApiStatus,
      await sendJson(email, "POST", `/api/v1/statuses/${plain.id}/pin`),
      "pin status",
    );
    const [pinnedBoolean, pinnedString] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/accounts/:id/statuses?pinned",
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?pinned=true`),
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?pinned=1`),
    );
    expect(statusIds(pinnedBoolean)).toEqual([plain.id]);
    expect(pinnedString).toEqual(pinnedBoolean);
  });

  it("conversations and trends read their limit and offset", async () => {
    const email = "params-conversations@example.com";
    const other = await credentials("params-conversations-other@example.com");
    await credentials(email);
    await postStatus(email, { status: `@${other.username} psst`, visibility: "direct" });

    const [conversations, repeated] = await bothAccepted(
      z.array(ApiConversation),
      "GET /api/v1/conversations",
      sendGet(email, "/api/v1/conversations?limit=5"),
      sendGet(email, "/api/v1/conversations?limit=5&limit=1"),
    );
    expect(conversations.length).toBe(1);
    expect(repeated).toEqual(conversations);

    const sameTrends = async <T>(schema: z.ZodType<T>, path: string) => {
      const [first, again] = await bothAccepted(
        schema,
        `GET ${path}`,
        sendGet(email, `${path}?limit=5&offset=0`),
        sendGet(email, `${path}?limit=5&limit=10&offset=0&offset=3`),
      );
      expect(again).toEqual(first);
    };
    await sameTrends(z.array(ApiHashtag), "/api/v1/trends/tags");
    await sameTrends(z.array(ApiStatus), "/api/v1/trends/statuses");
    await sameTrends(z.array(ApiTrendsLink), "/api/v1/trends/links");
  });

  it("filters: a v2 filter with contexts and keywords, and a filter status", async () => {
    const email = "params-filters@example.com";
    await credentials(email);

    const [jsonFilter, formFilter] = await bothAccepted(
      ApiFilter,
      "POST /api/v2/filters",
      sendJson(email, "POST", "/api/v2/filters", {
        title: "Spoilers",
        context: ["home", "public"],
        filter_action: "hide",
        keywords_attributes: [{ keyword: "finale", whole_word: true }],
      }),
      sendForm(email, "POST", "/api/v2/filters", [
        ["title", "Spoilers"],
        ["context[]", "home"],
        ["context[]", "public"],
        ["filter_action", "hide"],
        ["keywords_attributes[0][keyword]", "finale"],
        ["keywords_attributes[0][whole_word]", "1"],
      ]),
    );
    for (const filter of [jsonFilter, formFilter]) {
      expect(filter).toMatchObject({
        title: "Spoilers",
        context: ["home", "public"],
        filter_action: "hide",
        keywords: [{ keyword: "finale", whole_word: true }],
      });
    }

    const status = await postStatus(email, { status: "filter me" });
    const [jsonStatus, formStatus] = await bothAccepted(
      ApiFilterStatus,
      "POST /api/v2/filters/:id/statuses",
      sendJson(email, "POST", `/api/v2/filters/${jsonFilter.id}/statuses`, {
        status_id: status.id,
      }),
      sendForm(email, "POST", `/api/v2/filters/${formFilter.id}/statuses`, [
        ["status_id", status.id],
      ]),
    );
    expect(jsonStatus.status_id).toBe(status.id);
    expect(formStatus.status_id).toBe(status.id);
  });

  it("web settings: the settings object as JSON and as a form", async () => {
    const email = "params-web-settings@example.com";
    await credentials(email);
    await bothAccepted(
      z.object({}),
      "PUT /api/web/settings",
      sendJson(email, "PUT", "/api/web/settings", {
        data: { introductionVersion: 20181216044202, home: { shows: { reblog: false } } },
      }),
      sendForm(email, "PUT", "/api/web/settings", [
        ["data[introductionVersion]", "20181216044202"],
        ["data[home][shows][reblog]", "false"],
      ]),
    );
    const refused = await sendJson(email, "PUT", "/api/web/settings", { data: "not an object" });
    expect(refused).toEqual({
      status: 422,
      body: { error: "Validation failed", kind: "ValidationError" },
    });
  });
});
