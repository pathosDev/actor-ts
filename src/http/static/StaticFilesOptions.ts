/**
 * Options for the static-file directives.  Options-only (HTTP terminal
 * handlers have no ActorSystem at request time, so no HOCON layer).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';
import { OptionsValidator } from '../../util/OptionsValidator.js';

/** Plain settings shape for the static-file directives. */
export type StaticFilesOptionsType = {
  /** Index files tried for a directory request.  Default `['index.html']`; `[]` disables. */
  readonly indexFiles?: readonly string[];
  /** Render an HTML listing when a directory has no usable index.  Default false. */
  readonly browse?: boolean;
  /** `Cache-Control` header value.  Default: header omitted. */
  readonly cacheControl?: string;
  /** Emit a weak `ETag` (size + mtime) and honour `If-None-Match`.  Default true. */
  readonly etag?: boolean;
  /** Emit `Last-Modified` and honour `If-Modified-Since`.  Default true. */
  readonly lastModified?: boolean;
  /** Honour a single `Range` request (206 / 416).  Default true. */
  readonly ranges?: boolean;
  /** Dotfile policy.  Default `'deny'` (404 + hidden from listings). */
  readonly dotfiles?: 'deny' | 'allow';
  /** Symlink policy.  Default `'within-root'` (a link escaping the root → 404). */
  readonly symlinks?: 'within-root' | 'follow';
  /** Per-extension content-type overrides (ext → full content-type). */
  readonly contentTypes?: Readonly<Record<string, string>>;
  /** getFromFile only: force this exact content-type. */
  readonly contentType?: string;
  /** Max file size buffered into memory.  Default 50 MiB; larger → 413. */
  readonly maxFileSize?: number;
  /**
   * Buffer/stream boundary in bytes: a body of at least this many bytes is
   * sent as a `ReadableStream` read in fixed-size chunks instead of a single
   * `Uint8Array`, so its memory cost stops scaling with the file.  Setting it
   * also retires the `maxFileSize` refusal, because nothing can then buffer
   * more than this many bytes (the validator enforces
   * `streamThreshold <= maxFileSize`).
   *
   * Unset by default, i.e. nothing streams.  Opt-in rather than on because a
   * streaming body is one-shot and the middleware that would corrupt it is
   * still being fixed — see the `static-files` docs and #674 / #979.
   */
  readonly streamThreshold?: number;
};

/** Fluent builder for {@link StaticFilesOptionsType}. */
export class StaticFilesOptionsBuilder extends OptionsBuilder<StaticFilesOptionsType> {
  static create(): StaticFilesOptionsBuilder {
    return new StaticFilesOptionsBuilder();
  }
  withIndexFiles(...names: string[]): this {
    return this.set('indexFiles', names);
  }
  withBrowse(enabled = true): this {
    return this.set('browse', enabled);
  }
  withCacheControl(value: string): this {
    return this.set('cacheControl', value);
  }
  withEtag(enabled: boolean): this {
    return this.set('etag', enabled);
  }
  withLastModified(enabled: boolean): this {
    return this.set('lastModified', enabled);
  }
  withRanges(enabled: boolean): this {
    return this.set('ranges', enabled);
  }
  withDotfiles(policy: 'deny' | 'allow'): this {
    return this.set('dotfiles', policy);
  }
  withSymlinks(policy: 'within-root' | 'follow'): this {
    return this.set('symlinks', policy);
  }
  withContentTypes(map: Readonly<Record<string, string>>): this {
    return this.set('contentTypes', map);
  }
  withContentType(contentType: string): this {
    return this.set('contentType', contentType);
  }
  withMaxFileSize(bytes: number): this {
    return this.set('maxFileSize', bytes);
  }
  withStreamThreshold(bytes: number): this {
    return this.set('streamThreshold', bytes);
  }
}

/** Accepted input: the builder or a plain object. */
export type StaticFilesOptions = StaticFilesOptionsBuilder | Partial<StaticFilesOptionsType>;
export const StaticFilesOptions = StaticFilesOptionsBuilder;

/**
 * Validates resolved {@link StaticFilesOptionsType} settings.  `maxFileSize`
 * and `streamThreshold` (both byte counts) must be positive integers, and
 * the `dotfiles` / `symlinks` policies must be one of their allowed
 * literals — replacing what would otherwise be a silent mis-configuration.
 */
export class StaticFilesOptionsValidator extends OptionsValidator<StaticFilesOptionsType> {
  constructor() {
    super('StaticFilesOptions');
  }
  protected rules(s: Partial<StaticFilesOptionsType>): void {
    this.positiveInt('maxFileSize');
    this.positiveInt('streamThreshold');
    this.oneOf('dotfiles', ['deny', 'allow']);
    this.oneOf('symlinks', ['within-root', 'follow']);
    // Cross-field, and load-bearing rather than tidy: `maxFileSize` is the
    // largest body that may be *buffered*, and `streamThreshold` is the
    // smallest that is *not*.  A threshold above the cap leaves a band of
    // sizes that streaming is enabled for and the cap still refuses with 413 —
    // a contradiction, not a policy.  Rejecting it is precisely what lets
    // `serveResolvedFile` skip the refusal once a threshold is set: with the
    // rule held, no response can buffer more than `streamThreshold` bytes, so
    // the bound is unreachable rather than waived.
    if (s.streamThreshold !== undefined && s.maxFileSize !== undefined && s.streamThreshold > s.maxFileSize) {
      this.fail('streamThreshold', `must not exceed maxFileSize (${s.maxFileSize})`, s.streamThreshold);
    }
  }
}

/** Fully-applied settings after defaults. */
export type ResolvedStaticOptions = {
  readonly indexFiles: readonly string[];
  readonly browse: boolean;
  readonly cacheControl: string | undefined;
  readonly etag: boolean;
  readonly lastModified: boolean;
  readonly ranges: boolean;
  readonly dotfiles: 'deny' | 'allow';
  readonly symlinks: 'within-root' | 'follow';
  readonly contentTypes: Readonly<Record<string, string>> | undefined;
  readonly contentType: string | undefined;
  readonly maxFileSize: number;
  readonly streamThreshold: number | undefined;
};

/** Apply defaults to an options bag (builder or plain object), then validate. */
export function resolveStaticOptions(options?: StaticFilesOptions): ResolvedStaticOptions {
  const resolvedOptions = (options ?? {}) as Partial<StaticFilesOptionsType>;
  const resolved: ResolvedStaticOptions = {
    indexFiles: resolvedOptions.indexFiles ?? ['index.html'],
    browse: resolvedOptions.browse ?? false,
    cacheControl: resolvedOptions.cacheControl,
    etag: resolvedOptions.etag ?? true,
    lastModified: resolvedOptions.lastModified ?? true,
    ranges: resolvedOptions.ranges ?? true,
    dotfiles: resolvedOptions.dotfiles ?? 'deny',
    symlinks: resolvedOptions.symlinks ?? 'within-root',
    contentTypes: resolvedOptions.contentTypes,
    contentType: resolvedOptions.contentType,
    maxFileSize: resolvedOptions.maxFileSize ?? 50 * 1024 * 1024,
    // No default: `undefined` is the "never stream" state, not a missing
    // number, so it must survive the spread rather than be filled in.
    streamThreshold: resolvedOptions.streamThreshold,
  };
  // Single consume-time gate shared by getFromFile / getFromDirectory.
  new StaticFilesOptionsValidator().validate(resolved);
  return resolved;
}
