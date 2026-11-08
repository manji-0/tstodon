import { describe, expect, it } from "vite-plus/test";
import { RemoteAccountId } from "./remote-account-id";

describe("RemoteAccountId", () => {
  it("round-trips an actor uri into a path-safe id", () => {
    const actorUri = "https://remote.example/users/fr-frank";
    const id = RemoteAccountId.encode(actorUri);
    expect(id.startsWith("r_")).toBe(true);
    expect(id).not.toContain("/");
    expect(id).not.toContain(":");
    const decoded = RemoteAccountId.decode(id);
    expect(decoded.isOk()).toBe(true);
    if (decoded.isOk()) {
      expect(decoded.value).toBe(actorUri);
    }
  });

  it("round-trips unicode and query characters", () => {
    const actorUri = "https://例え.example/users/üser?x=1";
    const decoded = RemoteAccountId.decode(RemoteAccountId.encode(actorUri));
    expect(decoded.isOk()).toBe(true);
    if (decoded.isOk()) {
      expect(decoded.value).toBe(actorUri);
    }
  });

  it("rejects ids without the remote prefix or with bad base64", () => {
    expect(RemoteAccountId.decode("12345").isErr()).toBe(true);
    expect(RemoteAccountId.decode("r_").isErr()).toBe(true);
    expect(RemoteAccountId.decode("r_@@@").isErr()).toBe(true);
  });
});
