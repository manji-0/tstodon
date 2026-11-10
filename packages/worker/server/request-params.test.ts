import { describe, expect, it } from "vite-plus/test";
import {
  ApiCreateListParamsSchema,
  ApiFollowAccountParamsSchema,
  ApiGetNotificationsParamsSchema,
  ApiPollVoteParamsSchema,
  ApiUpdateCredentialsParamsSchema,
} from "@tstodon/api";
import { castParams, foldArrayKeys, parseBodyParams } from "./request-params";

describe("request params normalization", () => {
  it("folds key[] into key, bracketed values first", () => {
    expect(foldArrayKeys({ id: "b", "id[]": ["a"], other: "x" })).toEqual({
      id: ["a", "b"],
      other: "x",
    });
  });

  it("casts form strings to the schema's booleans, numbers and arrays", () => {
    expect(
      castParams(
        ApiGetNotificationsParamsSchema,
        { include_filtered: "1", limit: "15", types: "follow", max_id: "9" },
        "query",
      ),
    ).toEqual({ include_filtered: true, limit: 15, types: ["follow"], max_id: "9" });
  });

  it("leaves out a number that does not parse, so the default applies", () => {
    expect(castParams(ApiGetNotificationsParamsSchema, { limit: "many" }, "query")).toEqual({});
  });

  it("reads anything but true or 1 as false, as isTruthy did", () => {
    expect(
      parseBodyParams(ApiFollowAccountParamsSchema, { reblogs: "no", notify: "true" }).unwrapOr(
        undefined,
      ),
    ).toEqual({ reblogs: false, notify: true });
  });

  it("keeps the first value of a repeated query key for a single field", () => {
    expect(castParams(ApiGetNotificationsParamsSchema, { limit: ["5", "9"] }, "query")).toEqual({
      limit: 5,
    });
  });

  it("an empty string is an empty list", () => {
    expect(castParams(ApiPollVoteParamsSchema, { choices: "" }, "body")).toEqual({ choices: [] });
  });

  it("nests and casts a form's bracketed keys", () => {
    expect(
      parseBodyParams(ApiUpdateCredentialsParamsSchema, {
        "fields_attributes[0][name]": "Site",
        "source[sensitive]": "1",
        "attribution_domains[]": ["example.com"],
      }).unwrapOr(undefined),
    ).toEqual({
      fields_attributes: { "0": { name: "Site" } },
      source: { sensitive: true },
      attribution_domains: ["example.com"],
    });
  });

  it("still refuses what the schema does not allow", () => {
    expect(parseBodyParams(ApiCreateListParamsSchema, { title: "" }).isErr()).toBe(true);
    expect(
      parseBodyParams(ApiCreateListParamsSchema, { title: "a", replies_policy: "all" }).isErr(),
    ).toBe(true);
  });
});
