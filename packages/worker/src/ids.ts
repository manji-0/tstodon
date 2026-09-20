export const newEntityId = (): string => {
  const now = BigInt(Date.now());
  const bytes = crypto.getRandomValues(new Uint16Array(1));
  const rand = BigInt(bytes[0] ?? 0);
  return ((now << 16n) | rand).toString();
};
