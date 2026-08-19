import { type Extension, type ExtensionId, extensionId } from '../Extension.js';
import { CborSerializer } from './CborSerializer.js';
import { JsonSerializer } from './JsonSerializer.js';
import { SerializationError, type SerializedValue, type Serializer } from './Serializer.js';

type ClassConstructor = abstract new (...args: any[]) => unknown;

/**
 * Registry that resolves serializers by ID (at decode time) and by message
 * class (at encode time).  JSON (id=1) is the built-in fallback; CBOR
 * (id=2) is registered and available but used only when explicitly bound
 * to a class or asked for by ID.
 *
 * Reached as `system.extension(SerializationExtensionId)` — the id declared
 * below is what installs it, lazily and once per system, so nothing
 * constructs this class on an `ActorSystem`'s behalf.
 *
 * **A binding registered here reaches {@link SerializationExtension.encode}
 * and nothing else.**
 * Neither of the framework's own byte boundaries consults the registry: the
 * cluster wire frames a tagged JSON tree unconditionally (`cluster/Protocol.ts`),
 * and a persistence store takes a `Serializer` *instance* through its own
 * `withSerializer(...)` option (`persistence/storage/StoreSerializerOptions.ts`)
 * rather than looking one up by class.  So `bind(Order, 2)` changes what
 * `encode(order)` produces and changes nothing a peer or a journal row ever
 * sees.  Wiring bindings through to the wire is #450, and it waits on the
 * protocol negotiation of #823 — without one, adding a `serializerId` to the
 * frame is a second breaking wire change with no way to detect the mismatch.
 */
export class SerializationExtension implements Extension {
  private readonly byId = new Map<number, Serializer>();
  private readonly byClass = new Map<ClassConstructor, Serializer>();
  private _default: Serializer;

  constructor() {
    this._default = new JsonSerializer();
    this.register(this._default);
    this.register(new CborSerializer());
  }

  /** The serializer used for values with no explicit class binding.  Defaults to JSON. */
  get defaultSerializer(): Serializer { return this._default; }

  setDefault(serializer: Serializer): void {
    if (!this.byId.has(serializer.id)) this.register(serializer);
    this._default = serializer;
  }

  register(serializer: Serializer): void {
    const existing = this.byId.get(serializer.id);
    if (existing && existing !== serializer) {
      throw new SerializationError(
        `Serializer id ${serializer.id} already registered as "${existing.name}"`,
      );
    }
    this.byId.set(serializer.id, serializer);
  }

  /** Bind a message class to a specific serializer (by ID). */
  bind(cls: ClassConstructor, serializerId: number): void {
    const ser = this.byId.get(serializerId);
    if (!ser) throw new SerializationError(`No serializer registered with id ${serializerId}`);
    this.byClass.set(cls, ser);
  }

  /** Find a serializer by ID (used by decoders). */
  findById(id: number): Serializer | undefined {
    return this.byId.get(id);
  }

  /** Look up by ID or throw. */
  requireById(id: number): Serializer {
    const serializer = this.findById(id);
    if (!serializer) throw new SerializationError(`No serializer registered with id ${id}`);
    return serializer;
  }

  /**
   * Find the appropriate serializer for a value.  Lookup order:
   *   1. Exact constructor binding (`bind(Foo, 2)`).
   *   2. Walk the prototype chain for a bound ancestor.
   *   3. Default (JSON).
   */
  findFor(value: unknown): Serializer {
    if (value === null || value === undefined) return this._default;
    const proto = Object.getPrototypeOf(value) as object | null;
    const ctor = (proto as { constructor?: ClassConstructor })?.constructor;
    if (ctor) {
      const direct = this.byClass.get(ctor);
      if (direct) return direct;
      // Walk prototype chain.
      let walker: ClassConstructor | undefined = ctor;
      while (walker) {
        const found = this.byClass.get(walker);
        if (found) return found;
        const parent = Object.getPrototypeOf(walker) as ClassConstructor | null;
        walker = parent && parent !== Function.prototype ? parent : undefined;
      }
    }
    return this._default;
  }

  /* ------------------------- Convenience encode/decode ------------------------ */

  /** Encode a value using the resolved serializer; returns a tagged SerializedValue. */
  encode(value: unknown): SerializedValue {
    const ser = this.findFor(value);
    return {
      serializerId: ser.id,
      manifest: ser.manifest(value),
      bytes: ser.toBinary(value),
    };
  }

  /** Decode a SerializedValue using the serializer it names. */
  decode(sv: SerializedValue): unknown {
    const ser = this.requireById(sv.serializerId);
    return ser.fromBinary(sv.bytes, sv.manifest);
  }

  /** Snapshot registered serializer IDs — useful for diagnostics. */
  registeredIds(): number[] {
    return Array.from(this.byId.keys()).sort((a, b) => a - b);
  }
}

/** ExtensionId for the stock serialisation registry — install via `system.extension(...)`. */
export const SerializationExtensionId: ExtensionId<SerializationExtension> = extensionId(
  'SerializationExtension',
  (_system) => new SerializationExtension(),
);
