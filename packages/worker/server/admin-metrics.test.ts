import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAdminAccount,
  ApiAdminCohort,
  ApiAdminDimension,
  ApiAdminMeasure,
  ApiCredentialAccount,
  ApiStatus,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { humanSize } from "./human-size";

/**
 * The dashboard metrics (`POST /api/v1/admin/measures`, `/dimensions`,
 * `/retention`) and `GET /api/v2/admin/accounts` with its filters.
 */

const ADMIN = "metrics-admin@example.com";

const call = async (
  method: string,
  path: string,
  options: Readonly<{
    body?: unknown;
    email?: string;
    ip?: string;
    scopes?: ReadonlyArray<string>;
  }> = {},
): Promise<Response> => {
  const email = options.email ?? ADMIN;
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      ...(await authHeaders(email, {
        admin: email === ADMIN,
        ...(options.scopes ? { scopes: options.scopes } : {}),
      })),
      ...(options.ip ? { "CF-Connecting-IP": options.ip } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
};

const ok = async <T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  options: Parameters<typeof call>[2] = {},
): Promise<T> => {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(schema, await response.json());
};

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const valueOn = (measure: z.infer<typeof ApiAdminMeasure>, day: string): number =>
  Number(measure.data.find((entry) => entry.date === `${day}T00:00:00Z`)?.value ?? "-1");

describe("admin measures", () => {
  it("counts sign-ups, activity, reports and interactions per day", async () => {
    const member = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "metrics-member@example.com",
    });
    const status = await ok(ApiStatus, "POST", "/api/v1/statuses", {
      email: "metrics-member@example.com",
      body: { status: "measured #metricstag", language: "de" },
    });
    await ok(ApiStatus, "POST", `/api/v1/statuses/${status.id}/favourite`);
    await call("POST", "/api/v1/reports", { body: { account_id: member.id, comment: "m" } });

    const measures = await ok(z.array(ApiAdminMeasure), "POST", "/api/v1/admin/measures", {
      body: {
        keys: [
          "new_users",
          "active_users",
          "interactions",
          "opened_reports",
          "resolved_reports",
          "tag_uses",
          "tag_accounts",
          "tag_servers",
          "not_a_measure",
        ],
        start_at: daysAgo(6),
        end_at: today,
        tag_uses: { id: "metricstag" },
        tag_accounts: { id: "metricstag" },
        tag_servers: { id: "metricstag" },
      },
    });
    // Unknown keys are left out; the rest come in the order asked.
    expect(measures.map((measure) => measure.key)).toEqual([
      "new_users",
      "active_users",
      "interactions",
      "opened_reports",
      "resolved_reports",
      "tag_uses",
      "tag_accounts",
      "tag_servers",
    ]);
    const byKey = new Map(measures.map((measure) => [measure.key, measure]));
    const measureOf = (key: string) => {
      const found = byKey.get(key);
      if (!found) {
        throw new Error(key);
      }
      return found;
    };
    for (const measure of measures) {
      expect(measure.data).toHaveLength(7);
      expect(measure.previous_total).toBeDefined();
    }
    expect(valueOn(measureOf("new_users"), today)).toBeGreaterThanOrEqual(2);
    // The member and the admin made authenticated requests today.
    expect(Number(measureOf("active_users").total)).toBeGreaterThanOrEqual(2);
    expect(valueOn(measureOf("interactions"), today)).toBeGreaterThanOrEqual(1);
    expect(valueOn(measureOf("opened_reports"), today)).toBeGreaterThanOrEqual(1);
    expect(measureOf("tag_uses")).toMatchObject({ total: "1" });
    expect(measureOf("tag_accounts")).toMatchObject({ total: "1" });
    expect(measureOf("tag_servers")).toMatchObject({ total: "1" });
  });

  it("totals an instance's stored rows without a previous total", async () => {
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
       VALUES (?, 'alice', 'measured.example', ?, ?, 'pem', ?), (?, 'bob', 'sub.measured.example', ?, ?, 'pem', ?)`,
    )
      .bind(
        "https://measured.example/users/alice",
        "https://measured.example/inbox",
        "https://measured.example/users/alice#key",
        new Date().toISOString(),
        "https://sub.measured.example/users/bob",
        "https://sub.measured.example/inbox",
        "https://sub.measured.example/users/bob#key",
        new Date().toISOString(),
      )
      .run();
    const [exact, withSubdomains, media] = await ok(
      z.array(ApiAdminMeasure),
      "POST",
      "/api/v1/admin/measures",
      {
        body: {
          keys: ["instance_accounts", "instance_media_attachments"],
          start_at: daysAgo(2),
          end_at: today,
          instance_accounts: { domain: "measured.example" },
          instance_media_attachments: { domain: "measured.example" },
        },
      },
    ).then(async (first) => [
      ...first.slice(0, 1),
      ...(await ok(z.array(ApiAdminMeasure), "POST", "/api/v1/admin/measures", {
        body: {
          keys: ["instance_accounts"],
          start_at: daysAgo(2),
          end_at: today,
          instance_accounts: { domain: "measured.example", include_subdomains: "true" },
        },
      })),
      ...first.slice(1),
    ]);
    expect(exact).toMatchObject({ key: "instance_accounts", total: "1" });
    expect(exact?.previous_total).toBeUndefined();
    expect(withSubdomains).toMatchObject({ total: "2" });
    // tstodon caches no remote media: a remote domain stores nothing here.
    expect(media).toMatchObject({ unit: "bytes", total: "0", human_value: "0 Bytes" });
    expect(media?.previous_total).toBeUndefined();
  });

  it("totals this server's stored media attachments in bytes, by upload day", async () => {
    const member = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "metrics-media@example.com",
    });
    const measureMedia = async (): Promise<z.infer<typeof ApiAdminMeasure>> => {
      const [measured] = await ok(z.array(ApiAdminMeasure), "POST", "/api/v1/admin/measures", {
        body: {
          keys: ["instance_media_attachments"],
          start_at: daysAgo(2),
          end_at: today,
          instance_media_attachments: { domain: "example.com" },
        },
      });
      if (measured === undefined) {
        throw new Error("no measure");
      }
      return measured;
    };
    const insert = (id: string, createdAt: string, size: number, preview: number | null) =>
      env.DB.prepare(
        `INSERT INTO media_attachments (id, account_id, object_key, content_type, created_at, file_size, preview_file_size)
         VALUES (?, ?, ?, 'image/png', ?, ?, ?)`,
      )
        .bind(id, member.id, `attachments/${member.id}/${id}-key`, createdAt, size, preview)
        .run();
    const before = await measureMedia();
    await insert("metricsmedia1", `${today}T01:00:00.000Z`, 1_200_000, 34_567);
    await insert("metricsmedia2", `${daysAgo(1)}T01:00:00.000Z`, 2048, null);
    const after = await measureMedia();
    expect(after).toMatchObject({ key: "instance_media_attachments", unit: "bytes" });
    expect(after.previous_total).toBeUndefined();
    expect(Number(after.total) - Number(before.total)).toBe(1_200_000 + 34_567 + 2048);
    expect(valueOn(after, today) - valueOn(before, today)).toBe(1_234_567);
    expect(valueOn(after, daysAgo(1)) - valueOn(before, daysAgo(1))).toBe(2048);
    // Mastodon's `number_to_human_size` of the total.
    expect(after.human_value).toBe(humanSize(Number(after.total)));
    expect(after.human_value).toMatch(/^\d+(\.\d{1,2})? (Bytes|KB|MB|GB)$/);
  });

  it("counts originals, previews, avatars, headers and custom emojis in space_usage's media entry", async () => {
    const member = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "metrics-space@example.com",
    });
    const mediaUsage = async (): Promise<z.infer<typeof ApiAdminDimension>["data"][number]> => {
      const [usage] = await ok(z.array(ApiAdminDimension), "POST", "/api/v1/admin/dimensions", {
        body: { keys: ["space_usage"], start_at: today, end_at: today },
      });
      const media = usage?.data.find((entry) => entry.key === "media");
      if (media === undefined) {
        throw new Error("no media entry");
      }
      return media;
    };
    const before = await mediaUsage();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_attachments (id, account_id, object_key, preview_object_key, content_type, created_at, file_size, preview_file_size)
         VALUES ('metricsspace1', ?, ?, ?, 'image/png', ?, 1000, 100)`,
      ).bind(
        member.id,
        `attachments/${member.id}/space-original`,
        `attachments/${member.id}/space-preview`,
        new Date().toISOString(),
      ),
      env.DB.prepare(
        `INSERT INTO account_profiles (account_id, avatar_object_key, avatar_content_type, avatar_file_size,
           header_object_key, header_content_type, header_file_size)
         VALUES (?, 'avatars/space/a', 'image/png', 20, 'headers/space/h', 'image/png', 3)
         ON CONFLICT(account_id) DO UPDATE SET avatar_object_key = 'avatars/space/a',
           avatar_file_size = 20, header_object_key = 'headers/space/h', header_file_size = 3`,
      ).bind(member.id),
      env.DB.prepare(
        `INSERT INTO custom_emojis (id, shortcode, object_key, content_type, image_file_size)
         VALUES ('metricsspaceemoji', 'metrics_space', 'emoji/metricsspaceemoji', 'image/png', 4)`,
      ),
    ]);
    const after = await mediaUsage();
    expect(after).toMatchObject({ human_key: "Media storage", unit: "bytes" });
    expect(Number(after.value) - Number(before.value)).toBe(1000 + 100 + 20 + 3 + 4);
    expect(after.human_value).toMatch(/^\d+(\.\d{1,2})? (Bytes|KB|MB|GB)$/);
  });

  it("reads form parameters and refuses a bad range", async () => {
    const form = new URLSearchParams();
    form.append("keys[]", "new_users");
    form.append("start_at", daysAgo(1));
    form.append("end_at", today);
    const response = await SELF.fetch("https://example.com/api/v1/admin/measures", {
      method: "POST",
      headers: { ...(await authHeaders(ADMIN, { admin: true })) },
      body: form,
    });
    const measures = expectContract(z.array(ApiAdminMeasure), await response.json());
    expect(measures.map((measure) => measure.key)).toEqual(["new_users"]);
    expect(measures[0]?.data).toHaveLength(2);

    const refused = async (body: Record<string, unknown>) =>
      expect(
        (await call("POST", "/api/v1/admin/measures", { body: { keys: ["new_users"], ...body } }))
          .status,
      ).toBe(422);
    await refused({ start_at: today, end_at: daysAgo(3) });
    await refused({ start_at: "yesterday-ish", end_at: today });
    await refused({ start_at: daysAgo(500), end_at: today });
  });

  it("is for admins with admin:read", async () => {
    const body = { keys: ["new_users"], start_at: today, end_at: today };
    expect(
      (await call("POST", "/api/v1/admin/measures", { email: "metrics-plain@example.com", body }))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/v1/admin/dimensions", { scopes: ["admin:write"], body })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/v1/admin/retention", { scopes: ["admin:read"], body })).status,
    ).toBe(200);
  });
});

describe("admin dimensions and retention", () => {
  it("answers each dimension in Mastodon's shape", async () => {
    await ok(ApiStatus, "POST", "/api/v1/statuses", {
      email: "metrics-dimension@example.com",
      body: { status: "Bonjour #metricsdimension", language: "fr" },
    });
    const dimensions = await ok(z.array(ApiAdminDimension), "POST", "/api/v1/admin/dimensions", {
      body: {
        keys: [
          "languages",
          "sources",
          "servers",
          "space_usage",
          "software_versions",
          "tag_servers",
          "tag_languages",
          "instance_accounts",
          "instance_languages",
        ],
        start_at: daysAgo(6),
        end_at: today,
        limit: 5,
        tag_servers: { id: "metricsdimension" },
        tag_languages: { id: "metricsdimension" },
        instance_accounts: { domain: "nowhere.example" },
        instance_languages: { domain: "nowhere.example" },
      },
    });
    const byKey = new Map(dimensions.map((dimension) => [dimension.key, dimension.data]));
    expect(byKey.get("languages")).toContainEqual({ key: "fr", human_key: "French", value: "1" });
    expect(byKey.get("sources")?.[0]).toMatchObject({ key: "web", human_key: "Website" });
    expect(byKey.get("space_usage")?.[0]).toMatchObject({ key: "d1", unit: "bytes" });
    expect(byKey.get("space_usage")?.[1]).toMatchObject({
      key: "media",
      human_key: "Media storage",
      unit: "bytes",
    });
    expect(byKey.get("software_versions")?.[0]).toMatchObject({ key: "tstodon" });
    expect(byKey.get("tag_servers")).toEqual([
      { key: "example.com", human_key: "example.com", value: "1" },
    ]);
    expect(byKey.get("tag_languages")).toEqual([{ key: "fr", human_key: "French", value: "1" }]);
    expect(byKey.get("instance_accounts")).toEqual([]);
    expect(byKey.get("instance_languages")).toEqual([]);
  });

  it("follows each day's sign-ups through the days after", async () => {
    await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "metrics-cohort@example.com",
    });
    const cohorts = await ok(z.array(ApiAdminCohort), "POST", "/api/v1/admin/retention", {
      body: { start_at: daysAgo(2), end_at: today, frequency: "day" },
    });
    expect(cohorts.map((cohort) => cohort.period)).toEqual(
      [daysAgo(2), daysAgo(1), today].map((day) => `${day}T00:00:00Z`),
    );
    expect(cohorts[0]?.data).toHaveLength(3);
    const latest = cohorts.at(-1);
    expect(latest?.data).toHaveLength(1);
    expect(latest?.data[0]?.rate).toBe(1);
    expect(Number(latest?.data[0]?.value)).toBeGreaterThanOrEqual(1);

    const monthly = await ok(z.array(ApiAdminCohort), "POST", "/api/v1/admin/retention", {
      body: { start_at: today, end_at: today, frequency: "month" },
    });
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      frequency: "month",
      period: `${today.slice(0, 7)}-01T00:00:00Z`,
    });
    expect(
      (
        await call("POST", "/api/v1/admin/retention", {
          body: { start_at: today, end_at: today, frequency: "week" },
        })
      ).status,
    ).toBe(422);
  });
});

describe("GET /api/v2/admin/accounts", () => {
  it("filters by status, role, staff, address and username", async () => {
    const plain = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "v2filter-plain@example.com",
      ip: "192.0.2.201",
    });
    const silenced = await ok(ApiCredentialAccount, "GET", "/api/v1/accounts/verify_credentials", {
      email: "v2filter-silenced@example.com",
    });
    await call("POST", `/api/v1/admin/accounts/${silenced.id}/silence`);
    const list = (query: string) =>
      ok(z.array(ApiAdminAccount), "GET", `/api/v2/admin/accounts?${query}`);

    const all = await list("username=v2filter");
    expect(all.map((account) => account.id).toSorted()).toEqual([plain.id, silenced.id].toSorted());
    expect((await list("status=silenced&username=v2filter")).map((a) => a.id)).toEqual([
      silenced.id,
    ]);
    const staff = await list("permissions=staff");
    expect(staff.length).toBeGreaterThan(0);
    for (const account of staff) {
      expect(account.role.id).toBe("admin");
    }
    expect((await list("role_ids[]=user&username=v2filter")).length).toBe(2);
    expect((await list("role_ids[]=admin&username=v2filter")).length).toBe(0);
    expect((await list("invited_by=1")).length).toBe(0);

    // The address the member's request came from, by address or range.
    const byIp = await list("ip=192.0.2.0/24");
    expect(byIp.map((account) => account.id)).toEqual([plain.id]);
    expect(byIp[0]?.ip).toBe("192.0.2.201");
    expect(byIp[0]?.ips.map((entry) => entry.ip)).toEqual(["192.0.2.201"]);
    expect((await list("ip=192.0.3.1")).length).toBe(0);

    const paged = await call("GET", "/api/v2/admin/accounts?limit=1");
    expect(paged.headers.get("Link")).toContain('rel="next"');

    expect((await call("GET", "/api/v2/admin/accounts?status=bogus")).status).toBe(422);
    expect((await call("GET", "/api/v2/admin/accounts?origin=elsewhere")).status).toBe(422);
    expect(
      (await call("GET", "/api/v2/admin/accounts", { email: "v2filter-plain@example.com" })).status,
    ).toBe(403);
    expect(
      (await call("GET", "/api/v2/admin/accounts", { scopes: ["admin:read:reports"] })).status,
    ).toBe(403);
    expect(
      (
        await call("GET", "/api/v2/admin/accounts?origin=remote", {
          scopes: ["admin:read:accounts"],
        })
      ).status,
    ).toBe(200);
  });
});
