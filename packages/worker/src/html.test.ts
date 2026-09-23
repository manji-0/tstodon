import { describe, expect, it } from "vitest";
import { escapeHtml, mentionUsernames, textToHtml } from "./html";

describe("html helpers", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("wraps escaped text and converts newlines", () => {
    expect(textToHtml("hi\n<script>")).toBe("<p>hi<br>&lt;script&gt;</p>");
  });

  it("collects unique lowercase mention usernames", () => {
    expect(mentionUsernames("Hello @Alice and @bob_01 and @Alice again")).toEqual([
      "alice",
      "bob_01",
    ]);
    expect(mentionUsernames("no mentions here")).toEqual([]);
  });
});
