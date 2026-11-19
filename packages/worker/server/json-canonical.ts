/**
 * JSON canonicalization (JCS, RFC 8785) as Mastodon computes it, with the
 * `json-canonicalization` gem's `to_json_c14n`: members sorted by their
 * UTF-16 code units, strings escaped as `JSON.generate` escapes them, and
 * numbers written from 16 significant digits (`"%.15E"`). That last part is
 * the gem's, not the RFC's: `0.30000000000000004` is written `0.3` and
 * `5e-324` as `4.940656458412465e-324`, so a signer that follows the RFC to
 * the letter fails to verify on Mastodon for such numbers, and here too.
 */

const canonicalNumber = (value: number): string => {
  if (value === 0 || !Number.isFinite(value)) {
    return "0";
  }
  const sign = value < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(value).toExponential(15).split("e");
  let exponent = Number(exponentText);
  const [whole = "", fraction = ""] = mantissa.split(".");
  let integral = whole;
  let fractional = fraction.replace(/0+$/, "");
  let exponential = "";
  if (exponent > 0 && exponent < 21) {
    while (exponent > 0) {
      integral += fractional[0] ?? "0";
      fractional = fractional.slice(1);
      exponent -= 1;
    }
  } else if (exponent < 0 && exponent > -7) {
    fractional = "0".repeat(-exponent - 1) + integral + fractional;
    integral = "0";
  } else if (exponent !== 0) {
    exponential = exponent > 0 ? `e+${exponent}` : `e${exponent}`;
  }
  return `${sign}${integral}${fractional === "" ? "" : `.${fractional}`}${exponential}`;
};

/** `to_json_c14n` of a parsed JSON value. */
export const canonicalJson = (value: unknown): string => {
  if (typeof value === "number") {
    return canonicalNumber(value);
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const members = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${members.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return "null";
};
