import { describe, expect, test } from 'bun:test';
import { decodePayload, encodePayload } from '../../../src/persistence/storage/PayloadCodec.js';
import { CborSerializer } from '../../../src/serialization/CborSerializer.js';
import { JsonSerializer } from '../../../src/serialization/JsonSerializer.js';
import { rebuildError } from '../../../src/serialization/RichTypes.js';

/**
 * An error's class is chosen by looking its wire `name` up in a table of the
 * built-in error classes, and that name is whatever the bytes say.  The table
 * is an object literal, so a plain index also answers for every member of
 * `Object.prototype`: `toString` resolved to a function that is not a
 * constructor and the decode threw a raw `TypeError`, `constructor` resolved to
 * `Object` and decoded to a `String` wrapper, and an `Error` someone had named
 * `valueOf` encoded fine and then could not be read back (#1449).
 *
 * The rule these names get is the one every other name outside the table
 * already had: a plain `Error` that keeps the name.  Refusing them instead
 * would leave the codec unable to read its own output — the encoder accepts an
 * error by any name — so a journal that stored one would fail on every replay.
 *
 * The list is literal so a runtime cannot shrink it, and the first test holds
 * it to the runtime's own `Object.prototype` so it cannot fall behind either.
 */
const OBJECT_PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const;

const BUILT_IN_ERROR_CLASSES = [
  ['Error', Error],
  ['TypeError', TypeError],
  ['RangeError', RangeError],
  ['SyntaxError', SyntaxError],
  ['ReferenceError', ReferenceError],
  ['EvalError', EvalError],
  ['URIError', URIError],
] as const;

/** A plain `Error` — not a subclass, not a wrapper object — carrying exactly this name and message. */
function expectPlainError(value: unknown, name: string, message: string): void {
  expect(value).toBeInstanceOf(Error);
  expect(Object.getPrototypeOf(value)).toBe(Error.prototype);
  expect((value as Error).name).toBe(name);
  expect((value as Error).message).toBe(message);
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('the fixture', () => {
  test('names every own member of Object.prototype on this runtime', () => {
    for (const member of Object.getOwnPropertyNames(Object.prototype)) {
      expect(OBJECT_PROTOTYPE_NAMES as readonly string[]).toContain(member);
    }
  });
});

describe('rebuildError — a name that only Object.prototype answers for', () => {
  for (const name of OBJECT_PROTOTYPE_NAMES) {
    test(`'${name}' rebuilds a plain Error that keeps the name`, () => {
      expectPlainError(rebuildError(name, 'boom', undefined), name, 'boom');
    });
  }

  test('the same names in another case are ordinary unknown names too', () => {
    for (const name of ['Constructor', 'TOSTRING', '__PROTO__']) {
      expectPlainError(rebuildError(name, 'boom', undefined), name, 'boom');
    }
  });

  test('every built-in class still rebuilds as itself', () => {
    for (const [name, errorClass] of BUILT_IN_ERROR_CLASSES) {
      const rebuilt = rebuildError(name, 'boom', undefined);
      expect(Object.getPrototypeOf(rebuilt)).toBe(errorClass.prototype);
      expect(rebuilt.name).toBe(name);
      expect(rebuilt.message).toBe('boom');
    }
  });

  test('a name outside the table and off the prototype falls back as it always did', () => {
    expectPlainError(rebuildError('PaymentDeclinedError', 'boom', undefined), 'PaymentDeclinedError', 'boom');
  });
});

describe('every decoder that rebuilds an error reads back an error named after an Object.prototype member', () => {
  const json = new JsonSerializer();
  const cbor = new CborSerializer();

  for (const name of OBJECT_PROTOTYPE_NAMES) {
    test(`'${name}' round-trips through JSON, CBOR and a stored payload`, () => {
      const original = namedError(name, 'boom');
      expectPlainError(json.fromBinary(json.toBinary(original), ''), name, 'boom');
      expectPlainError(cbor.fromBinary(cbor.toBinary(original), ''), name, 'boom');
      expectPlainError(decodePayload(encodePayload(original)), name, 'boom');
    });
  }
});
