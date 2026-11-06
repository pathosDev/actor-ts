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
 *   - An assignment with no value (`key =`) is no assignment: the key keeps
 *     what it held — see `assignsNoValue`.
 *   - String value concatenation: simple pieces on one line joined into one
 *     string, `"redis://:"${PASSWORD}"@host"` — see `parseSimpleValue`.
 *
 * Features left out (#537), each refused with its own message rather than
 * mis-parsed:
 *   - Object and list concatenation (`{a = 1} {b = 2}`, `[1] [2]`) and `+=`.
 *   - Triple-quoted multi-line strings.
 *
 * `include` is a different case from those: it is not merely unimplemented
 * but deliberately refused, and it says so — see `includeNotSupported`.  Compose
 * several sources in code instead, with `Config.parseFile(…).merge(…)`.
 */
import { match } from 'ts-pattern';

export type ConfigPrimitive = string | number | boolean | null;
export type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigObject | Substitution | Concatenation;
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
 * A string built from pieces on one line, at least one of them a
 * substitution: `"redis://:"${PASSWORD}"@host"`, `${HOST}:${PORT}`,
 * `app-${STAGE}` (#537).  The text pieces are kept as written, whitespace
 * between pieces included, and the substitutions are joined in as text when
 * the tree resolves.  A concatenation with no substitution is a plain string
 * already at parse time and never becomes one of these.
 */
export type Concatenation = {
  readonly __concatenation: true;
  readonly pieces: ReadonlyArray<string | Substitution>;
  /**
   * True when every piece is an optional substitution or whitespace, so the
   * whole may resolve to nothing — `${?A}${?B}` with neither set.  Such a
   * concatenation behaves like an optional substitution: it carries the value
   * its assignment replaced, and falls back to it.
   */
  readonly optional: boolean;
  /** As on {@link Substitution}: the value this assignment replaced, kept only when `optional`. */
  readonly previous?: ConfigValue;
};

export function isConcatenation(value: unknown): value is Concatenation {
  return typeof value === 'object' && value !== null && (value as Concatenation).__concatenation === true;
}

/** A value the resolver still has to replace — a substitution, or a concatenation holding one. */
export function isUnresolved(value: unknown): value is Substitution | Concatenation {
  return isSubstitution(value) || isConcatenation(value);
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
        if (this.assignsNoValue(terminator)) {
          // An assignment with nothing after it is no assignment (#1786): the
          // key keeps what it held, and the line after it is read as the field
          // it is rather than as this key's value.
          this.skipSeparator();
          continue;
        }
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
    if (char === '{') return this.refuseConcatenationAfter(this.parseObject(), 'an object');
    if (char === '[') return this.refuseConcatenationAfter(this.parseArray(), 'a list');
    return this.parseSimpleValue();
  }

  /**
   * A value made of simple pieces on one line — quoted strings, substitutions
   * and unquoted runs — joined into one string (#537), the way HOCON's value
   * concatenation does it: `"redis://:"${PASSWORD}"@host"`, `${HOST}:${PORT}`,
   * `app-${STAGE}`.
   *
   * A single piece keeps its own type, so `30`, `true`, `null` and a lone
   * `${PORT}` read as before.  Pieces never span a line, and whitespace between
   * them is kept, as the specification has it.  Two things end a value besides
   * a terminator: whitespace followed by the start of another field, which is
   * how `a = "x" b = 1` was always read, and an object or a list, which is
   * refused — concatenating those is not implemented, and reading
   * `"a" {b = 1}` as a string would be a silent wrong answer.
   *
   * An unquoted run stops at `${` only, and a quote opens a string only where
   * a piece begins — so `say "hi" now` and `foo"bar"` stay the unquoted
   * strings they were.  That is also why `${` inside quotes is not a
   * substitution: the specification keeps substitutions out of quoted text.
   */
  private parseSimpleValue(): ConfigValue {
    const pieces: Array<{ readonly text: string; readonly unquoted: boolean } | Substitution> = [];
    while (true) {
      const char = this.peekChar();
      if (char === '"') {
        // Any run of three quotes opens a multi-line string in HOCON — `""""`
        // included, which the specification does not read as two empty
        // strings.  Refused rather than read as `""` and `"` and the rest.
        if (this.src.startsWith('"""', this.pos)) throw this.error('Triple-quoted strings are not supported (#537)');
        pieces.push({ text: this.parseQuotedString(), unquoted: false });
      } else if (char === '$' && this.src[this.pos + 1] === '{') {
        pieces.push(this.parseSubstitution());
      } else {
        pieces.push({ text: this.parseUnquotedRun(), unquoted: true });
      }
      const pieceEnd = this.pos;
      while (this.peekChar() === ' ' || this.peekChar() === '\t') this.pos++;
      const gap = this.src.slice(pieceEnd, this.pos);
      if (this.endsSimpleValue()) { this.pos = pieceEnd; break; }
      const next = this.peekChar();
      if (next === '{' || next === '[') {
        const before = isSubstitution(pieces[pieces.length - 1]) ? 'a substitution' : 'a string';
        throw this.error(`Concatenating ${before} with ${next === '{' ? 'an object' : 'a list'} is not supported (#537)`);
      }
      if (gap !== '' && this.startsField()) { this.pos = pieceEnd; break; }
      if (gap !== '') pieces.push({ text: gap, unquoted: false });
    }
    return this.valueOfPieces(pieces);
  }

  /** The value a sequence of pieces stands for — see {@link parseSimpleValue}. */
  private valueOfPieces(
    pieces: ReadonlyArray<{ readonly text: string; readonly unquoted: boolean } | Substitution>,
  ): ConfigValue {
    if (pieces.length === 1) {
      const only = pieces[0]!;
      if (isSubstitution(only)) return only;
      return only.unquoted ? this.literalOf(only.text.trim()) : only.text;
    }
    // The run in front of the first piece was trimmed by the caller's skip; a
    // trailing unquoted run loses its trailing whitespace, as a single one does.
    const last = pieces[pieces.length - 1]!;
    const trimmed = pieces.map((piece) =>
      piece === last && !isSubstitution(piece) && piece.unquoted ? { ...piece, text: piece.text.trimEnd() } : piece);
    if (!trimmed.some(isSubstitution)) {
      return trimmed.map((piece) => (piece as { readonly text: string }).text).join('');
    }
    const folded: Array<string | Substitution> = [];
    for (const piece of trimmed) {
      if (isSubstitution(piece)) { folded.push(piece); continue; }
      const previous = folded[folded.length - 1];
      if (typeof previous === 'string') folded[folded.length - 1] = previous + piece.text;
      else folded.push(piece.text);
    }
    const optional = folded.every((piece) =>
      typeof piece === 'string' ? piece.trim() === '' : piece.optional);
    return { __concatenation: true, pieces: folded.filter((piece) => piece !== ''), optional };
  }

  /** Whether the value being read ends here: a line break, a separator, a terminator, a comment or the end. */
  private endsSimpleValue(): boolean {
    const char = this.peekChar();
    if (char === undefined || char === '\n' || char === '\r' || char === ',' || char === '}' || char === ']') return true;
    return char === '#' || (char === '/' && this.src[this.pos + 1] === '/');
  }

  /**
   * `value`, after refusing anything but the end of the value behind it on
   * the same line.  `{a = 1} {b = 2}` would be an object concatenation and
   * `[1] [2]` a list concatenation; neither is implemented, and the parser
   * used to fail on them with an unrelated "Expected a key".
   */
  private refuseConcatenationAfter<T extends ConfigValue>(value: T, what: string): T {
    const end = this.pos;
    while (this.peekChar() === ' ' || this.peekChar() === '\t') this.pos++;
    const followed = !this.endsSimpleValue() && !(this.pos > end && this.startsField());
    if (followed) throw this.error(`Concatenating ${what} with another value is not supported (#537)`);
    this.pos = end;
    return value;
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

  /**
   * An unquoted run: everything up to a line break, a separator, a
   * terminator, a comment or `${` — untrimmed, because whitespace in front of
   * a following piece belongs to the string (`host ${PORT}`).
   *
   * Deliberately permissive, as it always was: `localhost:2552`,
   * `2 minutes` and `C:\logs` are one run each.  Two things the old scanner
   * did silently it now refuses.  `//` starts a comment, so `a = http://x`
   * read as the string `http:`; a `//` right behind a `:` is a URL with its
   * scheme cut off, and is refused with the advice to quote it.
   */
  private parseUnquotedRun(): string {
    const start = this.pos;
    while (!this.isAtEnd()) {
      const char = this.src[this.pos]!;
      if (char === '\n' || char === ',' || char === '}' || char === ']' || char === '#') break;
      if (char === '$' && this.src[this.pos + 1] === '{') break;
      if (char === '/' && this.src[this.pos + 1] === '/') {
        if (this.pos > start && this.src[this.pos - 1] === ':') {
          throw this.error('A URL in an unquoted value reads as a comment from its "//" on — put it in quotes');
        }
        break;
      }
      this.pos++;
    }
    const run = this.src.slice(start, this.pos);
    if (run.trim() === '') throw this.error('Expected a value');
    return run;
  }

  /** A single unquoted piece as a literal — `true`, `false`, `null`, a number — or the string it is. */
  private literalOf(raw: string): ConfigValue {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
      const numberValue = Number(raw);
      if (Number.isFinite(numberValue)) return numberValue;
    }
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

  /**
   * Whether the `=` or `:` just consumed is followed by no value (#1786).
   *
   * On its own line the answer is plain: a `,`, the field list's closing `}`
   * or the end of input means nothing was written.  Across a line break it is
   * not, because JSON puts a value on the line after its key (`"a":` then
   * `1`) and that layout has to keep working.  So the next significant text
   * decides: the end of input, the closing `}`, or the start of another field
   * means this assignment has no value; anything else is its value.
   *
   * Leaves the position after the inline whitespace either way, which is where
   * both callers continue.
   */
  private assignsNoValue(terminator: '}' | null): boolean {
    this.skipInsignificantInline();
    const char = this.peekChar();
    if (char === undefined || char === ',' || char === '}') return true;
    if (char !== '\n') return false;
    const lineEnd = this.pos;
    this.skipInsignificant();
    const next = this.peekChar();
    const noValue = next === undefined || (terminator !== null && next === terminator) || this.startsField();
    this.pos = lineEnd;
    return noValue;
  }

  /**
   * Whether a field starts at the current position: a key path followed by
   * `=`, `:`, `{` or `+=`, or the `include` directive.
   *
   * A scanner over the source rather than a trial `parseKeyPath`, for two
   * reasons.  The key parser throws, and a lookahead that caught its errors
   * would read a forbidden key on the next line (`__proto__ = 1`) as this
   * key's value instead of letting the refusal fire where the field is
   * parsed.  And `include "file"` is a field position too — taking it for a
   * value would turn the directive into a string and its refusal would never
   * be reached.  `+=` is unsupported, but it is a field all the same, and
   * counting it as one keeps its own error message.
   */
  private startsField(): boolean {
    let at = this.pos;
    const segment = (): boolean => {
      while (this.src[at] === ' ' || this.src[at] === '\t') at++;
      if (this.src[at] === '"') {
        at++;
        while (at < this.src.length && this.src[at] !== '"' && this.src[at] !== '\n') {
          at += this.src[at] === '\\' ? 2 : 1;
        }
        if (this.src[at] !== '"') return false;
        at++;
        return true;
      }
      const start = at;
      while (at < this.src.length && /[A-Za-z0-9_\-]/.test(this.src[at]!)) at++;
      return at > start;
    };
    const keyStart = at;
    if (!segment()) return false;
    if (this.src.slice(keyStart, at) === 'include' && /^[ \t]+"/.test(this.src.slice(at))) return true;
    while (this.src[at] === '.') {
      at++;
      if (!segment()) return false;
    }
    while (this.src[at] === ' ' || this.src[at] === '\t') at++;
    const after = this.src[at];
    return after === '=' || after === ':' || after === '{' || (after === '+' && this.src[at + 1] === '=');
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
  return new SubstitutionResolver(obj, { environment: [env] }).resolveRoot().tree;
}

function getProcessEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/** A source of variables a substitution may read, by name. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/** What {@link resolveLayer} resolves a tree against, besides the tree itself. */
export type ResolveLayerOptions = {
  /**
   * Variables, in order: for each name the first source that holds a value
   * that is not empty answers (#1787).  `Config.load` passes the real
   * environment first and a `.env` file's entries after it (#1785), so a
   * variable the process was started with always wins.
   *
   * Sources rather than one merged record: Deno grants environment access
   * per variable, so copying `process.env` would ask for all of them.
   */
  readonly environment?: ReadonlyArray<EnvironmentSource>;
  /**
   * The resolved layers beneath this one, merged — what a substitution reads
   * when the tree has no such key (#1785).  Read only, and never merged into
   * the result: a substitution that finds nothing still leaves its key out,
   * so the layer below shows through and the attribution by layer stays
   * true.
   */
  readonly fallback?: ConfigObject;
  /**
   * Which variables supplied the value at a path of {@link fallback} — the
   * provenance a value found there carries into this layer.
   */
  readonly fallbackVariables?: (path: readonly string[]) => Iterable<string>;
};

/** A resolved tree, and which variables supplied the value of each of its leaves. */
export type ResolvedLayer = {
  readonly tree: ConfigObject;
  /**
   * Leaf path (`pathKey`-encoded) → the names of the variables whose values
   * make up the leaf's value: read directly, through a reference to another
   * key, or as a piece of a concatenation.  A list is one leaf.  A leaf whose
   * value no variable supplied has no entry.
   */
  readonly variablesByPath: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * Resolve one layer of a configuration — {@link resolveSubstitutions} with the
 * environment as ordered sources, the layers beneath as a read-only fallback,
 * and the provenance of every leaf in the answer (#1785, #1788).
 */
export function resolveLayer(tree: ConfigObject, options: ResolveLayerOptions = {}): ResolvedLayer {
  return new SubstitutionResolver(tree, options).resolveRoot();
}

/** What {@link SubstitutionResolver.lookupEnvironment} answers when the only variables it found are empty. */
const EMPTY_VARIABLE: unique symbol = Symbol('empty environment variable');

/**
 * Which variables supplied a resolved value, by leaf: the key is the leaf's
 * path *relative to the value* (`pathKey`-encoded, `[]` for the value itself),
 * the entry the names behind it.  Carried with every value the resolver
 * returns, so a value that moves — through a reference, into a string, out of
 * a layer below — takes what it came from along.
 */
type Provenance = ReadonlyMap<string, ReadonlySet<string>>;

const NO_PROVENANCE: Provenance = new Map();

/** A resolved value — `undefined` for "nothing" — and the variables behind its leaves. */
type Resolved = {
  readonly value: ConfigValue | undefined;
  readonly provenance: Provenance;
};

const NOTHING: Resolved = { value: undefined, provenance: NO_PROVENANCE };

/**
 * One resolution of one parsed tree.
 *
 * `undefined` stands for "resolved to nothing" throughout — an optional
 * substitution with no answer — exactly as it did in the tree the old walk
 * returned, so `stripUndefined` and every caller keep their meaning.
 */
class SubstitutionResolver {
  /** Resolved fields by `pathKey`; a stored `undefined` value is a field that resolved to nothing. */
  private readonly resolved = new Map<string, Resolved>();
  /** The fields whose resolution is under way, outermost first — what names a cycle. */
  private readonly resolving: Array<readonly string[]> = [];
  private readonly environment: ReadonlyArray<EnvironmentSource>;

  constructor(
    private readonly root: ConfigObject,
    private readonly options: ResolveLayerOptions,
  ) {
    this.environment = options.environment ?? [getProcessEnv()];
  }

  resolveRoot(): ResolvedLayer {
    const { value, provenance } = this.resolveObject(this.root, [], true);
    return { tree: value as ConfigObject, variablesByPath: provenance };
  }

  /**
   * The resolved value of the field at `path`, whose unresolved value is
   * `node` — memoised, so a field a lookup already resolved is not resolved a
   * second time when the walk reaches it.
   */
  private resolveField(path: readonly string[], node: ConfigValue | undefined): Resolved {
    const key = pathKey(path);
    const known = this.resolved.get(key);
    if (known !== undefined) return known;
    const open = this.resolving.findIndex((entry) => pathKey(entry) === key);
    if (open >= 0) {
      const cycle = [...this.resolving.slice(open), path].map((entry) => entry.join('.'));
      throw new Error(`Substitution cycle: ${cycle.join(' -> ')}`);
    }
    this.resolving.push(path);
    let result: Resolved;
    try {
      result = this.resolveNode(node, path, true);
    } finally {
      this.resolving.pop();
    }
    this.resolved.set(key, result);
    return result;
  }

  /**
   * `addressable` says whether `node` is the tree's own value at `path`.  Only
   * then are its fields resolved through `resolveField`, where a lookup can
   * meet them: an object inside a list, or the value an optional substitution
   * replaced, is reachable by no path, so its fields resolve in place.
   */
  private resolveNode(node: ConfigValue | undefined, path: readonly string[], addressable: boolean): Resolved {
    if (node === undefined) return NOTHING;
    return match(node)
      .when(isSubstitution, (substitution) => this.resolveSubstitution(substitution, path))
      .when(isConcatenation, (concatenation) => this.resolveConcatenation(concatenation, path))
      .when((value): value is ConfigValue[] => Array.isArray(value), (list) => this.resolveList(list, path))
      .when(isPlainObject, (object) => this.resolveObject(object, path, addressable))
      .otherwise((primitive): Resolved => ({ value: primitive, provenance: NO_PROVENANCE }));
  }

  private resolveObject(object: ConfigObject, path: readonly string[], addressable: boolean): Resolved {
    const out: ConfigObject = {};
    const provenance = new Map<string, ReadonlySet<string>>();
    for (const [key, child] of Object.entries(object)) {
      if (isForbiddenConfigKey(key)) continue;
      const childPath = [...path, key];
      const resolved = addressable
        ? this.resolveField(childPath, child)
        : this.resolveNode(child, childPath, false);
      if (resolved.value === undefined) continue;
      out[key] = resolved.value;
      for (const [relative, variables] of resolved.provenance) {
        provenance.set(pathKey([key, ...JSON.parse(relative) as string[]]), variables);
      }
    }
    return { value: out, provenance };
  }

  /**
   * A list is one field and one leaf: its elements share its path, one that
   * resolves to nothing drops out, and the variables behind any element are
   * the list's.
   */
  private resolveList(list: readonly ConfigValue[], path: readonly string[]): Resolved {
    const out: ConfigValue[] = [];
    const variables = new Set<string>();
    for (const element of list) {
      const resolved = this.resolveNode(element, path, false);
      if (resolved.value === undefined) continue;
      out.push(resolved.value);
      for (const names of resolved.provenance.values()) for (const name of names) variables.add(name);
    }
    return { value: out, provenance: variables.size === 0 ? NO_PROVENANCE : new Map([[pathKey([]), variables]]) };
  }

  /**
   * The tree, then the layers beneath, then the environment, then — for the
   * optional form — the value the assignment replaced.
   *
   * A field that names itself, `pod.ip = ${?pod.ip}`, skips the tree: its own
   * value there is the very substitution being resolved.  The layers beneath
   * answer first then, which is how an override in `application.conf` builds
   * on the key the project's `reference.conf` sets; then the environment, then
   * what the assignment replaced.  The replaced value resolves at the same
   * path, in the same frame, so `x = 1`, `x = ${?x}`, `x = ${?x}` is no cycle.
   */
  private resolveSubstitution(
    substitution: Substitution,
    path: readonly string[],
    reading: EnvironmentReading = 'value',
  ): Resolved {
    const target = substitution.path.split('.');
    if (!samePath(target, path)) {
      const fromTree = this.lookupTree(target);
      if (fromTree.value !== undefined) return fromTree;
    }
    const fromFallback = this.lookupFallback(target);
    if (fromFallback.value !== undefined) return fromFallback;
    const fromEnvironment = this.lookupEnvironment(substitution.path);
    if (fromEnvironment !== EMPTY_VARIABLE && fromEnvironment !== undefined) {
      const value = reading === 'text' ? fromEnvironment.raw : environmentValueOf(fromEnvironment.raw);
      return { value, provenance: everyLeafFrom(value, fromEnvironment.name) };
    }
    if (substitution.optional) {
      return substitution.previous === undefined
        ? NOTHING
        : this.resolveNode(substitution.previous, path, false);
    }
    // The prefix stays the same whichever way the lookup missed: callers
    // match on it, and only the reason after it differs.
    const reason = fromEnvironment === EMPTY_VARIABLE
      ? ` — the environment variable that would answer it is set but empty, which counts as not set`
      : '';
    throw new Error(`Unresolved substitution: \${${substitution.path}}${reason}`);
  }

  /**
   * The string a concatenation stands for (#537), or nothing when it is made
   * of optional substitutions only and none of them answers.
   *
   * A variable contributes the text it holds, not its JSON reading.  JSON
   * first gives a lone `${PORT}` a number; inside a string it would turn
   * `PASSWORD=123456789012345678901234` into `1.2345678901234569e+23` and a
   * quoted `"x"` into `x`.  A value from the tree joins in as HOCON writes it
   * — a number as its digits, `true`, `null` — and an object or a list is
   * refused: string concatenation is for simple values only.  An optional
   * substitution that finds nothing adds nothing, as the specification has
   * it; when no piece answers at all, the concatenation falls back to the
   * value its assignment replaced, the way an optional substitution does.
   *
   * The string is one leaf, made of every piece's variables.
   */
  private resolveConcatenation(concatenation: Concatenation, path: readonly string[]): Resolved {
    let text = '';
    let answered = false;
    const variables = new Set<string>();
    for (const piece of concatenation.pieces) {
      if (typeof piece === 'string') { text += piece; continue; }
      const resolved = this.resolveSubstitution(piece, path, 'text');
      const value = resolved.value;
      if (value === undefined) continue;
      if (typeof value === 'object' && value !== null) {
        const what = Array.isArray(value) ? 'a list' : 'an object';
        throw new Error(`Cannot join \${${piece.path}} into a string at ${path.join('.')}: it resolves to ${what}`);
      }
      text += String(value);
      answered = true;
      for (const names of resolved.provenance.values()) for (const name of names) variables.add(name);
    }
    if (answered || !concatenation.optional) {
      return { value: text, provenance: variables.size === 0 ? NO_PROVENANCE : new Map([[pathKey([]), variables]]) };
    }
    return concatenation.previous === undefined
      ? NOTHING
      : this.resolveNode(concatenation.previous, path, false);
  }

  /**
   * The resolved value at `target`, reading the tree's **own** properties only,
   * or nothing when the tree has none.
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
  private lookupTree(target: readonly string[]): Resolved {
    let node: ConfigValue | undefined = this.root;
    for (let depth = 0; depth < target.length; depth++) {
      const segment = target[depth]!;
      if (isForbiddenConfigKey(segment)) return NOTHING;
      if (isUnresolved(node)) {
        return within(this.resolveField(target.slice(0, depth), node), target.slice(depth));
      }
      if (!isPlainObject(node) || !Object.hasOwn(node, segment)) return NOTHING;
      node = (node as ConfigObject)[segment];
    }
    return this.resolveField(target, node);
  }

  /**
   * The value at `target` in the resolved layers beneath, with the variables
   * that supplied it there (#1785).  Already resolved, so it is data: read
   * with the same own-property guard as the tree, and never walked again.
   */
  private lookupFallback(target: readonly string[]): Resolved {
    const fallback = this.options.fallback;
    if (fallback === undefined) return NOTHING;
    const value = readData(fallback, target);
    if (value === undefined) return NOTHING;
    const variablesOf = this.options.fallbackVariables;
    if (variablesOf === undefined) return { value, provenance: NO_PROVENANCE };
    const provenance = new Map<string, ReadonlySet<string>>();
    for (const leaf of leafPaths(value)) {
      const names = new Set(variablesOf([...target, ...leaf]));
      if (names.size > 0) provenance.set(pathKey(leaf), names);
    }
    return { value, provenance };
  }

  /**
   * The text of the variable named by the path, else by the path upper-cased
   * with its dots turned into underscores, and which name answered.  A lone
   * `${FOO}` reads it as JSON where it parses as JSON, so it can be a number,
   * a boolean, a list or an object ({@link environmentValueOf}); a
   * concatenation takes the text.
   *
   * The sources are asked in order, and for each name the first one that
   * holds a value that is not empty answers.  A variable that is set but
   * empty answers nothing (#1787).  `PORT=` in a shell, `environment: [PORT]`
   * in a compose file and an empty line of an env file are how those spell
   * "unset", and `Config.load` already reads an empty `ACTOR_TS_PROFILE` that
   * way.  Taken as a value, it replaced the default an optional substitution
   * was written to fall back to, and it satisfied a required one with nothing
   * in it.  An empty variable does not hide a later source, nor the
   * upper-cased spelling: whichever carries a value answers.
   * {@link EMPTY_VARIABLE} tells the caller that only empty ones were found,
   * so the error can say so.
   */
  private lookupEnvironment(path: string): { readonly name: string; readonly raw: string } | typeof EMPTY_VARIABLE | undefined {
    let sawEmpty = false;
    for (const name of [path, path.replace(/\./g, '_').toUpperCase()]) {
      for (const source of this.environment) {
        const raw = readOwnEnvironmentEntry(source, name);
        if (raw === undefined) continue;
        if (raw === '') { sawEmpty = true; continue; }
        return { name, raw };
      }
    }
    return sawEmpty ? EMPTY_VARIABLE : undefined;
  }
}

/**
 * How a substitution reads a variable: `'value'` is JSON first, for a lone
 * `${X}`; `'text'` is the string as it is set, for a piece of a concatenation.
 */
type EnvironmentReading = 'value' | 'text';

/** A variable's text read as JSON where it parses as JSON, and as the raw string where it does not. */
function environmentValueOf(raw: string): ConfigValue {
  try {
    return withoutForbiddenKeys(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/**
 * `resolved` narrowed to what lies at `rest` inside its value, with the
 * provenance of that part.  A leaf at or below `rest` keeps its variables,
 * re-rooted; a leaf above it — the whole value came from one variable, say —
 * gives its variables to the part, since the part is made of it.
 */
function within(resolved: Resolved, rest: readonly string[]): Resolved {
  const value = readData(resolved.value, rest);
  if (value === undefined) return NOTHING;
  const provenance = new Map<string, Set<string>>();
  const add = (leaf: readonly string[], variables: ReadonlySet<string>): void => {
    const key = pathKey(leaf);
    const into = provenance.get(key) ?? new Set<string>();
    for (const name of variables) into.add(name);
    provenance.set(key, into);
  };
  for (const [relative, variables] of resolved.provenance) {
    const leaf = JSON.parse(relative) as string[];
    if (samePath(leaf.slice(0, rest.length), rest)) add(leaf.slice(rest.length), variables);
    else if (samePath(rest.slice(0, leaf.length), leaf)) add([], variables);
  }
  return { value, provenance };
}

/** Every leaf of `value` — a list is one — tagged as supplied by the variable `name`. */
function everyLeafFrom(value: ConfigValue, name: string): Provenance {
  const names = new Set([name]);
  return new Map(leafPaths(value).map((leaf) => [pathKey(leaf), names]));
}

/** The paths of the leaves of `value`, relative to it; a non-object value is its own leaf at `[]`. */
function leafPaths(value: ConfigValue): string[][] {
  if (!isPlainObject(value)) return [[]];
  return Object.entries(value).flatMap(([key, child]) =>
    isForbiddenConfigKey(key) ? [] : leafPaths(child).map((rest) => [key, ...rest]));
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
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isUnresolved(value);
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
  if (!isUnresolved(incoming) || !incoming.optional || existing === undefined) return incoming;
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
