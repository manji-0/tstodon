export const HEIGHT_CACHE_SET = 'HEIGHT_CACHE_SET' as const;
export const HEIGHT_CACHE_CLEAR = 'HEIGHT_CACHE_CLEAR' as const;

export function setHeight (key: string, id: string, height: number) {
  return {
    type: HEIGHT_CACHE_SET,
    key,
    id,
    height,
  };
}

export function clearHeight () {
  return {
    type: HEIGHT_CACHE_CLEAR,
  };
}
