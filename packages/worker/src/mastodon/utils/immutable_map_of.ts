import { Map as ImmutableMap, fromJS } from 'immutable';
import type { List as ImmutableList } from 'immutable';

/**
 * An Immutable `Map` whose keys are the fields of `T`, each with its own value
 * type: `get('saved')` is a `boolean` where a plain `Map<string, unknown>`
 * gives `unknown`. It only types a Map at compile time: the runtime value is
 * an ordinary `Immutable.Map` (not a `Record`), so JavaScript code keeps
 * reading it with `.get` / `.getIn` / `.toJS` as before.
 *
 * Immutable 4 has no such type (Immutable 5's `MapOf` is the same idea).
 * `getIn` and `setIn` stay untyped (`unknown`): read nested fields with
 * chained `get`s.
 */
export interface ImmutableMapOf<T extends object>
  extends ImmutableMap<keyof T & string, T[keyof T]> {
  get<K extends keyof T & string>(key: K): T[K];
  get<K extends keyof T & string, NSV>(
    key: K,
    notSetValue: NSV,
  ): Exclude<T[K], undefined> | NSV;
  set<K extends keyof T & string>(key: K, value: T[K]): this;
  update<K extends keyof T & string>(
    key: K,
    notSetValue: Exclude<T[K], undefined>,
    updater: (value: Exclude<T[K], undefined>) => T[K],
  ): this;
  update<K extends keyof T & string>(
    key: K,
    updater: (value: T[K]) => T[K],
  ): this;
  update<R>(updater: (value: this) => R): R;
  /**
   * Merging some of the fields keeps the type (an iterable's keys and values
   * are checked separately, not as pairs).
   */
  merge(
    ...collections: (Partial<T> | Iterable<[keyof T & string, T[keyof T]]>)[]
  ): this;
  merge<KC, VC>(
    ...collections: Iterable<[KC, VC]>[]
  ): ImmutableMap<(keyof T & string) | KC, T[keyof T] | VC>;
  merge<C>(
    ...collections: { [key: string]: C }[]
  ): ImmutableMap<string, T[keyof T] | C>;
}

/**
 * The plain value `toJS()` makes of an Immutable value: `ImmutableMapOf`s
 * become objects and `List`s arrays, recursively.
 */
export type PlainOf<V> =
  V extends ImmutableMapOf<infer T>
    ? { [K in keyof T]: PlainOf<T[K]> }
    : V extends ImmutableList<infer E>
      ? PlainOf<E>[]
      : V;

/**
 * The Immutable value `fromJS` makes of the JSON value `T`: arrays become
 * `List`s and objects `ImmutableMapOf`s, recursively.
 */
export type ImmutableOf<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? T
  : T extends readonly (infer E)[]
    ? ImmutableList<ImmutableOf<E>>
    : T extends object
      ? ImmutableMapOf<{ [K in keyof T]: ImmutableOf<T[K]> }>
      : T;

/**
 * `ImmutableMap(fields)`, typed by its fields. This, `immutableFromJS` and
 * `immutableToJS` are where these types meet Immutable's own (looser)
 * typings: they say what the Map holds, which Immutable 4's cannot. They do
 * nothing more than the Immutable function they call.
 */
export function immutableMapOf<T extends object>(fields: T): ImmutableMapOf<T>;
export function immutableMapOf(fields: object): unknown {
  return ImmutableMap(fields);
}

/** `value.toJS()`, typed as the plain value it makes. */
export function immutableToJS<T extends object>(
  value: ImmutableMapOf<T>,
): PlainOf<ImmutableMapOf<T>>;
export function immutableToJS<E>(value: ImmutableList<E>): PlainOf<E>[];
export function immutableToJS(value: {
  toJS: () => unknown;
}): unknown {
  return value.toJS();
}

/** `fromJS(value)`, typed as the Immutable value it makes. */
export function immutableFromJS<T>(value: T): ImmutableOf<T>;
export function immutableFromJS(value: unknown): unknown {
  return fromJS(value);
}
