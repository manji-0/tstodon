import { hasCompiledFastPath, schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Activity } from "./activity";
import { AccountId } from "./account-id";
import { OutboxDelivery } from "./outbox-delivery";
import { Visibility } from "./visibility";
import { Username } from "./username";

describe("compiled domain companions", () => {
  it("Activity.parse Ok/Err matches uncompiled semantics and uses a fast path", () => {
    expect(hasCompiledFastPath(Activity.schema)).toBe(true);

    const ok = Activity.parse({
      kind: "Follow",
      id: "act-1",
      actor: "https://example.com/users/a",
      object: "https://example.com/users/b",
    });
    expect(ok.isOk()).toBe(true);
    if (ok.isOk()) {
      expect(ok.value.kind).toBe("Follow");
    }

    const err = Activity.parse({ kind: "Follow", id: "", actor: "x", object: "y" });
    expect(err.isErr()).toBe(true);
    if (err.isErr()) {
      expect(err.error.kind).toBe("ValidationError");
    }
  });

  it("Visibility and AccountId companions parse through compiled schemaResult", () => {
    expect(hasCompiledFastPath(Visibility.schema)).toBe(true);
    expect(hasCompiledFastPath(AccountId.schema)).toBe(true);

    const visibility = Visibility.parse({ kind: "Public" });
    expect(visibility.isOk()).toBe(true);

    const accountId = AccountId.parse("acct-1");
    expect(accountId.isOk()).toBe(true);
    if (accountId.isOk()) {
      expect(accountId.value).toBe("acct-1");
    }

    expect(AccountId.parse("").isErr()).toBe(true);
    expect(Visibility.parse({ kind: "Nope" }).isErr()).toBe(true);
  });

  it("OutboxDelivery discriminated union preserves Err kind on invalid input", () => {
    expect(hasCompiledFastPath(OutboxDelivery.schema)).toBe(true);
    const parsed = OutboxDelivery.parse({ kind: "Queued" });
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.kind).toBe("ValidationError");
    }
  });

  it("Username.parse stays Blank/InvalidCharacters after compile wiring", () => {
    expect(Username.parse("").isErr()).toBe(true);
    const blank = Username.parse("");
    if (blank.isErr()) {
      expect(blank.error.kind).toBe("Blank");
    }
    const invalid = Username.parse("Bad-Name");
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) {
      expect(invalid.error.kind).toBe("InvalidCharacters");
    }
    const ok = Username.parse("alice_1");
    expect(ok.isOk()).toBe(true);
  });

  it("nested array/object schemaResult path stays parity-safe when compiled", () => {
    const schema = z.object({
      options: z.array(
        z.object({
          title: z.string().min(1),
          votesCount: z.number().int().nonnegative(),
        }),
      ),
    });
    const parse = schemaResult(schema);
    expect(hasCompiledFastPath(schema)).toBe(true);

    const ok = parse({
      options: [
        { title: "yes", votesCount: 2 },
        { title: "no", votesCount: 0 },
      ],
    });
    expect(ok.isOk()).toBe(true);

    const err = parse({ options: [{ title: "", votesCount: -1 }] });
    expect(err.isErr()).toBe(true);
  });
});
