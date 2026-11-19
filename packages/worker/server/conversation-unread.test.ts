import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiConversation } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";

// Mastodon v4.7.5's `Api::V1::ConversationsController#unread`.

const send = async (
  email: string | undefined,
  method: string,
  path: string,
  scopes?: ReadonlyArray<string>,
) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: email === undefined ? {} : await authHeaders(email, { scopes }),
  });
  return { status: response.status, body: await response.json() };
};

const conversationOf = async (email: string, id: string) => {
  const listed = await send(email, "GET", "/api/v1/conversations");
  return expectContract(z.array(ApiConversation), listed.body).find((entry) => entry.id === id);
};

describe("POST /api/v1/conversations/:id/unread", () => {
  it("marks a read conversation unread, answers it and sends it to the direct stream", async () => {
    const author = "dm-unread-author@example.com";
    const recipient = "dm-unread-recipient@example.com";
    const { username } = await signedInAccount(recipient);
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(author)) },
      body: JSON.stringify({ status: `@${username} read me twice`, visibility: "direct" }),
    });
    expect(posted.status).toBe(200);
    const statusId = z.object({ id: z.string() }).parse(await posted.json()).id;
    const [conversation] = expectContract(
      z.array(ApiConversation),
      (await send(recipient, "GET", "/api/v1/conversations")).body,
    );
    const id = conversation?.id ?? "";
    expect((await send(recipient, "POST", `/api/v1/conversations/${id}/read`)).status).toBe(200);
    expect((await conversationOf(recipient, id))?.unread).toBe(false);

    const socket = await openStream({ email: recipient, query: "?stream=direct" });
    const marked = await send(recipient, "POST", `/api/v1/conversations/${id}/unread`);
    expect(marked.status).toBe(200);
    expect(expectContract(ApiConversation, marked.body)).toMatchObject({
      id,
      unread: true,
      last_status: { id: statusId },
    });
    expect((await conversationOf(recipient, id))?.unread).toBe(true);
    const heard = await socket.next();
    expect(heard).toMatchObject({ stream: ["direct"], event: "conversation" });
    expect(expectContract(ApiConversation, JSON.parse(heard.payload))).toMatchObject({
      id,
      unread: true,
    });
    socket.close();

    // Marking it unread again changes nothing.
    const again = await send(recipient, "POST", `/api/v1/conversations/${id}/unread`);
    expect(expectContract(ApiConversation, again.body).unread).toBe(true);
    // The author's own view of the conversation is the author's.
    expect((await send(author, "POST", `/api/v1/conversations/${id}/read`)).status).toBe(200);
    expect((await conversationOf(recipient, id))?.unread).toBe(true);
  });

  it("answers 404 for a conversation the account is not in", async () => {
    const missing = await send(
      "dm-unread-stranger@example.com",
      "POST",
      "/api/v1/conversations/1/unread",
    );
    expect(missing.status).toBe(404);
  });

  it("needs a user token with write:conversations", async () => {
    expect((await send(undefined, "POST", "/api/v1/conversations/1/unread")).status).toBe(401);
    const readOnly = await send(
      "dm-unread-scope@example.com",
      "POST",
      "/api/v1/conversations/1/unread",
      ["read:statuses"],
    );
    expect(readOnly.status).toBe(403);
    const scoped = await send(
      "dm-unread-scope@example.com",
      "POST",
      "/api/v1/conversations/1/unread",
      ["write:conversations"],
    );
    expect(scoped.status).toBe(404);
  });
});
