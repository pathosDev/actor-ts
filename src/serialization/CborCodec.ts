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
  constructor(m: string) { super(m); this.name = 'CborEncodeError'; }
}
export class CborDecodeError extends Error {
  constructor(m: string) { super(m); this.name = 'CborDecodeError'; }
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

  private writeValue(v: unknown): void {
    if (v === null || v === undefined) return this.writeSimple(22); // null
    if (typeof v === 'boolean') return this.writeSimple(v ? 21 : 20);
    if (typeof v === 'number') {
      if (Number.isFinite(v) && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        return this.writeInt(v);
      }
      return this.writeDouble(v);
    }
    if (typeof v === 'bigint') return this.writeBigInt(v);
    if (typeof v === 'string') return this.writeString(v);
    if (v instanceof Uint8Array) return this.writeBytes(v);
    if (v instanceof Date) {
      this.writeTag(TAG_EPOCH_DATETIME);
      this.writeDouble(v.getTime() / 1000);
      return;
    }
    if (Array.isArray(v)) {
      this.writeHeader(4, v.length);
      for (const item of v) this.writeValue(item);
      return;
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      this.writeHeader(5, entries.length);
      for (const [k, val] of entries) {
        this.writeString(k);
        this.writeValue(val);
      }
      return;
    }
    throw new CborEncodeError(`Cannot encode value of type ${typeof v}`);
  }

  private writeInt(n: number): void {
    if (n >= 0) this.writeHeader(0, n);
    else this.writeHeader(1, -n - 1);
  }

  private writeBigInt(n: bigint): void {
    // Use RFC 8949 bignum tags so the decoder can reconstruct a bigint.
    const positive = n >= 0n;
    const absVal = positive ? n : -n - 1n;
    this.writeTag(positive ? TAG_UNSIGNED_BIGNUM : TAG_NEGATIVE_BIGNUM);
    const bytes = bigIntToBytes(absVal);
    this.writeHeader(2, bytes.length);
    for (const b of bytes) this.chunks.push(b);
  }

  private writeString(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.writeHeader(3, bytes.length);
    for (const b of bytes) this.chunks.push(b);
  }

  private writeBytes(b: Uint8Array): void {
    this.writeHeader(2, b.length);
    for (const x of b) this.chunks.push(x);
  }

  private writeTag(tag: number): void {
    this.writeHeader(6, tag);
  }

  private writeSimple(v: number): void {
    this.chunks.push((7 << 5) | v);
  }

  private writeDouble(n: number): void {
    this.chunks.push((7 << 5) | 27);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    for (const b of new Uint8Array(buf)) this.chunks.push(b);
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
    const v = this.readValue();
    if (this.pos !== bytes.byteLength) {
      throw new CborDecodeError(`Trailing CBOR bytes at offset ${this.pos}`);
    }
    return v;
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
        const v = typeof len === 'bigint' ? -(len as bigint) - 1n : -Number(len) - 1;
        return v;
      }
      case 2: return this.readBytes(Number(len));
      case 3: return new TextDecoder().decode(this.readBytes(Number(len)));
      case 4: {
        const out: unknown[] = [];
        const n = Number(len);
        for (let i = 0; i < n; i++) out.push(this.readValue());
        return out;
      }
      case 5: {
        const out: Record<string, unknown> = {};
        const n = Number(len);
        for (let i = 0; i < n; i++) {
          const k = this.readValue();
          const v = this.readValue();
          if (typeof k !== 'string') {
            throw new CborDecodeError('Only string keys are supported in maps');
          }
          out[k] = v;
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

  private readBytes(n: number): Uint8Array {
    if (this.pos + n > this.bytes.byteLength) {
      throw new CborDecodeError(`Truncated input: need ${n} bytes at offset ${this.pos}`);
    }
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
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
      const v = this.view.getFloat32(this.pos, false);
      this.pos += 4;
      return v;
    }
    if (add === 27) {
      if (this.pos + 8 > this.bytes.byteLength) throw new CborDecodeError('Truncated float64');
      const v = this.view.getFloat64(this.pos, false);
      this.pos += 8;
      return v;
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
        const n = bytesToBigInt(inner);
        return tag === TAG_UNSIGNED_BIGNUM ? n : -1n - n;
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
  let v = n;
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(bytes.reverse());
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
