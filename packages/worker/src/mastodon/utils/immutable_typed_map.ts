import { Map as ImmutableMap } from 'immutable';

/**
 * An Immutable `Map` with a fixed set of string keys, each with its own value
 * type (`Fields`), as a reducer that predates Records keeps its state.
 *
 * At runtime it is a plain `Map` (JS components read it with `get` /
 * `getIn` / `toJS`); only its type is narrower: `get` returns the field's
 * type, and `set` / `update` / `merge` only take values of that type.
 * Immutable 4 has no such type (v5's `MapOf`), hence this one.
 */
export interface ImmutableTypedMap<Fields extends Record<string, unknown>> extends ImmutableMap<
  keyof Fields,
  Fields[keyof Fields]
> {
  get<K extends keyof Fields>(key: K): Fields[K];
  get<K extends keyof Fields, NSV>(
    key: K,
    notSetValue: NSV,
  ): Fields[K] | NSV;

  has(key: keyof Fields): boolean;

  set<K extends keyof Fields>(key: K, value: Fields[K]): this;

  update<K extends keyof Fields>(
    key: K,
    updater: (value: Fields[K]) => Fields[K],
  ): this;
  update<K extends keyof Fields>(
    key: K,
    notSetValue: Fields[K],
    updater: (value: Fields[K]) => Fields[K],
  ): this;
  update<R>(updater: (value: this) => R): R;

  merge(...collections: Partial<Fields>[]): this;
  merge<KC, VC>(
    ...collections: Iterable<[KC, VC]>[]
  ): ImmutableMap<keyof Fields | KC, Fields[keyof Fields] | VC>;
  merge<C>(
    ...collections: { [key: string]: C }[]
  ): ImmutableMap<keyof Fields | string, Fields[keyof Fields] | C>;

  withMutations(mutator: (mutable: this) => unknown): this;
}

/**
 * Builds an {@link ImmutableTypedMap} from its fields: the same `Map` that
 * `ImmutableMap(fields)` builds. The overload is what types it; the map holds
 * exactly the entries of `fields`, so its `get` types hold.
 */
export function immutableTypedMap<Fields extends Record<string, unknown>>(
  fields: Fields,
): ImmutableTypedMap<Fields>;
export function immutableTypedMap<Fields extends Record<string, unknown>>(
  fields: Fields,
): ImmutableMap<keyof Fields, Fields[keyof Fields]> {
  return ImmutableMap<keyof Fields & string, Fields[keyof Fields]>(fields);
}
