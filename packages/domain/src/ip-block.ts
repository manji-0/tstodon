import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./repository-error";

/*
 * Mastodon's IP blocks (`IpBlock`): an admin names an IPv4 or IPv6 range
 * and what it may not do. `sign_up_requires_approval` holds a new account
 * from the range for an admin, `sign_up_block` refuses the sign-up, and
 * `no_access` refuses every request from the range.
 */

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAPPED_PREFIX = 0xffffn << 32n;

/** An address as its family and its value as an unsigned integer. */
type IpAddress = Readonly<{ family: 4 | 6; value: bigint }>;

const parseIpv4 = (raw: string): bigint | undefined => {
  const parts = raw.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0n;
  for (const part of parts) {
    // No leading zeros (`010` is octal in some parsers), at most 255.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
};

const parseHextets = (groups: ReadonlyArray<string>): bigint[] | undefined => {
  const values: bigint[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return undefined;
    }
    values.push(BigInt(Number.parseInt(group, 16)));
  }
  return values;
};

/** The groups on one side of a `::`, with a dotted IPv4 tail as two groups. */
const sideGroups = (side: string, last: boolean): bigint[] | undefined => {
  if (side.length === 0) {
    return [];
  }
  const groups = side.split(":");
  const tail = groups.at(-1) ?? "";
  if (last && tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    const head = parseHextets(groups.slice(0, -1));
    return ipv4 === undefined || head === undefined
      ? undefined
      : [...head, ipv4 >> 16n, ipv4 & 0xffffn];
  }
  return parseHextets(groups);
};

const parseIpv6 = (raw: string): bigint | undefined => {
  const halves = raw.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const [left = "", right] = halves;
  const head = sideGroups(left, right === undefined);
  const tail = right === undefined ? [] : sideGroups(right, true);
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  const missing = 8 - head.length - tail.length;
  if (right === undefined ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const groups = [...head, ...Array.from({ length: missing }, () => 0n), ...tail];
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
};

/**
 * An address in either family. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 * is the IPv4 address it maps, so an IPv4 range covers it.
 */
const parseRawAddress = (raw: string): IpAddress | undefined => {
  const trimmed = raw.trim();
  if (trimmed.includes(":")) {
    const value = parseIpv6(trimmed.replace(/^\[|\]$/g, ""));
    return value === undefined ? undefined : { family: 6, value };
  }
  const value = parseIpv4(trimmed);
  return value === undefined ? undefined : { family: 4, value };
};

const isIpv4Mapped = (address: IpAddress): boolean =>
  address.family === 6 && address.value >> 32n === 0xffffn;

/**
 * An address in either family. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 * is the IPv4 address it maps, so an IPv4 range covers it.
 */
const parseAddress = (raw: string): IpAddress | undefined => {
  const parsed = parseRawAddress(raw);
  return parsed && isIpv4Mapped(parsed)
    ? { family: 4, value: parsed.value - IPV4_MAPPED_PREFIX }
    : parsed;
};

const formatIpv4 = (value: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");

/** RFC 5952: lowercase, no leading zeros, the longest run of zero groups as `::`. */
const formatIpv6 = (value: bigint): string => {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn),
  );
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) {
      length += 1;
    }
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  const hex = (part: ReadonlyArray<number>): string =>
    part.map((group) => group.toString(16)).join(":");
  return bestStart < 0
    ? hex(groups)
    : `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
};

const bitsOf = (family: 4 | 6): number => (family === 4 ? IPV4_BITS : IPV6_BITS);

const maskOf = (family: 4 | 6, prefix: number): bigint => {
  const bits = BigInt(bitsOf(family));
  const all = (1n << bits) - 1n;
  return all ^ ((1n << (bits - BigInt(prefix))) - 1n);
};

export const IpRangeBrand = Symbol("IpRange");
const IpRangeSchema = z.string().brand<typeof IpRangeBrand>();

/**
 * A CIDR range in its canonical form: the network address (host bits
 * cleared) and the prefix length, `203.0.113.0/24` or `2001:db8::/32`. A bare
 * address is its own range (`/32`, `/128`), as Mastodon stores it.
 */
export type IpRange = z.infer<typeof IpRangeSchema>;

export type InvalidIpRange = Readonly<{ kind: "InvalidIpRange" }>;

/** A range ready to test addresses against. */
type CompiledRange = Readonly<{ family: 4 | 6; network: bigint; mask: bigint }>;

const compileRange = (range: IpRange): CompiledRange | undefined => {
  const [address = "", prefixText] = range.split("/");
  // A canonical range is already in its family (a mapped range was stored as IPv4).
  const parsed = parseRawAddress(address);
  if (!parsed) {
    return undefined;
  }
  const prefix = prefixText === undefined ? bitsOf(parsed.family) : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bitsOf(parsed.family)) {
    return undefined;
  }
  const mask = maskOf(parsed.family, prefix);
  return { family: parsed.family, network: parsed.value & mask, mask };
};

const rangeContains = (range: CompiledRange, address: IpAddress): boolean =>
  range.family === address.family && (address.value & range.mask) === range.network;

export const IpRange = {
  schema: IpRangeSchema,
  /**
   * A range as an admin types it: an address, or an address and a prefix
   * length. Host bits under the prefix are cleared (`10.1.2.3/8` is
   * `10.0.0.0/8`), as PostgreSQL's `inet` network renders it.
   */
  parse: (raw: string): Result<IpRange, InvalidIpRange> => {
    const [address = "", prefixText, extra] = raw.trim().split("/");
    if (extra !== undefined) {
      return err({ kind: "InvalidIpRange" });
    }
    const raw6 = parseRawAddress(address);
    if (!raw6 || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) {
      return err({ kind: "InvalidIpRange" });
    }
    const typedPrefix = prefixText === undefined ? bitsOf(raw6.family) : Number(prefixText);
    if (typedPrefix > bitsOf(raw6.family)) {
      return err({ kind: "InvalidIpRange" });
    }
    // An IPv4-mapped range (`::ffff:192.0.2.0/120`) is the IPv4 range it maps,
    // since addresses are matched in their IPv4 form.
    const mapped = isIpv4Mapped(raw6) && typedPrefix >= 96;
    const parsed: IpAddress = mapped ? { family: 4, value: raw6.value - IPV4_MAPPED_PREFIX } : raw6;
    const prefix = mapped ? typedPrefix - 96 : typedPrefix;
    const network = parsed.value & maskOf(parsed.family, prefix);
    const text = parsed.family === 4 ? formatIpv4(network) : formatIpv6(network);
    return ok(IpRangeSchema.parse(`${text}/${prefix}`));
  },
  /** Whether `address` (either family) falls in `range`; a malformed address is in none. */
  contains: (range: IpRange, address: string): boolean => {
    const compiled = compileRange(range);
    const parsed = parseAddress(address);
    return compiled !== undefined && parsed !== undefined && rangeContains(compiled, parsed);
  },
  /** Whether `raw` is an IPv4 or IPv6 address. */
  isAddress: (raw: string): boolean => parseAddress(raw) !== undefined,
  /**
   * The key rate limits count an address under, as Mastodon's
   * `throttleable_remote_ip` does: an IPv4 address (or the IPv4 address an
   * IPv4-mapped IPv6 address maps) is itself, an IPv6 address is its `/64`,
   * since one host is routinely handed a whole `/64`. A malformed address
   * has no key.
   */
  throttleKey: (raw: string): string | undefined => {
    const parsed = parseAddress(raw);
    if (parsed === undefined) {
      return undefined;
    }
    return parsed.family === 4
      ? formatIpv4(parsed.value)
      : `${formatIpv6(parsed.value & maskOf(6, 64))}/64`;
  },
} as const;

const SignUpRequiresApprovalSchema = z.object({ kind: z.literal("SignUpRequiresApproval") });
const SignUpBlockSchema = z.object({ kind: z.literal("SignUpBlock") });
const NoAccessSchema = z.object({ kind: z.literal("NoAccess") });

const IpBlockSeveritySchema = z.discriminatedUnion("kind", [
  SignUpRequiresApprovalSchema,
  SignUpBlockSchema,
  NoAccessSchema,
]);

export type IpBlockSeverity = z.infer<typeof IpBlockSeveritySchema>;

/** Mastodon's wire names for the severities. */
export type IpBlockSeverityName = "sign_up_requires_approval" | "sign_up_block" | "no_access";

const SEVERITY_BY_NAME = {
  sign_up_requires_approval: { kind: "SignUpRequiresApproval" },
  sign_up_block: { kind: "SignUpBlock" },
  no_access: { kind: "NoAccess" },
} as const satisfies Record<IpBlockSeverityName, IpBlockSeverity>;

const isSeverityName = (raw: string): raw is IpBlockSeverityName =>
  Object.hasOwn(SEVERITY_BY_NAME, raw);

export const IpBlockSeverity = {
  schema: IpBlockSeveritySchema,
  parse: schemaResult(IpBlockSeveritySchema),
  /** The severity a wire name (`sign_up_block`, ...) names, if any. */
  fromName: (raw: string): IpBlockSeverity | undefined =>
    isSeverityName(raw) ? SEVERITY_BY_NAME[raw] : undefined,
  toName: (severity: IpBlockSeverity): IpBlockSeverityName => {
    switch (severity.kind) {
      case "SignUpRequiresApproval":
        return "sign_up_requires_approval";
      case "SignUpBlock":
        return "sign_up_block";
      case "NoAccess":
        return "no_access";
    }
  },
} as const;

const PermanentSchema = z.object({ kind: z.literal("Permanent") });
const ExpiresSchema = z.object({ kind: z.literal("Expires"), at: z.iso.datetime() });
const IpBlockExpirySchema = z.discriminatedUnion("kind", [PermanentSchema, ExpiresSchema]);

export type IpBlockExpiry = z.infer<typeof IpBlockExpirySchema>;

const IpBlockSchema = z.object({
  id: z.string().min(1),
  range: IpRangeSchema,
  severity: IpBlockSeveritySchema,
  comment: z.string(),
  createdAt: z.iso.datetime(),
  expiry: IpBlockExpirySchema,
});

export type IpBlock = z.infer<typeof IpBlockSchema>;

/** What an address may do when it signs up. */
export type IpSignUpDecision =
  | Readonly<{ kind: "Open" }>
  | Readonly<{ kind: "RequiresApproval" }>
  | Readonly<{ kind: "Blocked" }>;

/** Whether an address may make requests at all. */
export type IpAccessDecision = Readonly<{ kind: "Allowed" }> | Readonly<{ kind: "Denied" }>;

const isActive = (expiry: IpBlockExpiry, nowMs: number): boolean =>
  expiry.kind === "Permanent" || Date.parse(expiry.at) > nowMs;

/** The blocks in force, compiled once so each request only compares integers. */
export type IpBlockList = ReadonlyArray<
  Readonly<{ range: CompiledRange; severity: IpBlockSeverity; expiry: IpBlockExpiry }>
>;

const matching = (list: IpBlockList, address: string, nowMs: number): IpBlockList => {
  const parsed = parseAddress(address);
  return parsed === undefined
    ? []
    : list.filter((entry) => isActive(entry.expiry, nowMs) && rangeContains(entry.range, parsed));
};

export const IpBlock = {
  schema: IpBlockSchema,
  parse: schemaResult(IpBlockSchema),
  /** Whether the block is still in force at `nowMs`. */
  isActive: (block: IpBlock, nowMs: number): boolean => isActive(block.expiry, nowMs),
  /** The expiry `expires_in` seconds after `nowMs`; none or a non-positive value is permanent. */
  expiryIn: (seconds: number | undefined, nowMs: number): IpBlockExpiry =>
    seconds === undefined || !Number.isFinite(seconds) || seconds <= 0
      ? { kind: "Permanent" }
      : { kind: "Expires", at: new Date(nowMs + Math.floor(seconds) * 1000).toISOString() },
  compile: (blocks: ReadonlyArray<IpBlock>): IpBlockList =>
    blocks.flatMap((block) => {
      const range = compileRange(block.range);
      return range ? [{ range, severity: block.severity, expiry: block.expiry }] : [];
    }),
  /** `no_access` refuses every request from the range (Mastodon's Rack::Attack blocklist). */
  access: (list: IpBlockList, address: string, nowMs: number): IpAccessDecision =>
    matching(list, address, nowMs).some((entry) => entry.severity.kind === "NoAccess")
      ? { kind: "Denied" }
      : { kind: "Allowed" },
  /**
   * A sign-up from `address`: refused under `sign_up_block` (or `no_access`),
   * held for approval under `sign_up_requires_approval`, otherwise open. The
   * strictest matching block wins.
   */
  signUp: (list: IpBlockList, address: string, nowMs: number): IpSignUpDecision => {
    const kinds = new Set(matching(list, address, nowMs).map((entry) => entry.severity.kind));
    if (kinds.has("SignUpBlock") || kinds.has("NoAccess")) {
      return { kind: "Blocked" };
    }
    return kinds.has("SignUpRequiresApproval") ? { kind: "RequiresApproval" } : { kind: "Open" };
  },
} as const;

/** Every IP block, expired or not. */
export type ListIpBlocks = () => Promise<Result<ReadonlyArray<IpBlock>, RepositoryError>>;
