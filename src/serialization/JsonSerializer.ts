import { SerializationError, type Serializer } from './Serializer.js';
import { decodeJsonTree, encodeJsonTree } from './JsonTree.js';
import {
  defaultReadConstraintsOptions,
  ReadConstraintsOptionsValidator,
  type ReadConstraintsOptions,
  type ReadConstraintsOptionsType,
} from './ReadConstraintsOptions.js';

/**
 * JSON serializer — the default fallback.  Handles plain objects, arrays,
 * strings, numbers, booleans, `null`, and — via the shared tagged tree
 * walker in `JsonTree.ts` — `Date`, `Uint8Array`, `Map`, `Set`, `bigint`,
 * `NaN`/`Infinity`/`-0`, `RegExp`, `URL`, `Error` (name/message/cause, no
 * stack), and every typed array / `DataView` / `ArrayBuffer`.  `toJSON()`
 * is honoured, circular references are reported as `SerializationError`
 * instead of overflowing the stack, and user data that happens to look
 * like a tag round-trips via the `__literal__` escape.  Class identity for
 * custom user types is NOT preserved; the decoded value is a plain object.
 * Callers that need stronger typing should register a custom serializer
 * via `SerializationExtension`.
 */
export class JsonSerializer implements Serializer<unknown> {
  readonly id = 1;
  readonly name = 'json';
  readonly includesManifest = false;
  /** Ceilings applied to {@link fromBinary} — see `ReadConstraintsOptions`. */
  private readonly constraints: Required<ReadConstraintsOptionsType>;

  /**
   * Read constraints are optional and default to the built-ins, so every
   * `new JsonSerializer()` in the tree keeps working; `SerializationExtension`
   * is what hands over what config resolved to.
   */
  constructor(readConstraints: ReadConstraintsOptions = {}) {
    this.constraints = {
      ...defaultReadConstraintsOptions,
      ...(readConstraints as Partial<ReadConstraintsOptionsType>),
    };
    new ReadConstraintsOptionsValidator().validate(this.constraints);
  }

  manifest(_obj: unknown): string { return ''; }

  toBinary(obj: unknown): Uint8Array {
    let encoded: unknown;
    try { encoded = encodeJsonTree(obj); } catch (e) {
      throw new SerializationError(`JsonSerializer encode failed: ${(e as Error).message}`);
    }
    const json = JSON.stringify(encoded);
    if (json === undefined) {
      throw new SerializationError('JsonSerializer: value is not JSON-serializable');
    }
    return new TextEncoder().encode(json);
  }

  fromBinary(bytes: Uint8Array, _manifest: string): unknown {
    // Ahead of the decode, deliberately: the point of a document ceiling is to
    // refuse before the text and the parsed tree are both materialised.
    const ceiling = this.constraints.maxDocumentBytes;
    if (ceiling > 0 && bytes.byteLength > ceiling) {
      throw new SerializationError(
        `JsonSerializer: document of ${bytes.byteLength} bytes exceeds maxDocumentBytes ${ceiling}`,
      );
    }
    const text = new TextDecoder().decode(bytes);
    return decodeJsonTree(JSON.parse(text), { maxNestingDepth: this.constraints.maxNestingDepth });
  }
}
