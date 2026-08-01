/**
 * Minimal CBOR codec (RFC 8949 subset) used by `CborSerializer`.
 *
 * Supported major types:
 *   0 (unsigned int),
 *   1 (negative int),
 *   2 (byte string),
 *   3 (text string),
 *   4 (array),
 *   5 (map, with string keys),
 *   7 (simple values: false/true/null + double float).
 *
 * Additional-info values 0–27 are handled for every major type.  Indefinite-
 * length items and tagged items (major type 6) are NOT supported — the
 * target use case is actor message serialisation, not arbitrary CBOR
 * interop.  Dates and bigints are supported via semantic tagging (tag 1
 * and tag 2/3) on the encoder side; the decoder recognises them.
 */

export class CborEncodeError extends Error {
  constructor(message: string) { super(message); this.name = 'CborEncodeError'; }
}
export class CborDecodeError extends Error {
  constructor(message: string) { super(message); this.name = 'CborDecodeError'; }
}

const TAG_DATETIME = 0;      // RFC 8949: standard date/time string
const TAG_EPOCH_DATETIME = 1; // RFC 8949: epoch-based date/time
const TAG_UNSIGNED_BIGNUM = 2;
const TAG_NEGATIVE_BIGNUM = 3;

/* ================================ Encoder ================================= */

export class CborEncoder {
  private chunks: number[] = [];

  encode(value: unknown): Uint8Array {
    this.chunks = [];
    this.writeValue(value);
    return new Uint8Array(this.chunks);
  }

  private writeValue(value: unknown): void {
    if (value === null || value === undefined) return this.writeSimple(22); // null
    if (typeof value === 'boolean') return this.writeSimple(value ? 21 : 20);
    if (typeof value === 'number') {
      if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        return this.writeInt(value);
      }
      return this.writeDouble(value);
    }
    if (typeof value === 'bigint') return this.writeBigInt(value);
    if (typeof value === 'string') return this.writeString(value);
    if (value instanceof Uint8Array) return this.writeBytes(value);
    if (value instanceof Date) {
      this.writeTag(TAG_EPOCH_DATETIME);
      this.writeDouble(value.getTime() / 1000);
      return;
    }
    if (Array.isArray(value)) {
      this.writeHeader(4, value.length);
      for (const item of value) this.writeValue(item);
      return;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      this.writeHeader(5, entries.length);
      for (const [key, val] of entries) {
        this.writeString(key);
        this.writeValue(val);
      }
      return;
    }
    throw new CborEncodeError(`Cannot encode value of type ${typeof value}`);
  }

  private writeInt(value: number): void {
    if (value >= 0) this.writeHeader(0, value);
    else this.writeHeader(1, -value - 1);
  }

  private writeBigInt(value: bigint): void {
    // Use RFC 8949 bignum tags so the decoder can reconstruct a bigint.
    const positive = value >= 0n;
    const absVal = positive ? value : -value - 1n;
    this.writeTag(positive ? TAG_UNSIGNED_BIGNUM : TAG_NEGATIVE_BIGNUM);
    const bytes = bigIntToBytes(absVal);
    this.writeHeader(2, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeString(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.writeHeader(3, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeBytes(bytes: Uint8Array): void {
    this.writeHeader(2, bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
  }

  private writeTag(tag: number): void {
    this.writeHeader(6, tag);
  }

  private writeSimple(value: number): void {
    this.chunks.push((7 << 5) | value);
  }

  private writeDouble(value: number): void {
    this.chunks.push((7 << 5) | 27);
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, false);
    for (const byte of new Uint8Array(buffer)) this.chunks.push(byte);
  }

  private writeHeader(major: number, value: number): void {
    const mj = (major & 0x7) << 5;
    if (value < 24) {
      this.chunks.push(mj | value);
    } else if (value < 0x100) {
      this.chunks.push(mj | 24, value);
    } else if (value < 0x10000) {
      this.chunks.push(mj | 25, (value >>> 8) & 0xff, value & 0xff);
    } else if (value < 0x100000000) {
      this.chunks.push(
        mj | 26,
        (value >>> 24) & 0xff, (value >>> 16) & 0xff,
        (value >>> 8) & 0xff, value & 0xff,
      );
    } else {
      // Fall back to 8-byte form via BigInt math.
      this.chunks.push(mj | 27);
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, BigInt(value), false);
      for (let i = 0; i < 8; i++) this.chunks.push(view.getUint8(i));
    }
  }
}

/* ================================ Decoder ================================= */

export class CborDecoder {
  private pos = 0;
  private bytes!: Uint8Array;
  private view!: DataView;

  decode(bytes: Uint8Array): unknown {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    const value = this.readValue();
    if (this.pos !== bytes.byteLength) {
      throw new CborDecodeError(`Trailing CBOR bytes at offset ${this.pos}`);
    }
    return value;
  }

  private readValue(): unknown {
    if (this.pos >= this.bytes.byteLength) {
      throw new CborDecodeError(`Unexpected end of input at offset ${this.pos}`);
    }
    const ib = this.bytes[this.pos]!;
    const major = (ib >>> 5) & 0x7;
    const add = ib & 0x1f;
    this.pos++;

    // Major type 7 has its own additional-info interpretation (simple values
    // and floats).  Don't run it through `readLength`, which would consume
    // the float's own bytes as if they were a length prefix.
    if (major === 7) return this.readSimple(add);

    const len = this.readLength(add);

    switch (major) {
      case 0: return typeof len === 'bigint' ? len : Number(len);
      case 1: {
        const value = typeof len === 'bigint' ? -(len as bigint) - 1n : -Number(len) - 1;
        return value;
      }
      case 2: return this.readBytes(Number(len));
      case 3: return new TextDecoder().decode(this.readBytes(Number(len)));
      case 4: {
        const out: unknown[] = [];
        const count = Number(len);
        for (let i = 0; i < count; i++) out.push(this.readValue());
        return out;
      }
      case 5: {
        const out: Record<string, unknown> = {};
        const count = Number(len);
        for (let i = 0; i < count; i++) {
          const key = this.readValue();
          const value = this.readValue();
          if (typeof key !== 'string') {
            throw new CborDecodeError('Only string keys are supported in maps');
          }
          out[key] = value;
        }
        return out;
      }
      case 6: {
        const tag = Number(len);
        const inner = this.readValue();
        return this.applyTag(tag, inner);
      }
      default:
        throw new CborDecodeError(`Unknown major type ${major}`);
    }
  }

  private readLength(add: number): number | bigint {
    if (add < 24) return add;
    if (add === 24) return this.readUint(1);
    if (add === 25) return this.readUint(2);
    if (add === 26) return this.readUint(4);
    if (add === 27) return this.readUint(8);
    throw new CborDecodeError(`Unsupported additional info ${add}`);
  }

  private readUint(byteLen: number): number | bigint {
    if (this.pos + byteLen > this.bytes.byteLength) {
      throw new CborDecodeError(`Truncated input: need ${byteLen} bytes at offset ${this.pos}`);
    }
    let out = 0n;
    for (let i = 0; i < byteLen; i++) {
      out = (out << 8n) | BigInt(this.bytes[this.pos + i]!);
    }
    this.pos += byteLen;
    return out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : out;
  }

  private readBytes(count: number): Uint8Array {
    if (this.pos + count > this.bytes.byteLength) {
      throw new CborDecodeError(`Truncated input: need ${count} bytes at offset ${this.pos}`);
    }
    const out = this.bytes.slice(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  private readSimple(add: number): unknown {
    if (add === 20) return false;
    if (add === 21) return true;
    if (add === 22) return null;
    if (add === 23) return undefined;
    if (add === 25) return this.readHalfFloat();
    if (add === 26) {
      if (this.pos + 4 > this.bytes.byteLength) throw new CborDecodeError('Truncated float32');
      const value = this.view.getFloat32(this.pos, false);
      this.pos += 4;
      return value;
    }
    if (add === 27) {
      if (this.pos + 8 > this.bytes.byteLength) throw new CborDecodeError('Truncated float64');
      const value = this.view.getFloat64(this.pos, false);
      this.pos += 8;
      return value;
    }
    throw new CborDecodeError(`Unsupported simple value ${add}`);
  }

  private readHalfFloat(): number {
    if (this.pos + 2 > this.bytes.byteLength) throw new CborDecodeError('Truncated float16');
    const hi = this.bytes[this.pos]!, lo = this.bytes[this.pos + 1]!;
    this.pos += 2;
    const sign = (hi & 0x80) ? -1 : 1;
    const exp = (hi & 0x7c) >>> 2;
    const mant = ((hi & 0x03) << 8) | lo;
    if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
  }

  private applyTag(tag: number, inner: unknown): unknown {
    switch (tag) {
      case TAG_DATETIME:
        if (typeof inner === 'string') return new Date(inner);
        throw new CborDecodeError('Tag 0 expects a string');
      case TAG_EPOCH_DATETIME:
        if (typeof inner === 'number') return new Date(inner * 1000);
        throw new CborDecodeError('Tag 1 expects a number');
      case TAG_UNSIGNED_BIGNUM:
      case TAG_NEGATIVE_BIGNUM: {
        if (!(inner instanceof Uint8Array)) {
          throw new CborDecodeError(`Tag ${tag} expects a byte string`);
        }
        const magnitude = bytesToBigInt(inner);
        return tag === TAG_UNSIGNED_BIGNUM ? magnitude : -1n - magnitude;
      }
      default:
        // Unknown tag — pass the inner value through.
        return inner;
    }
  }
}

/* --------------------------- BigInt ↔ bytes utilities ---------------------- */

function bigIntToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  return new Uint8Array(bytes.reverse());
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
