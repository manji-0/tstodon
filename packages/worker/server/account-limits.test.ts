import { SELF } from "cloudflare:test";
import { ApiCredentialAccount } from "@tstodon/api";
import { InstanceLimits } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import { expectContract } from "../test/api-contract";

const limits = InstanceLimits.account;

const update = async (
  email: string,
  body: Record<string, unknown> | FormData,
): Promise<{ status: number; body: unknown }> => {
  const headers = await authHeaders(email);
  const response = await SELF.fetch("https://example.com/api/v1/accounts/update_credentials", {
    method: "PATCH",
    headers:
      body instanceof FormData ? headers : { "content-type": "application/json", ...headers },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const refused = (error: string) => ({
  status: 422,
  body: { error: `Validation failed: ${error}`, kind: "ValidationError" },
});

const fields = (count: number, name = "name", value = "value") =>
  Array.from({ length: count }, (_, index) => ({ name: `${name}${index}`, value }));

describe("update_credentials account limits", () => {
  it("takes a display name up to max_display_name_length", async () => {
    const email = "limits-display-name@example.com";
    const atLimit = await update(email, {
      display_name: "é".repeat(limits.maxDisplayNameCharacters),
    });
    expect(atLimit.status).toBe(200);
    expect(expectContract(ApiCredentialAccount, atLimit.body).display_name).toBe(
      "é".repeat(limits.maxDisplayNameCharacters),
    );
    expect(
      await update(email, { display_name: "n".repeat(limits.maxDisplayNameCharacters + 1) }),
    ).toEqual(refused("Display name is too long (maximum is 30 characters)"));
  });

  it("takes a note up to max_note_length, counting a URL as 23 characters", async () => {
    const email = "limits-note@example.com";
    const atLimit = await update(email, { note: "b".repeat(limits.maxNoteCharacters) });
    expect(atLimit.status).toBe(200);
    expect(expectContract(ApiCredentialAccount, atLimit.body).source.note).toBe(
      "b".repeat(limits.maxNoteCharacters),
    );
    expect(await update(email, { note: "b".repeat(limits.maxNoteCharacters + 1) })).toEqual(
      refused("Note character limit of 500 exceeded"),
    );
    const url = `https://example.org/${"u".repeat(600)}`;
    expect((await update(email, { note: `${"b".repeat(476)} ${url}` })).status).toBe(200);
  });

  it("takes up to max_profile_fields fields of profile_field_name_limit / profile_field_value_limit", async () => {
    const email = "limits-fields@example.com";
    const atLimit = await update(email, {
      fields_attributes: [
        {
          name: "n".repeat(limits.maxProfileFieldNameCharacters),
          value: "v".repeat(limits.maxProfileFieldValueCharacters),
        },
        ...fields(limits.maxProfileFields - 1),
      ],
    });
    expect(atLimit.status).toBe(200);
    const stored = expectContract(ApiCredentialAccount, atLimit.body).source.fields;
    expect(stored).toHaveLength(limits.maxProfileFields);
    expect(stored[0]?.name).toBe("n".repeat(limits.maxProfileFieldNameCharacters));

    expect(await update(email, { fields_attributes: fields(limits.maxProfileFields + 1) })).toEqual(
      refused("Fields is too long (maximum is 4 characters)"),
    );
    expect(
      await update(email, {
        fields_attributes: [
          { name: "n".repeat(limits.maxProfileFieldNameCharacters + 1), value: "v" },
        ],
      }),
    ).toEqual(refused("Fields name is too long (maximum is 255 characters)"));
    expect(
      await update(email, {
        fields_attributes: [
          { name: "n", value: "v".repeat(limits.maxProfileFieldValueCharacters + 1) },
        ],
      }),
    ).toEqual(refused("Fields value is too long (maximum is 255 characters)"));
  });

  it("reads fields_attributes as an indexed object or form keys, in order", async () => {
    const email = "limits-fields-form@example.com";
    const keyed = await update(email, {
      fields_attributes: {
        "1": { name: "second", value: "2" },
        "0": { name: "first", value: "1" },
      },
    });
    expect(
      expectContract(ApiCredentialAccount, keyed.body).source.fields.map((f) => f.name),
    ).toEqual(["first", "second"]);

    const form = new FormData();
    form.set("fields_attributes[0][name]", "Site");
    form.set("fields_attributes[0][value]", "https://example.org");
    form.set("fields_attributes[1][name]", "");
    form.set("fields_attributes[1][value]", "");
    const posted = await update(email, form);
    expect(posted.status).toBe(200);
    expect(expectContract(ApiCredentialAccount, posted.body).source.fields).toEqual([
      expect.objectContaining({ name: "Site", value: "https://example.org" }),
    ]);

    const tooMany = new FormData();
    for (let index = 0; index <= limits.maxProfileFields; index += 1) {
      tooMany.set(`fields_attributes[${index}][name]`, `n${index}`);
      tooMany.set(`fields_attributes[${index}][value]`, "v");
    }
    expect(await update(email, tooMany)).toEqual(
      refused("Fields is too long (maximum is 4 characters)"),
    );
  });

  it("stores nothing when one limit is broken", async () => {
    const email = "limits-atomic@example.com";
    expect((await update(email, { display_name: "Before", note: "before" })).status).toBe(200);
    expect(
      await update(email, {
        display_name: "After",
        note: "n".repeat(limits.maxNoteCharacters + 1),
      }),
    ).toEqual(refused("Note character limit of 500 exceeded"));
    const headers = await authHeaders(email);
    const current = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
      headers,
    });
    expect(expectContract(ApiCredentialAccount, await current.json())).toMatchObject({
      display_name: "Before",
      source: { note: "before" },
    });
  });
});
