/**
 * Minimal HOCON parser covering the subset of the format that is actually
 * useful for actor-ts configuration:
 *
 *   - Full JSON compatibility (HOCON is a superset of JSON).
 *   - Comments: `#` and `//` until end of line.
 *   - Unquoted keys (identifier chars).
 *   - `=` and `:` are interchangeable between key and value.
 *   - Commas between fields are optional — newlines work too.
 *   - Root braces are optional (implicit object).
 *   - Path expressions: `a.b.c = 1` expands to `a { b { c = 1 } }`.
 *   - Object merging: declaring the same key twice deep-merges objects
 *     and otherwise overwrites with the newer value.
 *   - Substitutions: `${foo.bar}` (required) and `${?foo.bar}` (optional).
 *     Resolved against the parsed tree first, then the environment.
 *
 * Features intentionally left out (rare in practice, can be added later):
 *   - Array and string concatenation (`a += [x]`, `"hi " ${name}`).
 *   - Triple-quoted multi-line strings.
 *   - `include` directives.
 */
import { match } from 'ts-pattern';

export type ConfigPrimitive = string | number | boolean | null;
export type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigObject | Substitution;
export type ConfigObject = { [key: string]: ConfigValue };

export interface Substitution {
  readonly __substitution: true;
  readonly path: string;
  readonly optional: boolean;
}

export function isSubstitution(value: unknown): value is Substitution {
  return typeof value === 'object' && value !== null && (value as Substitution).__substitution === true;
}

export function parseHocon(source: string): ConfigObject {
  const parser = new HoconParser(source);
  return parser.parseRoot();
}

/* ================================ Parser =================================== */

class HoconParser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) { this.src = src; }

  /** Entry point — allows both an explicit `{…}` root and an implicit one. */
  parseRoot(): ConfigObject {
    this.skipInsignificant();
    let result: ConfigObject;
    if (this.peekChar() === '{') {
      this.consumeChar('{');
      result = this.parseFields('}');
      this.expect('}');
    } else {
      result = this.parseFields(null);
    }
    this.skipInsignificant();
    if (this.pos < this.src.length) {
      throw this.error(`Unexpected trailing content: ${this.excerpt()}`);
    }
    return result;
  }

  /** Parse a sequence of `key = value` entries until the terminator. */
  private parseFields(terminator: '}' | null): ConfigObject {
    const out: ConfigObject = {};
    while (true) {
      this.skipInsignificant();
      if (this.isAtEnd()) {
        if (terminator !== null) throw this.error(`Expected '${terminator}' before end of input`);
        break;
      }
      if (terminator !== null && this.peekChar() === terminator) break;

      const keyPath = this.parseKeyPath();
      this.skipInsignificantInline();

      const char = this.peekChar();
      let value: ConfigValue;
      if (char === '=' || char === ':') {
        this.pos++;
        this.skipInsignificant();
        value = this.parseValue();
      } else if (char === '{') {
        // Key followed directly by an object literal — HOCON shorthand.
        value = this.parseValue();
      } else {
        throw this.error(`Expected '=' or ':' after key "${keyPath.join('.')}"`);
      }

      this.mergeKeyPath(out, keyPath, value);
      this.skipSeparator();
    }
    return out;
  }

  /** Parse a value. */
  private parseValue(): ConfigValue {
    this.skipInsignificant();
    const char = this.peekChar();
    if (char === undefined) throw this.error('Unexpected end of input in value');
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseQuotedString();
    if (char === '$' && this.src[this.pos + 1] === '{') return this.parseSubstitution();
    return this.parseLiteralOrUnquoted();
  }

  private parseObject(): ConfigObject {
    this.consumeChar('{');
    const body = this.parseFields('}');
    this.expect('}');
    return body;
  }

  private parseArray(): ConfigValue[] {
    this.consumeChar('[');
    const out: ConfigValue[] = [];
    while (true) {
      this.skipInsignificant();
      if (this.peekChar() === ']') { this.pos++; return out; }
      out.push(this.parseValue());
      this.skipSeparator();
      this.skipInsignificant();
      if (this.peekChar() === ']') { this.pos++; return out; }
    }
  }

  private parseQuotedString(): string {
    this.consumeChar('"');
    let result = '';
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === '"') { this.pos++; return result; }
      if (char === '\\') {
        this.pos++;
        const esc = this.src[this.pos]!;
        this.pos++;
        switch (esc) {
          case '"': result += '"'; break;
          case '\\': result += '\\'; break;
          case '/': result += '/'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error(`Invalid \\u escape: ${hex}`);
            result += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw this.error(`Invalid escape sequence: \\${esc}`);
        }
      } else if (char === '\n') {
        throw this.error('Unterminated string literal (newline)');
      } else {
        result += char; this.pos++;
      }
    }
    throw this.error('Unterminated string literal');
  }

  private parseSubstitution(): Substitution {
    this.consumeChar('$');
    this.consumeChar('{');
    const optional = this.peekChar() === '?';
    if (optional) this.pos++;
    let path = '';
    while (!this.isAtEnd() && this.src[this.pos] !== '}') {
      path += this.src[this.pos];
      this.pos++;
    }
    this.expect('}');
    path = path.trim();
    if (path === '') throw this.error('Empty substitution path');
    return { __substitution: true, path, optional };
  }

  /** Parse a literal (true/false/null/number) or an unquoted string. */
  private parseLiteralOrUnquoted(): ConfigValue {
    // Collect characters until a value terminator.
    const start = this.pos;
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === '\n' || char === ',' || char === '}' || char === ']' || char === '#') break;
      if (char === '/' && this.src[this.pos + 1] === '/') break;
      this.pos++;
    }
    const raw = this.src.slice(start, this.pos).trim();
    if (raw === '') throw this.error('Expected a value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
      const numberValue = Number(raw);
      if (Number.isFinite(numberValue)) return numberValue;
    }
    // Unquoted string — HOCON treats it literally.  Embedded substitutions
    // are only supported inside quoted strings for this minimal parser.
    return raw;
  }

  /** Parse a dotted key path like `foo.bar.baz`. */
  private parseKeyPath(): string[] {
    const segments: string[] = [];
    segments.push(this.parseKeySegment());
    while (this.peekChar() === '.') {
      this.pos++;
      segments.push(this.parseKeySegment());
    }
    return segments;
  }

  private parseKeySegment(): string {
    this.skipInsignificantInline();
    const char = this.peekChar();
    if (char === '"') return this.parseQuotedString();
    const start = this.pos;
    while (!this.isAtEnd()) {
      const ch = this.src[this.pos]!;
      if (/[A-Za-z0-9_\-]/.test(ch)) { this.pos++; continue; }
      break;
    }
    const seg = this.src.slice(start, this.pos);
    if (seg.length === 0) throw this.error('Expected a key');
    return seg;
  }

  /* -------------------------------- Helpers ------------------------------- */

  private mergeKeyPath(into: ConfigObject, path: string[], value: ConfigValue): void {
    if (path.length === 1) {
      const key = path[0]!;
      if (
        isPlainObject(into[key]) && isPlainObject(value)
      ) {
        into[key] = deepMerge(into[key] as ConfigObject, value as ConfigObject);
      } else {
        into[key] = value;
      }
      return;
    }
    const key = path[0]!;
    const child = isPlainObject(into[key]) ? (into[key] as ConfigObject) : {};
    into[key] = child;
    this.mergeKeyPath(child, path.slice(1), value);
  }

  private skipInsignificant(): void {
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { this.pos++; continue; }
      if (char === '#') { this.skipToEol(); continue; }
      if (char === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); continue; }
      break;
    }
  }

  /** Skip whitespace & comments but stop at newlines (for key-value boundary). */
  private skipInsignificantInline(): void {
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === ' ' || char === '\t' || char === '\r') { this.pos++; continue; }
      if (char === '#') { this.skipToEol(); continue; }
      if (char === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); continue; }
      break;
    }
  }

  private skipSeparator(): void {
    // Either a comma or a newline (or multiple).  We also absorb surrounding comments/ws.
    let consumed = false;
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === ',' || char === '\n') { this.pos++; consumed = true; continue; }
      if (char === ' ' || char === '\t' || char === '\r') { this.pos++; continue; }
      if (char === '#') { this.skipToEol(); consumed = true; continue; }
      if (char === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); consumed = true; continue; }
      break;
    }
    // Separator is optional inside arrays and at end — no throw.
    void consumed;
  }

  private skipToEol(): void {
    while (!this.isAtEnd() && this.src[this.pos] !== '\n') this.pos++;
  }

  private peekChar(): string | undefined { return this.src[this.pos]; }
  private consumeChar(char: string): void {
    if (this.src[this.pos] !== char) throw this.error(`Expected '${char}'`);
    this.pos++;
  }
  private expect(char: string): void { this.consumeChar(char); }
  private isAtEnd(): boolean { return this.pos >= this.src.length; }

  private error(message: string): Error {
    const lineStart = this.src.lastIndexOf('\n', this.pos - 1) + 1;
    const line = this.src.slice(0, this.pos).split('\n').length;
    const col = this.pos - lineStart + 1;
    return new Error(`HOCON parse error at line ${line}, col ${col}: ${message}`);
  }

  private excerpt(): string {
    return JSON.stringify(this.src.slice(this.pos, Math.min(this.pos + 30, this.src.length)));
  }
}

/* ========================= Substitution resolution ========================= */

export function resolveSubstitutions(
  obj: ConfigObject,
  env: Record<string, string | undefined> = getProcessEnv(),
): ConfigObject {
  let current = walk(obj, obj, env) as ConfigObject;
  // Second pass — some substitutions resolve to other substitutions.
  // Iterate to a fixed point.
  let prev = JSON.stringify(current);
  for (let i = 0; i < 8; i++) {
    const next = walk(current, current, env) as ConfigObject;
    const snap = JSON.stringify(next);
    if (snap === prev) return next;
    prev = snap;
    current = next;
  }
  return current;
}

function getProcessEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

function walk(
  node: ConfigValue,
  root: ConfigObject,
  env: Record<string, string | undefined>,
): ConfigValue {
  // Exhaustive over the ConfigValue shape.  Type-guard arms via
  // `.when()` because Substitution and plain-ConfigObject share the
  // `typeof === 'object'` family — the helpers know how to tell them
  // apart and we lean on them rather than reimplement the discriminator.
  return match(node)
    .when(isSubstitution, (sub) => resolveOne(sub, root, env))
    .when((value): value is ConfigValue[] => Array.isArray(value), (arr) => arr.map(value => walk(value, root, env)))
    .when(isPlainObject, (obj) => {
      const out: ConfigObject = {};
      for (const [key, value] of Object.entries(obj)) out[key] = walk(value, root, env);
      return out;
    })
    .otherwise((primitive) => primitive);
}

function resolveOne(
  sub: Substitution,
  root: ConfigObject,
  env: Record<string, string | undefined>,
): ConfigValue {
  const fromTree = lookup(root, sub.path);
  if (fromTree !== undefined) return fromTree as ConfigValue;
  // ENV variable name is the path with dots turned into underscores, uppercased.
  const envName1 = sub.path;
  const envName2 = sub.path.replace(/\./g, '_').toUpperCase();
  const fromEnv = env[envName1] ?? env[envName2];
  if (fromEnv !== undefined) {
    // Try to interpret as JSON first (so `${FOO}` can be a number/boolean/obj);
    // fall back to the raw string.
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed !== null && typeof parsed === 'object') return parsed as ConfigValue;
      return parsed as ConfigValue;
    } catch {
      return fromEnv;
    }
  }
  if (sub.optional) return undefined as unknown as ConfigValue;
  throw new Error(`Unresolved substitution: \${${sub.path}}`);
}

function lookup(obj: ConfigObject, path: string): ConfigValue | undefined {
  const parts = path.split('.');
  let cur: ConfigValue | undefined = obj;
  for (const part of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = (cur as ConfigObject)[part];
    if (cur === undefined) return undefined;
    if (isSubstitution(cur)) return undefined; // not resolved yet
  }
  return cur;
}

/* ================================ Utilities =============================== */

export function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isSubstitution(value);
}

/** Deep merge — values in `overlay` win, objects merge recursively, arrays overwrite. */
export function deepMerge(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as ConfigObject, value as ConfigObject);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Strip undefined values that originated from optional substitutions. */
export function stripUndefined(obj: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) out[key] = stripUndefined(value as ConfigObject);
    else if (Array.isArray(value)) out[key] = value.filter(x => x !== undefined) as ConfigValue[];
    else out[key] = value;
  }
  return out;
}
