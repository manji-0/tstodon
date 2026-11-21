/** What an instance domain rule does to the hosts it covers: a `DomainBlock` without its domain. */
export type DomainBlockPolicy = Readonly<{
  severity: "silence" | "suspend" | "noop";
  rejectMedia: boolean;
  rejectReports: boolean;
}>;

export const DomainBlockPolicy = {
  /**
   * Mastodon's `DomainBlock#stricter_than?`: whether `block` limits a host at
   * least as much as `other`. Creating a block is refused when the rule
   * already covering its domain is not weaker.
   */
  stricterThan: (block: DomainBlockPolicy, other: DomainBlockPolicy): boolean => {
    if (block.severity === "suspend") {
      return true;
    }
    if (other.severity === "suspend") {
      return false;
    }
    if (other.severity === "silence" && block.severity === "noop") {
      return false;
    }
    return (
      (block.rejectMedia || !other.rejectMedia) && (block.rejectReports || !other.rejectReports)
    );
  },
} as const;
