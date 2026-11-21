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
  stricterThan: (
    block: Omit<DomainBlockPolicy, "severity"> &
      Readonly<{
        /**
         * `undefined` for a severity Mastodon does not know: its create
         * compares the rules before validating, and such a block is neither
         * suspend, silence nor noop there, so only its rejections count.
         */
        severity: DomainBlockPolicy["severity"] | undefined;
      }>,
    other: DomainBlockPolicy,
  ): boolean => {
    if (block.severity === "suspend") {
      return true;
    }
    if (other.severity === "suspend" && block.severity !== undefined) {
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
