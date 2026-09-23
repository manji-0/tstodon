import { peekCompiledFastPath, schemaResult } from "@tstodon/core";
import { Activity, Visibility } from "@tstodon/domain";
import { describe, expect, it } from "vitest";
import { parseMarkerTimelines } from "./marker-store";
import { PollVoteTargetRowSchema } from "./poll-store";
import {
  AccountRowSchema,
  ActivityJsonSchema,
  CreateStatusBodySchema,
  PollOptionsSchema,
} from "./schemas";

describe("worker zod compile smoke", () => {
  it("module-init warmSchemas left compiled validators in the cache (no late compile)", () => {
    // peekCompiledFastPath only reads the WeakMap / bag — it never calls z.compile.
    expect(peekCompiledFastPath(AccountRowSchema)).toBe(true);
    expect(peekCompiledFastPath(ActivityJsonSchema)).toBe(true);
    expect(peekCompiledFastPath(CreateStatusBodySchema)).toBe(true);
    expect(peekCompiledFastPath(PollOptionsSchema)).toBe(true);
    expect(peekCompiledFastPath(PollVoteTargetRowSchema)).toBe(true);
    expect(peekCompiledFastPath(Activity.schema)).toBe(true);
    expect(peekCompiledFastPath(Visibility.schema)).toBe(true);
  });

  it("compiled worker schemas parse valid and invalid inputs through schemaResult", () => {
    const parseAccount = schemaResult(AccountRowSchema);
    const ok = parseAccount({
      id: "acct-1",
      username: "alice",
      access_email: "alice@example.com",
      display_name: "Alice",
      locked: 0,
      default_post_visibility: "public",
      default_quote_policy: "public",
      public_key_pem: "pem",
      private_key_jwk: "{}",
      created_at: "2026-01-01T00:00:00.000Z",
      bio_text: "",
      avatar_object_key: null,
      header_object_key: null,
    });
    expect(ok.isOk()).toBe(true);

    const err = parseAccount({
      id: "",
      username: "alice",
      access_email: "alice@example.com",
      display_name: "Alice",
      locked: 0,
      default_post_visibility: "public",
      default_quote_policy: "public",
      public_key_pem: "pem",
      private_key_jwk: "{}",
      created_at: "2026-01-01T00:00:00.000Z",
      bio_text: "",
      avatar_object_key: null,
      header_object_key: null,
    });
    expect(err.isErr()).toBe(true);
    if (err.isErr()) {
      expect(err.error.kind).toBe("ValidationError");
    }
  });

  it("parseMarkerTimelines uses the module-init compiled MarkerTimeline schema", () => {
    expect(parseMarkerTimelines(["home", "notifications", "nope"])).toEqual([
      "home",
      "notifications",
    ]);
    expect(parseMarkerTimelines("home")).toEqual(["home"]);
    expect(parseMarkerTimelines(null)).toEqual([]);
  });

  it("new Function is available during worker module evaluation (startup eval window)", () => {
    let evalAllowed = false;
    let compileMessage = "ok";
    try {
      const F = Function;
      const fn = new F("return 1+1");
      evalAllowed = fn() === 2;
    } catch (cause) {
      compileMessage = cause instanceof Error ? cause.message : String(cause);
    }
    // compatibility_date >= 2025-06-01 enables allow_eval_during_startup by default
    // (explicit flag is rejected by workerd once it is the default).
    expect(evalAllowed).toBe(true);
    expect(compileMessage).toBe("ok");
  });
});
