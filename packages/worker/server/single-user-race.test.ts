import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signAccessJwt } from "../test/access-jwt-fixture";
import { beforeStatement } from "../test/d1-fault";
import { envWith } from "../test/env-fixture";
import { getAuthSignIn } from "./routes/oauth";

// This file's D1 starts empty, as a fresh single-user instance's.
const singleUser = envWith({ SINGLE_USER_MODE: "true" });

const app = new Hono<{ Bindings: Env }>();
app.get("/auth/sign_in", getAuthSignIn);

const signIn = async (email: string) =>
  // The test Access key is accepted only on a local host.
  app.request(
    "http://127.0.0.1/auth/sign_in",
    { headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt({ email }) } },
    singleUser,
    createExecutionContext(),
  );

const Emails = z.array(z.object({ email: z.string() }));

const emails = async (sql: string) =>
  Emails.parse((await env.DB.prepare(sql).all()).results).map((row) => row.email);

describe("single-user mode's first sign-in", () => {
  it("creates one owner when a second first sign-in lands between the check and the insert", async () => {
    await beforeStatement(
      (sql) => /^\s*INSERT INTO accounts\b/i.test(sql),
      // Both sign-ins have seen an empty instance; the other one inserts first.
      () => signIn("racer-b@single.example"),
      () => signIn("racer-a@single.example"),
    );

    expect(await emails(`SELECT access_email AS email FROM accounts`)).toEqual([
      "racer-b@single.example",
    ]);
    // The refused sign-in leaves no Better Auth user behind.
    expect(await emails(`SELECT email FROM "user"`)).toEqual(["racer-b@single.example"]);
  });
});
