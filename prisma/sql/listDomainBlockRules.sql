-- Every instance domain rule, for the Worker's `DomainBlock.rule_for`: a host
-- follows the rule on its longest domain among itself and the domains above it.
SELECT domain, severity, reject_media, reject_reports FROM domain_blocks
