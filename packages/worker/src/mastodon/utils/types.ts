import type { SetOptional } from 'type-fest';

export type RequiredExcept<T, K extends keyof T> = SetOptional<Required<T>, K>;

export type AnyFunction = (...args: never) => unknown;

/**
 * The action a plain action creator returns, with its `type` as the literal
 * `Type`: the creator's own return type widens a constant `type` to `string`.
 */
export type PlainActionOf<
  Type extends string,
  Creator extends (...args: never[]) => { type: string },
> = Omit<ReturnType<Creator>, 'type'> & { type: Type };
