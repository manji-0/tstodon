import { describe, expect, it } from "vite-plus/test";
import { DomainBlockPolicy } from "./domain-block-policy";

const policy = (
  severity: DomainBlockPolicy["severity"],
  rejects: Partial<Pick<DomainBlockPolicy, "rejectMedia" | "rejectReports">> = {},
): DomainBlockPolicy => ({
  severity,
  rejectMedia: rejects.rejectMedia ?? false,
  rejectReports: rejects.rejectReports ?? false,
});

describe("DomainBlockPolicy.stricterThan (DomainBlock#stricter_than?)", () => {
  it("counts a suspension as stricter than anything, another suspension included", () => {
    expect(DomainBlockPolicy.stricterThan(policy("suspend"), policy("silence"))).toBe(true);
    expect(DomainBlockPolicy.stricterThan(policy("suspend"), policy("noop"))).toBe(true);
    expect(
      DomainBlockPolicy.stricterThan(
        policy("suspend"),
        policy("suspend", { rejectMedia: true, rejectReports: true }),
      ),
    ).toBe(true);
  });

  it("refuses a lower severity", () => {
    expect(DomainBlockPolicy.stricterThan(policy("silence"), policy("suspend"))).toBe(false);
    expect(DomainBlockPolicy.stricterThan(policy("noop"), policy("suspend"))).toBe(false);
    expect(DomainBlockPolicy.stricterThan(policy("noop"), policy("silence"))).toBe(false);
  });

  it("refuses dropping a media or report rejection the other rule has", () => {
    expect(
      DomainBlockPolicy.stricterThan(policy("silence"), policy("silence", { rejectMedia: true })),
    ).toBe(false);
    expect(
      DomainBlockPolicy.stricterThan(policy("silence"), policy("silence", { rejectReports: true })),
    ).toBe(false);
    expect(
      DomainBlockPolicy.stricterThan(policy("noop"), policy("noop", { rejectMedia: true })),
    ).toBe(false);
  });

  it("compares only the rejections for a severity Mastodon does not know", () => {
    const unknown = { severity: undefined, rejectMedia: false, rejectReports: false };
    expect(DomainBlockPolicy.stricterThan(unknown, policy("suspend"))).toBe(true);
    expect(DomainBlockPolicy.stricterThan(unknown, policy("silence", { rejectMedia: true }))).toBe(
      false,
    );
  });

  it("counts an equal or wider rule as stricter", () => {
    expect(DomainBlockPolicy.stricterThan(policy("silence"), policy("silence"))).toBe(true);
    expect(DomainBlockPolicy.stricterThan(policy("noop"), policy("noop"))).toBe(true);
    expect(DomainBlockPolicy.stricterThan(policy("silence"), policy("noop"))).toBe(true);
    expect(
      DomainBlockPolicy.stricterThan(
        policy("silence", { rejectMedia: true }),
        policy("silence", { rejectMedia: true }),
      ),
    ).toBe(true);
  });
});
