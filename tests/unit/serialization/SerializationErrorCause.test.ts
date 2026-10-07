import { describe, expect, test } from 'bun:test';
import { SerializationError } from '../../../src/serialization/Serializer.js';

// The JSON decode paths wrap the engine's own `SyntaxError` (#1449).  The
// message names the parse failure; the cause keeps the original error, with
// its type and stack, for whoever prints the chain.
describe('SerializationError — cause', () => {
  test('carries the cause it is given', () => {
    const syntaxError = new SyntaxError('Unexpected end of JSON input');
    const error = new SerializationError('document is not valid JSON', { cause: syntaxError });
    expect(error.cause).toBe(syntaxError);
    expect(error.message).toBe('document is not valid JSON');
    expect(error.name).toBe('SerializationError');
    expect(error).toBeInstanceOf(Error);
  });

  test('without options it has no cause property at all', () => {
    const error = new SerializationError('plain');
    expect('cause' in error).toBe(false);
  });
});
