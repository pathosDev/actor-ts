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

export function isSubstitution(v: unknown): v is Substitution {
  return typeof v === 'object' && v !== null && (v as Substitution).__substitution === true;
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

      const c = this.peekChar();
      let value: ConfigValue;
      if (c === '=' || c === ':') {
        this.pos++;
        this.skipInsignificant();
        value = this.parseValue();
      } else if (c === '{') {
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
    const c = this.peekChar();
    if (c === undefined) throw this.error('Unexpected end of input in value');
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"') return this.parseQuotedString();
    if (c === '$' && this.src[this.pos + 1] === '{') return this.parseSubstitution();
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
    let s = '';
    while (!this.isAtEnd()) {
      const c = this.src[this.pos]!;
      if (c === '"') { this.pos++; return s; }
      if (c === '\\') {
        this.pos++;
        const esc = this.src[this.pos]!;
        this.pos++;
        switch (esc) {
          case '"': s += '"'; break;
          case '\\': s += '\\'; break;
          case '/': s += '/'; break;
          case 'b': s += '\b'; break;
          case 'f': s += '\f'; break;
          case 'n': s += '\n'; break;
          case 'r': s += '\r'; break;
          case 't': s += '\t'; break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error(`Invalid \\u escape: ${hex}`);
            s += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw this.error(`Invalid escape sequence: \\${esc}`);
        }
      } else if (c === '\n') {
        throw this.error('Unterminated string literal (newline)');
      } else {
        s += c; this.pos++;
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
      const c = this.src[this.pos]!;
      if (c === '\n' || c === ',' || c === '}' || c === ']' || c === '#') break;
      if (c === '/' && this.src[this.pos + 1] === '/') break;
      this.pos++;
    }
    const raw = this.src.slice(start, this.pos).trim();
    if (raw === '') throw this.error('Expected a value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
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
    const c = this.peekChar();
    if (c === '"') return this.parseQuotedString();
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
      const k = path[0]!;
      if (
        isPlainObject(into[k]) && isPlainObject(value)
      ) {
        into[k] = deepMerge(into[k] as ConfigObject, value as ConfigObject);
      } else {
        into[k] = value;
      }
      return;
    }
    const k = path[0]!;
    const child = isPlainObject(into[k]) ? (into[k] as ConfigObject) : {};
    into[k] = child;
    this.mergeKeyPath(child, path.slice(1), value);
  }

  private skipInsignificant(): void {
    while (!this.isAtEnd()) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.pos++; continue; }
      if (c === '#') { this.skipToEol(); continue; }
      if (c === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); continue; }
      break;
    }
  }

  /** Skip whitespace & comments but stop at newlines (for key-value boundary). */
  private skipInsignificantInline(): void {
    while (!this.isAtEnd()) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\r') { this.pos++; continue; }
      if (c === '#') { this.skipToEol(); continue; }
      if (c === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); continue; }
      break;
    }
  }

  private skipSeparator(): void {
    // Either a comma or a newline (or multiple).  We also absorb surrounding comments/ws.
    let consumed = false;
    while (!this.isAtEnd()) {
      const c = this.src[this.pos]!;
      if (c === ',' || c === '\n') { this.pos++; consumed = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { this.pos++; continue; }
      if (c === '#') { this.skipToEol(); consumed = true; continue; }
      if (c === '/' && this.src[this.pos + 1] === '/') { this.skipToEol(); consumed = true; continue; }
      break;
    }
    // Separator is optional inside arrays and at end — no throw.
    void consumed;
  }

  private skipToEol(): void {
    while (!this.isAtEnd() && this.src[this.pos] !== '\n') this.pos++;
  }

  private peekChar(): string | undefined { return this.src[this.pos]; }
  private consumeChar(c: string): void {
    if (this.src[this.pos] !== c) throw this.error(`Expected '${c}'`);
    this.pos++;
  }
  private expect(c: string): void { this.consumeChar(c); }
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
    .when((v): v is ConfigValue[] => Array.isArray(v), (arr) => arr.map(v => walk(v, root, env)))
    .when(isPlainObject, (obj) => {
      const out: ConfigObject = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, root, env);
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
  for (const p of parts) {
    if (!isPlainObject(cur)) return undefined;
    cur = (cur as ConfigObject)[p];
    if (cur === undefined) return undefined;
    if (isSubstitution(cur)) return undefined; // not resolved yet
  }
  return cur;
}

/* ================================ Utilities =============================== */

export function isPlainObject(v: unknown): v is ConfigObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isSubstitution(v);
}

/** Deep merge — values in `overlay` win, objects merge recursively, arrays overwrite. */
export function deepMerge(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as ConfigObject, v as ConfigObject);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Strip undefined values that originated from optional substitutions. */
export function stripUndefined(obj: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (isPlainObject(v)) out[k] = stripUndefined(v as ConfigObject);
    else if (Array.isArray(v)) out[k] = v.filter(x => x !== undefined) as ConfigValue[];
    else out[k] = v;
  }
  return out;
}
