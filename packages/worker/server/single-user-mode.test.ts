import { NodeInfo21 } from "@tstodon/api/activitypub";
import { ApiInitialState, ApiInstance, ApiV1Instance } from "@tstodon/api";
import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signAccessJwt } from "../test/access-jwt-fixture";
import { expectContract } from "../test/api-contract";
import { envWith } from "../test/env-fixture";
import { serveNodeinfo } from "./nodeinfo";
import { getAuthSignIn } from "./routes/oauth";
import { getV1Instance, getV2Instance } from "./routes/instance";
import { registrationsOpen, signUpPolicy, singleUserMode } from "./runtime-config";
import { initialState } from "./web-app";

// This file's D1 starts empty: its first sign-in is a fresh instance's.
const singleUser = envWith({
  SINGLE_USER_MODE: "true",
  REGISTRATIONS_OPEN: "true",
  // An owner held for approval would have no admin to approve it.
  REGISTRATION_APPROVAL: "true",
  // The nodeinfo edge cache is keyed by this origin.
  INSTANCE_PUBLIC_ORIGIN: "https://single.example.com",
});
const multiUser = envWith({
  SINGLE_USER_MODE: "false",
  REGISTRATIONS_OPEN: "true",
  INSTANCE_PUBLIC_ORIGIN: "https://multi.example.com",
});

const app = new Hono<{ Bindings: Env }>();
app.get("/auth/sign_in", getAuthSignIn);
app.get("/api/v1/instance", getV1Instance);
app.get("/api/v2/instance", getV2Instance);
app.get("/nodeinfo/2.1", (c) => serveNodeinfo(c, "2.1"));

const get = (testEnv: Env, path: string, headers: Record<string, string> = {}) =>
  // The test Access key is accepted only on a local host.
  app.request(`http://127.0.0.1${path}`, { headers }, testEnv, createExecutionContext());

const signIn = async (testEnv: Env, email: string) =>
  get(testEnv, "/auth/sign_in", { "Cf-Access-Jwt-Assertion": await signAccessJwt({ email }) });

const AccountRow = z.object({ id: z.string(), role: z.string().nullable(), pending: z.number() });

const accountOf = async (email: string) => {
  const row = await env.DB.prepare(
    `SELECT a.id, u.role, COALESCE(f.pending, 0) AS pending FROM accounts a
     LEFT JOIN "user" u ON u.id = a.auth_user_id
     LEFT JOIN account_flags f ON f.account_id = a.id WHERE a.access_email = ?`,
  )
    .bind(email)
    .first();
  return row === null ? undefined : AccountRow.parse(row);
};

const advertised = async (testEnv: Env) => ({
  v1: expectContract(ApiV1Instance, await (await get(testEnv, "/api/v1/instance")).json())
    .registrations,
  v2: expectContract(ApiInstance, await (await get(testEnv, "/api/v2/instance")).json())
    .registrations.enabled,
  nodeinfo: expectContract(NodeInfo21, await (await get(testEnv, "/nodeinfo/2.1")).json())
    .openRegistrations,
});

describe("single-user mode", () => {
  it("is on unless the var says otherwise, and wins over REGISTRATIONS_OPEN", () => {
    expect(singleUserMode({})).toBe(true);
    expect(singleUserMode({ SINGLE_USER_MODE: " False " })).toBe(false);
    expect(signUpPolicy({ REGISTRATIONS_OPEN: "true" })).toBe("OwnerOnly");
    expect(signUpPolicy({ SINGLE_USER_MODE: "off", REGISTRATIONS_OPEN: "true" })).toBe("Open");
    expect(signUpPolicy({ SINGLE_USER_MODE: "off", REGISTRATIONS_OPEN: "false" })).toBe("Closed");
    expect(registrationsOpen({ REGISTRATIONS_OPEN: "true" })).toBe(false);
  });

  it("reports registrations closed, as Mastodon does, even before the owner exists", async () => {
    expect(await advertised(singleUser)).toEqual({ v1: false, v2: false, nodeinfo: false });
    expect(await advertised(multiUser)).toEqual({ v1: true, v2: true, nodeinfo: true });
  });

  it("makes the first sign-in the owner, an approved admin, and refuses every later one", async () => {
    await signIn(singleUser, "owner@single.example");
    const owner = await accountOf("owner@single.example");
    expect(owner).toMatchObject({ role: "admin", pending: 0 });

    await signIn(singleUser, "second@single.example");
    expect(await accountOf("second@single.example")).toBeUndefined();

    const again = await signIn(singleUser, "owner@single.example");
    expect(again.status).toBe(200);
    expect(await accountOf("owner@single.example")).toEqual(owner);
  });

  it("names the owner in the web UI's initial state, which sends a signed-out / to its profile", async () => {
    const request = new Request("https://example.com/");
    const single = expectContract(
      ApiInitialState,
      await initialState(singleUser, request, "en", undefined),
    );
    const owner = await accountOf("owner@single.example");
    expect(single.meta).toMatchObject({
      single_user_mode: true,
      registrations_open: false,
      owner: owner?.id,
    });
    expect(owner && single.accounts[owner.id]?.username).toBe("owner");

    const multi = expectContract(
      ApiInitialState,
      await initialState(multiUser, request, "en", undefined),
    );
    expect(multi.meta.single_user_mode).toBe(false);
    expect(multi.meta.owner).toBeUndefined();
    expect(multi.accounts).toEqual({});
  });

  it("lets a later account sign up once single-user mode is off", async () => {
    await signIn(multiUser, "second@single.example");
    expect(await accountOf("second@single.example")).toMatchObject({ role: "user" });
  });
});
