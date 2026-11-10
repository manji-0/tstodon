import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAccount,
  ApiTrendsLink,
  ApiHashtag,
  ApiFilterStatus,
  ApiFilter,
  ApiConversation,
  ApiCredentialAccount,
  ApiFamiliarFollowers,
  ApiFeaturedTag,
  ApiList,
  ApiMediaAttachment,
  ApiNotification,
  ApiNotificationGroupsResult,
  ApiNotificationPolicy,
  ApiPoll,
  ApiProfileDocument,
  ApiRelationship,
  ApiReport,
  ApiSearchResults,
  ApiStatus,
  ApiSuggestion,
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

describe("REST request params of the account and interaction actions", () => {
  it("accounts: lookup, relationships and mute", async () => {
    const viewer = "params-relations-viewer@example.com";
    const first = await credentials("params-relations-first@example.com");
    const second = await credentials("params-relations-second@example.com");
    await credentials(viewer);

    const looked = accepted(
      ApiAccount,
      await sendGet(viewer, `/api/v1/accounts/lookup?acct=${first.username}`),
      "GET /api/v1/accounts/lookup",
    );
    expect(looked.id).toBe(first.id);
    // Without `acct` there is nothing to find, as Mastodon.
    expect((await sendGet(viewer, "/api/v1/accounts/lookup")).status).toBe(404);

    const [bracketed, plain] = await bothAccepted(
      z.array(ApiRelationship),
      "GET /api/v1/accounts/relationships",
      sendGet(
        viewer,
        `/api/v1/accounts/relationships?with_suspended=true&id[]=${first.id}&id[]=${second.id}`,
      ),
      sendGet(
        viewer,
        `/api/v1/accounts/relationships?with_suspended=1&id=${first.id}&id=${second.id}`,
      ),
    );
    expect(bracketed.map((relationship) => relationship.id)).toEqual([first.id, second.id]);
    expect(plain).toEqual(bracketed);

    const [jsonMute, formMute] = await bothAccepted(
      ApiRelationship,
      "POST /api/v1/accounts/:id/mute",
      sendJson(viewer, "POST", `/api/v1/accounts/${first.id}/mute`, {
        notifications: false,
        duration: 3600,
      }),
      sendForm(viewer, "POST", `/api/v1/accounts/${second.id}/mute`, [
        ["notifications", "0"],
        ["duration", "3600"],
      ]),
    );
    for (const relationship of [jsonMute, formMute]) {
      expect(relationship).toMatchObject({ muting: true, muting_notifications: false });
      expect(relationship.muting_expires_at).not.toBeNull();
    }

    // Left out (or `null`), notifications are muted too and the mute does not expire.
    const [jsonDefault, formDefault] = await bothAccepted(
      ApiRelationship,
      "POST /api/v1/accounts/:id/mute (defaults)",
      sendJson(viewer, "POST", `/api/v1/accounts/${first.id}/mute`, {
        notifications: null,
        duration: null,
      }),
      sendForm(viewer, "POST", `/api/v1/accounts/${second.id}/mute`, []),
    );
    for (const relationship of [jsonDefault, formDefault]) {
      expect(relationship).toMatchObject({
        muting: true,
        muting_notifications: true,
        muting_expires_at: null,
      });
    }
  });

  it("mutes: the list pages with a Link header", async () => {
    const viewer = "params-mutes-pages@example.com";
    const first = await credentials("params-mutes-first@example.com");
    const second = await credentials("params-mutes-second@example.com");
    await credentials(viewer);
    for (const target of [first, second]) {
      await sendJson(viewer, "POST", `/api/v1/accounts/${target.id}/mute`, {});
    }

    const response = await SELF.fetch("https://example.com/api/v1/mutes?limit=1", {
      headers: await authHeaders(viewer),
    });
    const page = expectContract(z.array(ApiAccount), await response.json());
    expect(page).toHaveLength(1);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    expect(next).toBeDefined();
    const rest = accepted(
      z.array(ApiAccount),
      await sendGet(viewer, new URL(next ?? "").pathname + new URL(next ?? "").search),
      "GET /api/v1/mutes (next page)",
    );
    expect(ids([...page, ...rest])).toEqual(ids([first, second]));
  });

  it("account statuses: pinned and the timeline filters read string booleans", async () => {
    const email = "params-account-statuses@example.com";
    const account = await credentials(email);
    const pinned = await postStatus(email, { status: "pin me" });
    const original = await postStatus(email, { status: "a thread" });
    const reply = await postStatus(email, { status: "a reply", in_reply_to_id: original.id });
    accepted(
      ApiStatus,
      await sendJson(email, "POST", `/api/v1/statuses/${pinned.id}/pin`),
      "POST /api/v1/statuses/:id/pin",
    );

    const [pinnedTrue, pinnedOne] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/accounts/:id/statuses?pinned",
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?pinned=true`),
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?pinned=1`),
    );
    expect(pinnedTrue.map((status) => status.id)).toEqual([pinned.id]);
    expect(pinnedOne).toEqual(pinnedTrue);

    const [withoutReplies, withoutRepliesOne] = await bothAccepted(
      z.array(ApiStatus),
      "GET /api/v1/accounts/:id/statuses?exclude_replies",
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?exclude_replies=true&limit=5`),
      sendGet(email, `/api/v1/accounts/${account.id}/statuses?exclude_replies=1&limit=5`),
    );
    expect(withoutReplies.map((status) => status.id)).not.toContain(reply.id);
    expect(withoutReplies.map((status) => status.id)).toContain(original.id);
    expect(withoutRepliesOne).toEqual(withoutReplies);
  });

  it("domain blocks: block in the body, unblock in the query or the body", async () => {
    const email = "params-domain-blocks@example.com";
    await credentials(email);
    const blocked = async () =>
      accepted(
        z.array(z.string()),
        await sendGet(email, "/api/v1/domain_blocks"),
        "GET /api/v1/domain_blocks",
      ).toSorted();

    await bothAccepted(
      z.object({}),
      "POST /api/v1/domain_blocks",
      sendJson(email, "POST", "/api/v1/domain_blocks", { domain: "json.blocked.example" }),
      sendForm(email, "POST", "/api/v1/domain_blocks", [["domain", "form.blocked.example"]]),
    );
    expect(await blocked()).toEqual(["form.blocked.example", "json.blocked.example"]);
    expect((await sendJson(email, "POST", "/api/v1/domain_blocks", {})).body).toEqual({
      error: "domain is required",
      kind: "ValidationError",
    });

    // The web UI sends the DELETE's domain in the query.
    await bothAccepted(
      z.object({}),
      "DELETE /api/v1/domain_blocks",
      sendJson(email, "DELETE", "/api/v1/domain_blocks", { domain: "json.blocked.example" }),
      sendDelete(email, "/api/v1/domain_blocks?domain=form.blocked.example"),
    );
    expect(await blocked()).toEqual([]);
    expect((await sendDelete(email, "/api/v1/domain_blocks")).body).toEqual({
      error: "domain is required",
      kind: "ValidationError",
    });
  });

  it("reports: status ids, category and forward as JSON and as a form", async () => {
    const reporter = "params-report-reporter@example.com";
    const targetEmail = "params-report-target@example.com";
    const target = await credentials(targetEmail);
    await credentials(reporter);
    const [first, second] = [
      await postStatus(targetEmail, { status: "reported" }),
      await postStatus(targetEmail, { status: "reported too" }),
    ];

    const [jsonReport, formReport] = await bothAccepted(
      ApiReport,
      "POST /api/v1/reports",
      sendJson(reporter, "POST", "/api/v1/reports", {
        account_id: target.id,
        status_ids: [first.id, second.id],
        comment: "spam",
        category: "spam",
        forward: false,
        forward_to_domains: [],
      }),
      sendForm(reporter, "POST", "/api/v1/reports", [
        ["account_id", target.id],
        ["status_ids[]", first.id],
        ["status_ids[]", second.id],
        ["comment", "spam"],
        ["category", "spam"],
        ["forward", "false"],
      ]),
    );
    for (const report of [jsonReport, formReport]) {
      expect(report).toMatchObject({ category: "spam", comment: "spam", forwarded: false });
      expect(report.status_ids.toSorted()).toEqual([first.id, second.id].toSorted());
      expect(report.target_account.id).toBe(target.id);
    }
  });
});

describe("REST request params: statuses, media and compose search (web UI compose actions)", () => {
  const upload = async (
    email: string,
    fields: FormEntries = [],
    path = "/api/v2/media",
  ): Promise<z.infer<typeof ApiMediaAttachment>> => {
    const form = new FormData();
    form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    for (const [key, value] of fields) {
      form.set(key, value);
    }
    return accepted(
      ApiMediaAttachment,
      await answer(
        await SELF.fetch(`https://example.com${path}`, {
          method: "POST",
          headers: await authHeaders(email),
          body: form,
        }),
      ),
      `upload to ${path}`,
    );
  };

  const mediaAnswer = async (email: string, id: string): Promise<number> =>
    (await sendGet(email, `/api/v1/media/${id}`)).status;

  it("statuses: create with media or a poll, as JSON (with the web UI's nulls) and as a form", async () => {
    const email = "params-compose-create@example.com";
    await credentials(email);
    const [jsonMedia, formMedia] = [await upload(email), await upload(email)];

    const [jsonStatus, formStatus] = await bothAccepted(
      ApiStatus,
      "POST /api/v1/statuses (media)",
      sendJson(email, "POST", "/api/v1/statuses", {
        status: "with media",
        spoiler_text: "a warning",
        sensitive: true,
        visibility: "unlisted",
        language: "de",
        media_ids: [jsonMedia.id],
        media_attributes: [{ id: jsonMedia.id, description: "a gradient", focus: "0.5,-0.5" }],
        in_reply_to_id: null,
        poll: null,
        quoted_status_id: null,
        quote_approval_policy: "nobody",
      }),
      sendForm(email, "POST", "/api/v1/statuses", [
        ["status", "with media"],
        ["spoiler_text", "a warning"],
        ["sensitive", "1"],
        ["visibility", "unlisted"],
        ["language", "de"],
        ["media_ids[]", formMedia.id],
        ["media_attributes[0][id]", formMedia.id],
        ["media_attributes[0][description]", "a gradient"],
        ["media_attributes[0][focus]", "0.5,-0.5"],
        ["quote_approval_policy", "nobody"],
      ]),
    );
    for (const status of [jsonStatus, formStatus]) {
      expect(status).toMatchObject({
        spoiler_text: "a warning",
        sensitive: true,
        visibility: "unlisted",
        language: "de",
        in_reply_to_id: null,
        quote_approval: { automatic: [], manual: [] },
      });
      expect(status.media_attachments).toHaveLength(1);
      expect(status.media_attachments[0]).toMatchObject({
        description: "a gradient",
        meta: { focus: { x: 0.5, y: -0.5 } },
      });
    }
    expect(jsonStatus.media_attachments[0]?.id).toBe(jsonMedia.id);
    expect(formStatus.media_attachments[0]?.id).toBe(formMedia.id);

    const [jsonPoll, formPoll] = await bothAccepted(
      ApiStatus,
      "POST /api/v1/statuses (poll)",
      sendJson(email, "POST", "/api/v1/statuses", {
        status: "Which one?",
        poll: { options: ["this", "that"], expires_in: 3600, multiple: true, hide_totals: false },
        language: null,
        media_ids: [],
      }),
      sendForm(email, "POST", "/api/v1/statuses", [
        ["status", "Which one?"],
        ["poll[options][]", "this"],
        ["poll[options][]", "that"],
        ["poll[expires_in]", "3600"],
        ["poll[multiple]", "true"],
        ["poll[hide_totals]", "0"],
      ]),
    );
    for (const status of [jsonPoll, formPoll]) {
      expect(status.poll).toMatchObject({
        multiple: true,
        options: [{ title: "this" }, { title: "that" }],
      });
    }
  });

  it("statuses: edit with media_attributes as JSON and as a form, and a null description", async () => {
    const email = "params-compose-edit@example.com";
    await credentials(email);
    const [jsonMedia, formMedia] = [
      await upload(email, [["description", "before"]]),
      await upload(email, [["description", "before"]]),
    ];
    const [jsonNote, formNote] = [
      await postStatus(email, { status: "before edit", media_ids: [jsonMedia.id] }),
      await postStatus(email, { status: "before edit", media_ids: [formMedia.id] }),
    ];

    const [jsonEdited, formEdited] = await bothAccepted(
      ApiStatus,
      "PUT /api/v1/statuses/:id",
      sendJson(email, "PUT", `/api/v1/statuses/${jsonNote.id}`, {
        status: "after edit",
        spoiler_text: "",
        sensitive: false,
        language: "en",
        media_ids: [jsonMedia.id],
        media_attributes: [{ id: jsonMedia.id, description: "after", focus: "0.25,-0.25" }],
        in_reply_to_id: null,
        poll: null,
      }),
      sendForm(email, "PUT", `/api/v1/statuses/${formNote.id}`, [
        ["status", "after edit"],
        ["spoiler_text", ""],
        ["sensitive", "false"],
        ["language", "en"],
        ["media_ids[]", formMedia.id],
        ["media_attributes[0][id]", formMedia.id],
        ["media_attributes[0][description]", "after"],
        ["media_attributes[0][focus]", "0.25,-0.25"],
      ]),
    );
    for (const status of [jsonEdited, formEdited]) {
      expect(status.edited_at).not.toBeNull();
      expect(status.language).toBe("en");
      expect(status.media_attachments[0]).toMatchObject({
        description: "after",
        meta: { focus: { x: 0.25, y: -0.25 } },
      });
    }

    // The web UI sends `description: null` for an attachment without alt
    // text (and no focus): the edit goes through and the description is cleared.
    const cleared = accepted(
      ApiStatus,
      await sendJson(email, "PUT", `/api/v1/statuses/${jsonNote.id}`, {
        status: "edited again",
        media_ids: [jsonMedia.id],
        media_attributes: [{ id: jsonMedia.id, description: null }],
      }),
      "PUT /api/v1/statuses/:id (null description)",
    );
    expect(cleared.media_attachments[0]).toMatchObject({
      description: null,
      meta: { focus: { x: 0.25, y: -0.25 } },
    });
  });

  it("statuses: delete_media in the query or the body; without it the media stays for a redraft", async () => {
    const email = "params-compose-delete@example.com";
    await credentials(email);
    const [queryMedia, bodyMedia, keptMedia] = [
      await upload(email),
      await upload(email),
      await upload(email),
    ];
    const [queryNote, bodyNote, keptNote] = [
      await postStatus(email, { status: "delete me", media_ids: [queryMedia.id] }),
      await postStatus(email, { status: "delete me too", media_ids: [bodyMedia.id] }),
      await postStatus(email, { status: "redraft me", media_ids: [keptMedia.id] }),
    ];

    const [bodyDeleted, queryDeleted] = await bothAccepted(
      ApiStatus,
      "DELETE /api/v1/statuses/:id",
      sendJson(email, "DELETE", `/api/v1/statuses/${bodyNote.id}`, { delete_media: true }),
      sendDelete(email, `/api/v1/statuses/${queryNote.id}?delete_media=true`),
    );
    expect(bodyDeleted.text).toBe("delete me too");
    expect(queryDeleted.text).toBe("delete me");
    expect(await mediaAnswer(email, bodyMedia.id)).toBe(404);
    expect(await mediaAnswer(email, queryMedia.id)).toBe(404);

    const redrafted = accepted(
      ApiStatus,
      await sendDelete(email, `/api/v1/statuses/${keptNote.id}?delete_media=false`),
      "DELETE /api/v1/statuses/:id (redraft)",
    );
    expect(redrafted.text).toBe("redraft me");
    expect(await mediaAnswer(email, keptMedia.id)).toBe(200);
  });

  it("media: v2 and v1 uploads take description and focus; a thumbnail is read and ignored", async () => {
    const email = "params-compose-media@example.com";
    await credentials(email);
    const fields: FormEntries = [
      ["description", "a gradient"],
      ["focus", "0.1,0.2"],
    ];
    const [v2, v1] = [await upload(email, fields), await upload(email, fields, "/api/v1/media")];
    for (const media of [v2, v1]) {
      expect(media).toMatchObject({
        description: "a gradient",
        meta: { focus: { x: 0.1, y: 0.2 } },
      });
    }

    const thumbnailForm = new FormData();
    thumbnailForm.set("thumbnail", new File([PNG_40X30], "t.png", { type: "image/png" }));
    thumbnailForm.set("description", "with a thumbnail");
    const withThumbnail = accepted(
      ApiMediaAttachment,
      await answer(
        await SELF.fetch(`https://example.com/api/v1/media/${v2.id}`, {
          method: "PUT",
          headers: await authHeaders(email),
          body: thumbnailForm,
        }),
      ),
      "PUT /api/v1/media/:id (thumbnail)",
    );
    expect(withThumbnail.description).toBe("with a thumbnail");
    expect(withThumbnail.preview_url).toBe(v2.preview_url);
  });

  it("compose suggestions: account and hashtag search read string booleans and numbers", async () => {
    const email = "params-compose-search@example.com";
    const other = await credentials("params-compose-search-other@example.com");
    await credentials(email);
    await sendJson(email, "POST", `/api/v1/accounts/${other.id}/follow`);
    await postStatus(email, { status: "#paramscompose" });

    const [accountsBoolean, accountsString] = await bothAccepted(
      z.array(ApiAccount),
      "GET /api/v1/accounts/search",
      sendGet(email, `/api/v1/accounts/search?q=${other.username}&resolve=false&limit=4`),
      sendGet(email, `/api/v1/accounts/search?q=${other.username}&resolve=0&limit=4`),
    );
    expect(ids(accountsBoolean)).toContain(other.id);
    expect(accountsString).toEqual(accountsBoolean);

    const [followingBoolean, followingString] = await bothAccepted(
      z.array(ApiAccount),
      "GET /api/v1/accounts/search (following)",
      sendGet(email, `/api/v1/accounts/search?q=${other.username}&following=true`),
      sendGet(email, `/api/v1/accounts/search?q=${other.username}&following=1`),
    );
    expect(ids(followingBoolean)).toEqual([other.id]);
    expect(followingString).toEqual(followingBoolean);

    const [tagsBoolean, tagsString] = await bothAccepted(
      ApiSearchResults,
      "GET /api/v2/search (hashtags)",
      sendGet(
        email,
        "/api/v2/search?type=hashtags&q=paramscompose&resolve=false&limit=4&exclude_unreviewed=true",
      ),
      sendGet(
        email,
        "/api/v2/search?type=hashtags&q=paramscompose&resolve=0&limit=4&exclude_unreviewed=1",
      ),
    );
    expect(tagsBoolean.hashtags.map((tag) => tag.name)).toContain("paramscompose");
    expect(tagsString).toEqual(tagsBoolean);
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
