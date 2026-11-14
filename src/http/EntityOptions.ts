import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { JSON_TREE_TAG_NAMES, type JsonTreeTagName } from '../serialization/Constants.js';

/**
 * How `entity()` decodes one request body — the shape behind its second
 * argument (#967).
 *
 * Per call rather than per server or in HOCON, because what a body may carry
 * is a property of the route that reads it: one route takes a `Date` from the
 * framework's own client, the route beside it takes form data from a browser.
 */
export type EntityOptionsType = {
  /**
   * The `JsonTree` tags a JSON body may use, by name — `['date', 'bytes']`.
   *
   * Empty, the default, decodes the body as plain JSON: a `{"__date__": …}`
   * reaches the handler as exactly that object.  Before #967 every tag was
   * honoured for every route, so the client — not the route — chose whether a
   * value arrived as a `RegExp`, a `bigint`, a `Map` or an `undefined`.
   *
   * A non-empty list switches the body to the tagged format, restricted to
   * those names: each listed tag constructs its class, `__literal__` unwraps,
   * and any other tag is refused with a 400 naming it rather than handed on as
   * data of a different class.  JSON bodies only; CBOR and form bodies ignore
   * it.
   */
  readonly tags?: readonly JsonTreeTagName[];
};

/**
 * Fluent builder for {@link EntityOptionsType}.
 *
 *     const entityOptions = EntityOptions.create().withTags(['date', 'bytes']);
 *     const order = entity<Order>(request, entityOptions);
 */
export class EntityOptionsBuilder extends OptionsBuilder<EntityOptionsType> {
  /** Start a fresh builder.  Equivalent to `new EntityOptionsBuilder()`. */
  static create(): EntityOptionsBuilder {
    return new EntityOptionsBuilder();
  }

  /** The `JsonTree` tags a JSON body may use.  Empty (the default) is plain JSON. */
  withTags(tags: readonly JsonTreeTagName[]): this {
    return this.set('tags', tags);
  }
}

/**
 * Validates resolved {@link EntityOptionsType} settings.  An unknown tag name
 * is the route's own typo, so it surfaces as an `OptionsError` — a server
 * fault — and never as the client's 400.
 */
export class EntityOptionsValidator extends OptionsValidator<EntityOptionsType> {
  constructor() {
    super('EntityOptions');
  }

  protected rules(s: Partial<EntityOptionsType>): void {
    const known: readonly string[] = JSON_TREE_TAG_NAMES;
    for (const tag of s.tags ?? []) {
      if (!known.includes(tag)) {
        this.fail('tags', `'${String(tag)}' is not a JsonTree tag name; expected one of ${known.join(', ')}`, tag);
      }
    }
  }
}

/**
 * Accepted input for `entity()`'s options: the fluent
 * {@link EntityOptionsBuilder} OR a plain {@link EntityOptionsType} object.
 */
export type EntityOptions = EntityOptionsBuilder | EntityOptionsType;
/** Value alias so `EntityOptions.create()` resolves to the builder. */
export const EntityOptions = EntityOptionsBuilder;
