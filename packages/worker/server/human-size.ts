const UNITS = ["KB", "MB", "GB", "TB", "PB", "EB"] as const;

/**
 * A byte count as Rails' `number_to_human_size` writes it, which Mastodon's
 * admin metrics and export page use: binary units, three significant digits
 * without trailing zeros ("0 Bytes", "1 Byte", "512 Bytes", "1 KB",
 * "1.18 MB", "118 MB").
 */
export const humanSize = (bytes: number): string => {
  const whole = Math.max(0, Math.round(bytes));
  if (whole < 1024) {
    return whole === 1 ? "1 Byte" : `${whole} Bytes`;
  }
  let value = whole;
  let unit = -1;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toPrecision(3))} ${UNITS[unit] ?? "EB"}`;
};
