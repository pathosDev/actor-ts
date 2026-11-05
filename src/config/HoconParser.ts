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
 *     and otherwise overwrites with the newer value — except that an
 *     optional substitution which resolves to nothing leaves the earlier
 *     value in place (`port = 2552` then `port = ${?PORT}`), as the
 *     specification requires.
 *   - Substitutions: `${foo.bar}` (required) and `${?foo.bar}` (optional).
 *     Resolved against the parsed tree first, then the environment.
 *
 * Features intentionally left out (rare in practice, can be added later):
 *   - Array and string concatenation (`a += [x]`, `"hi " ${name}`).
 *   - Triple-quoted multi-line strings.
 *
 * `include` is a different case from those two: it is not merely unimplemented
 * but deliberately refused, and it says so — see `includeNotSupported`.  Compose
 * several sources in code instead, with `Config.parseFile(…).merge(…)`.
 */
import { match } from 'ts-pattern';

export type ConfigPrimitive = string | number | boolean | null;
export type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigObject | Substitution;
export type ConfigObject = { [key: string]: ConfigValue };

export type Substitution = {
  readonly __substitution: true;
  readonly path: string;
  readonly optional: boolean;
  /**
   * The value this assignment replaced in the same source, when there was
   * one.  Only ever set on an optional substitution: it is what the key
   * falls back to when neither the tree nor the environment answers, so
   * `port = 2552` followed by `port = ${?PORT}` keeps the `2552` — the
   * specification's rule for an undefined `${?x}` that would have
   * overridden an earlier value.  A required substitution either resolves
   * or throws, so it never needs one.
   */
  readonly previous?: ConfigValue;
};

export function isSubstitution(value: unknown): value is Substitution {
  return typeof value === 'object' && value !== null && (value as Substitution).__substitution === true;
}

/**
 * Keys a config source may never read or write.
 *
 * `__proto__` is the dangerous one.  `object[key] = value` invokes the
 * inherited `__proto__` setter instead of creating an own property, so the
 * key path `__proto__.polluted = true` descends into `Object.prototype` and
 * pollutes every object in the process — while the parsed config still looks
 * empty, which is what makes it easy to miss.  A single-segment
 * `"__proto__" { … }` is the milder variant: it replaces the prototype of the
 * config object itself.
 *
 * `constructor` and `prototype` are not exploitable through this parser today
 * — `isPlainObject` rejects the function they resolve to, so a path
 * expression builds a fresh object rather than reaching the real prototype —
 * but they are refused too.  The check costs nothing, and that accident is
 * not a property worth depending on across future refactors.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` must never reach a config object, as either a read or a write. */
export function isForbiddenConfigKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
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
      } else if (keyPath.length === 1 && keyPath[0] === 'include') {
        // Reaching here means `include` was followed by neither `=`/`:` nor `{`,
        // which is exactly the directive position — and only that position, so
        // `app { include = "x" }` and `include { a = 1 }` stay ordinary keys and
        // need no top-level restriction.
        throw this.includeNotSupported();
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
    // A substitution is a read, but `${__proto__}` would still splice the
    // prototype object into the resolved config, so it is refused here as
    // well.  `lookup` repeats the check for paths built programmatically.
    if (path.split('.').some(isForbiddenConfigKey)) {
      throw this.error(`Refusing the substitution \${${path}} — it would read through the object prototype`);
    }
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

  /**
   * The single chokepoint for every field key, quoted or bare, at every
   * position in a path expression — which is why the prototype guard lives
   * here rather than at the assignment in `mergeKeyPath`.
   */
  private parseKeySegment(): string {
    this.skipInsignificantInline();
    const segment = this.peekChar() === '"' ? this.parseQuotedString() : this.parseBareKeySegment();
    if (isForbiddenConfigKey(segment)) {
      throw this.error(`Refusing "${segment}" as a config key — it would reach the object prototype`);
    }
    return segment;
  }

  private parseBareKeySegment(): string {
    const start = this.pos;
    while (!this.isAtEnd()) {
      const ch = this.src[this.pos]!;
      if (/[A-Za-z0-9_\-]/.test(ch)) { this.pos++; continue; }
      break;
    }
    const segment = this.src.slice(start, this.pos);
    if (segment.length === 0) throw this.error('Expected a key');
    return segment;
  }

  /* -------------------------------- Helpers ------------------------------- */

  /**
   * Writes `value` at `path`, creating intermediate objects as it descends.
   * Every segment reaching here has passed `parseKeySegment`'s prototype
   * guard, which is why the plain `into[key] = …` assignments below are safe.
   * The value a key already holds is read with {@link ownValue}, for the
   * reason given there.
   */
  private mergeKeyPath(into: ConfigObject, path: string[], value: ConfigValue): void {
    const key = path[0]!;
    const existing = ownValue(into, key);
    if (path.length === 1) {
      if (
        isPlainObject(existing) && isPlainObject(value)
      ) {
        into[key] = deepMerge(existing, value);
      } else {
        into[key] = overrideKeepingPrevious(existing, value);
      }
      return;
    }
    const child = isPlainObject(existing) ? existing : {};
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

  /**
   * `include` gets its own refusal rather than the loop's generic
   * `Expected '=' or ':'`, which names the keyword but not the reason — and so
   * sends anyone porting an Akka or Pekko `application.conf` hunting through
   * this file for the answer.
   *
   * The refusal is a decision, not a gap.  Resolving an include lets a config
   * source name the next file to read, relative to a root the parser has no
   * way to know, so whoever can write the config chooses which paths and URLs
   * get pulled into the process.  Merging the sources in code leaves that
   * choice with the caller, where it belongs.
   */
  private includeNotSupported(): Error {
    const target = this.peekIncludeTarget();
    const directive = target === null ? '`include`' : `\`include ${JSON.stringify(target)}\``;
    // The suggestion names the real target so it can be pasted as-is — except
    // for `url(…)`, the one form `parseFile` cannot honour.  Advice that fails
    // when followed is the very thing this message exists to stop.
    const base = target !== null && !target.includes('://') ? JSON.stringify(target) : '"base.conf"';
    // The caveat is part of the advice, not a footnote: substitutions resolve
    // when each file is parsed, so the merge is only equivalent to an include
    // while the base file refers to nothing that only the other file defines
    // (#1071).
    return this.error(
      `${directive} is not supported — actor-ts resolves no include targets, so a config `
      + 'source can never name another file or URL to pull into the process. Merge the '
      + `sources in code instead: Config.parseFile(${base}).merge(Config.parseFile`
      + '("application.conf")). Substitutions resolve per source, so a value the base '
      + 'file refers to must live in that file or in the environment. Pasting the '
      + 'included content in here works too.',
    );
  }

  /**
   * Best-effort echo of what was being included, so the message quotes a line
   * the reader recognises.  Every include form wraps its target in double
   * quotes — `"x.conf"`, `file("x.conf")`, `required(url("…"))` — so the first
   * quoted run on the line is it.  `null` when there is none, or when it is
   * long enough that repeating it would bury the rest of the message.
   */
  private peekIncludeTarget(): string | null {
    const lineEnd = this.src.indexOf('\n', this.pos);
    const line = this.src.slice(this.pos, lineEnd < 0 ? this.src.length : lineEnd);
    const opening = line.indexOf('"');
    if (opening < 0) return null;
    const closing = line.indexOf('"', opening + 1);
    if (closing < 0) return null;
    const target = line.slice(opening + 1, closing);
    return target === '' || target.length > 200 ? null : target;
  }

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

/**
 * Resolve every substitution in `obj` — against the tree first, then the
 * environment.  An optional substitution that finds neither leaves its key
 * out, or falls back to the value its assignment replaced.
 *
 * Resolution is by demand rather than by pass: a substitution whose target is
 * itself a substitution resolves that target first, so a chain resolves in any
 * declaration order (#1748).  The fixed-point loop this replaced re-walked the
 * whole tree up to eight times and still could not follow a chain — the
 * lookup met the unresolved target and reported a miss, so the required form
 * threw and the optional form fell through to the environment, or dropped the
 * key.  A chain that leads back to itself is a cycle, and refused as one.
 *
 * What a substitution resolves to is final.  A value read from the environment
 * is data from then on: nothing walks it again, so nothing inside it is
 * resolved as config.
 */
export function resolveSubstitutions(
  obj: ConfigObject,
  env: Record<string, string | undefined> = getProcessEnv(),
): ConfigObject {
  return new SubstitutionResolver(obj, env).resolveRoot();
}

function getProcessEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/**
 * One resolution of one parsed tree.
 *
 * `undefined` stands for "resolved to nothing" throughout — an optional
 * substitution with no answer — exactly as it did in the tree the old walk
 * returned, so `stripUndefined` and every caller keep their meaning.
 */
class SubstitutionResolver {
  /** Resolved fields by `pathKey`; a stored `undefined` is a field that resolved to nothing. */
  private readonly resolved = new Map<string, ConfigValue | undefined>();
  /** The fields whose resolution is under way, outermost first — what names a cycle. */
  private readonly resolving: Array<readonly string[]> = [];

  constructor(
    private readonly root: ConfigObject,
    private readonly env: Record<string, string | undefined>,
  ) {}

  resolveRoot(): ConfigObject {
    return this.resolveObject(this.root, [], true);
  }

  /**
   * The resolved value of the field at `path`, whose unresolved value is
   * `node` — memoised, so a field a lookup already resolved is not resolved a
   * second time when the walk reaches it.
   */
  private resolveField(path: readonly string[], node: ConfigValue | undefined): ConfigValue | undefined {
    const key = pathKey(path);
    if (this.resolved.has(key)) return this.resolved.get(key);
    const open = this.resolving.findIndex((entry) => pathKey(entry) === key);
    if (open >= 0) {
      const cycle = [...this.resolving.slice(open), path].map((entry) => entry.join('.'));
      throw new Error(`Substitution cycle: ${cycle.join(' -> ')}`);
    }
    this.resolving.push(path);
    let value: ConfigValue | undefined;
    try {
      value = this.resolveNode(node, path, true);
    } finally {
      this.resolving.pop();
    }
    this.resolved.set(key, value);
    return value;
  }

  /**
   * `addressable` says whether `node` is the tree's own value at `path`.  Only
   * then are its fields resolved through `resolveField`, where a lookup can
   * meet them: an object inside a list, or the value an optional substitution
   * replaced, is reachable by no path, so its fields resolve in place.
   */
  private resolveNode(node: ConfigValue | undefined, path: readonly string[], addressable: boolean): ConfigValue | undefined {
    if (node === undefined) return undefined;
    return match(node)
      .when(isSubstitution, (substitution) => this.resolveSubstitution(substitution, path))
      .when((value): value is ConfigValue[] => Array.isArray(value), (list) => this.resolveList(list, path))
      .when(isPlainObject, (object) => this.resolveObject(object, path, addressable))
      .otherwise((primitive) => primitive);
  }

  private resolveObject(object: ConfigObject, path: readonly string[], addressable: boolean): ConfigObject {
    const out: ConfigObject = {};
    for (const [key, child] of Object.entries(object)) {
      if (isForbiddenConfigKey(key)) continue;
      const childPath = [...path, key];
      const value = addressable
        ? this.resolveField(childPath, child)
        : this.resolveNode(child, childPath, false);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** A list is one field: its elements share its path, and one that resolves to nothing drops out. */
  private resolveList(list: readonly ConfigValue[], path: readonly string[]): ConfigValue[] {
    const out: ConfigValue[] = [];
    for (const element of list) {
      const value = this.resolveNode(element, path, false);
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  /**
   * The tree, then the environment, then — for the optional form — the value
   * the assignment replaced.
   *
   * A field that names itself, `pod.ip = ${?pod.ip}`, skips the tree: its own
   * value there is the very substitution being resolved, so the environment
   * answers, and then what the assignment replaced.  That is what the old walk
   * did too — it met the unresolved marker and moved on — so it is kept rather
   * than refused as a cycle.  The replaced value resolves at the same path, in
   * the same frame, so `x = 1`, `x = ${?x}`, `x = ${?x}` is no cycle either.
   */
  private resolveSubstitution(substitution: Substitution, path: readonly string[]): ConfigValue | undefined {
    const target = substitution.path.split('.');
    if (!samePath(target, path)) {
      const fromTree = this.lookupTree(target);
      if (fromTree !== undefined) return fromTree;
    }
    const fromEnvironment = this.lookupEnvironment(substitution.path);
    if (fromEnvironment !== undefined) return fromEnvironment;
    if (substitution.optional) {
      return substitution.previous === undefined
        ? undefined
        : this.resolveNode(substitution.previous, path, false);
    }
    throw new Error(`Unresolved substitution: \${${substitution.path}}`);
  }

  /**
   * The resolved value at `target`, reading the tree's **own** properties only,
   * or `undefined` when the tree has none.
   *
   * The `Object.hasOwn` guard is what keeps `${toString}` from splicing a
   * native function into the resolved config: without it the descent reads
   * straight through to `Object.prototype`, every member of which answers a
   * lookup.  A blocklist cannot close that hole — `isForbiddenConfigKey` names
   * three keys, while the prototype chain is open-ended (engine and host
   * additions land there too) — so the guard is stated positively instead.  It
   * also keeps the fallback to the environment open: a hit here short-circuits
   * it, so a shadowed `${?toString}` could never reach `env` at all (#589).
   *
   * The two checks are not redundant.  `Object.hasOwn` misses an *own*
   * `__proto__` — `JSON.parse('{"__proto__":…}')` produces exactly that, and a
   * caller may hand us such a tree — which is what `isForbiddenConfigKey` is
   * still here for.  A forbidden segment is a miss rather than an error:
   * `parseSubstitution` refuses those with a source position, so reaching here
   * means the path was built in code, where an optional substitution should
   * just miss.
   *
   * A substitution met on the way — `b = ${a.k}` with `a = ${?OBJ}` — is
   * resolved, and the descent goes on in its value, which is data.
   */
  private lookupTree(target: readonly string[]): ConfigValue | undefined {
    let node: ConfigValue | undefined = this.root;
    for (let depth = 0; depth < target.length; depth++) {
      const segment = target[depth]!;
      if (isForbiddenConfigKey(segment)) return undefined;
      if (isSubstitution(node)) {
        const resolved = this.resolveField(target.slice(0, depth), node);
        return readData(resolved, target.slice(depth));
      }
      if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return undefined;
      node = node[segment];
    }
    return this.resolveField(target, node);
  }

  /**
   * The variable named by the path, else by the path upper-cased with its
   * dots turned into underscores — read as JSON where it parses as JSON, so
   * `${FOO}` can be a number, a boolean, a list or an object, and as the raw
   * string where it does not.
   */
  private lookupEnvironment(path: string): ConfigValue | undefined {
    const raw = readOwnEnvironmentEntry(this.env, path)
      ?? readOwnEnvironmentEntry(this.env, path.replace(/\./g, '_').toUpperCase());
    if (raw === undefined) return undefined;
    try {
      return withoutForbiddenKeys(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
}

/**
 * A path as one map key.  JSON rather than `join('.')`, because a quoted key
 * may hold a dot of its own: `a."b.c"` and `a.b.c` are different fields.
 */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** Descend into a resolved value — own properties of plain objects only, as `lookupTree` does. */
function readData(value: ConfigValue | undefined, rest: readonly string[]): ConfigValue | undefined {
  let current = value;
  for (const segment of rest) {
    if (isForbiddenConfigKey(segment)) return undefined;
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as ConfigObject)[segment];
  }
  return current;
}

/**
 * A value decoded from the environment, with every forbidden key dropped at
 * every depth.
 *
 * `JSON.parse` makes an own `__proto__` an ordinary property, which a later
 * plain copy would hand to the prototype setter.  The walk this resolver
 * replaced dropped such keys in passing, on its second pass over the tree;
 * nothing walks a resolved value now, so the copy is made here, once.
 */
function withoutForbiddenKeys(value: unknown): ConfigValue {
  if (Array.isArray(value)) return value.map(withoutForbiddenKeys);
  if (typeof value === 'object' && value !== null) {
    const out: ConfigObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!isForbiddenConfigKey(key)) out[key] = withoutForbiddenKeys(entry);
    }
    return out;
  }
  return value as ConfigValue;
}

/**
 * The environment is prototype-backed as well, so it gets the same own-property
 * guard the tree lookup has: a bare `env['toString']` hands back a native
 * function on Node and Deno (`process.env` is a proxy that forwards the
 * inherited members) and on any plain `{ … }` map a caller passes in — which
 * would splice that function into the config exactly as the tree read once did.
 * Bun happens to return `undefined` there, so the bare read looked correct on
 * the primary runtime and failed on the other two.
 */
function readOwnEnvironmentEntry(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

/* ================================ Utilities =============================== */

export function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isSubstitution(value);
}

/**
 * Deep merge — values in `overlay` win, objects merge recursively, arrays
 * overwrite.
 *
 * Both sides are filtered through `isForbiddenConfigKey`.  The parser already
 * refuses those keys, so for HOCON input this is redundant — but `deepMerge`
 * is exported and merges layers that come from plain JavaScript objects too,
 * where `JSON.parse('{"__proto__":{…}}')` yields an *own* `__proto__` property
 * that `Object.entries` happily reports.  Note the base is copied key by key
 * rather than with `{ ...base }`: a spread would carry such an own property
 * straight through.
 */
export function deepMerge(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isForbiddenConfigKey(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (isForbiddenConfigKey(key)) continue;
    const existing = ownValue(out, key);
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = overrideKeepingPrevious(existing, value);
    }
  }
  return out;
}

/**
 * The value `key` already holds on `object`, or `undefined` when it holds none
 * of its own.
 *
 * Both overwrite sites read the value they are about to replace, to merge into
 * it or to keep it as an optional substitution's fallback.  A config object is
 * a plain object literal and inherits every `Object.prototype` member, while
 * `toString`, `valueOf` or `hasOwnProperty` are keys a document may use; read
 * through the prototype chain, such a key that was not set yet looked set to
 * the inherited function, and an optional substitution that nothing answered
 * fell back to that function instead of leaving the key unset.
 */
function ownValue(object: ConfigObject, key: string): ConfigValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * The one overwrite rule for a key assigned twice, shared by the parser's
 * `mergeKeyPath` and by `deepMerge` so that parsing two documents
 * concatenated and merging them parsed separately stay the same operation
 * (`HoconProperties.test.ts` holds them against each other).
 *
 * The newer value wins, as before — except that an optional substitution
 * carries the value it displaces along, for `resolveOne` to fall back to
 * when nothing answers it.  Without that, `port = 2552` then
 * `port = ${?PORT}` — the override idiom of every Akka and Pekko
 * `application.conf` — dropped `port` whenever the variable was unset,
 * because the `2552` was gone before resolution began and the unresolved
 * optional was stripped afterwards (#1536).  On an already-resolved tree
 * (every cross-layer merge) no substitution survives, so this is the plain
 * assignment it replaces.
 *
 * A displaced value goes to the *tail* of the chain the incoming optional
 * already carries: a document parsed on its own and then merged onto a base
 * that set the same key must fall back to its own earlier value first, and
 * to the base's only after that — the order the concatenated document has.
 */
function overrideKeepingPrevious(existing: ConfigValue | undefined, incoming: ConfigValue): ConfigValue {
  if (!isSubstitution(incoming) || !incoming.optional || existing === undefined) return incoming;
  return {
    ...incoming,
    previous: incoming.previous === undefined
      ? existing
      : overrideKeepingPrevious(existing, incoming.previous),
  };
}

/** Strip undefined values that originated from optional substitutions. */
export function stripUndefined(obj: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || isForbiddenConfigKey(key)) continue;
    if (isPlainObject(value)) out[key] = stripUndefined(value as ConfigObject);
    else if (Array.isArray(value)) out[key] = value.filter(x => x !== undefined) as ConfigValue[];
    else out[key] = value;
  }
  return out;
}
