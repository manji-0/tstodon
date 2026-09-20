import { describe, expect, it } from "vitest";
import { AccountId } from "./account-id";
import { IsoInstant } from "./iso-instant";
import { LocalAccount, Registration } from "./registration";

describe("Registration", () => {
  it("validates a complete composition into IntentValidated", () => {
    const intent = Registration.validate(
      Registration.composing({
        username: "Alice",
        email: "Alice@example.com",
        passwordPresent: true,
        agreement: true,
      }),
    );
    expect(intent.isOk()).toBe(true);
    if (intent.isOk()) {
      expect(intent.value.kind).toBe("IntentValidated");
      expect(intent.value.username).toBe("alice");
    }
  });

  it("collects field issues as nested discriminants", () => {
    const errors = Registration.validate(
      Registration.composing({
        username: "",
        email: "",
        passwordPresent: false,
        agreement: false,
      }),
    );
    expect(errors.isErr()).toBe(true);
    if (errors.isErr()) {
      expect(errors.error.username.kind).toBe("Issue");
      expect(errors.error.agreement.kind).toBe("Issue");
    }
  });

  it("provisions a local account with redacted PII", () => {
    const intent = Registration.validate(
      Registration.composing({
        username: "alice",
        email: "alice@example.com",
        passwordPresent: true,
        agreement: true,
      }),
    );
    expect(intent.isOk()).toBe(true);
    if (!intent.isOk()) {
      return;
    }
    const id = AccountId.parse("acct-1");
    const createdAt = IsoInstant.parse("2026-01-01T00:00:00.000Z");
    expect(id.isOk() && createdAt.isOk()).toBe(true);
    if (!id.isOk() || !createdAt.isOk()) {
      return;
    }
    const account = LocalAccount.provision(
      Registration.register(intent.value, id.value, {
        publicKeyPem: "pem",
        privateKeyJwk: "{}",
      }),
      createdAt.value,
    );
    expect(account.kind).toBe("LocalAccount");
    expect(JSON.stringify(account)).toContain("[REDACTED]");
    expect(JSON.stringify(account)).not.toContain("alice@example.com");
  });
});
