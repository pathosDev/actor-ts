/**
 * Options for the static-file directives.  Options-only (HTTP terminal
 * handlers have no ActorSystem at request time, so no HOCON layer).
 */
import { OptionsBuilder } from '../../util/OptionsBuilder.js';

/** Plain settings shape for the static-file directives. */
export interface StaticFilesOptionsType {
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
}

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
}

/** Accepted input: the builder or a plain object. */
export type StaticFilesOptions = StaticFilesOptionsBuilder | Partial<StaticFilesOptionsType>;
export const StaticFilesOptions = StaticFilesOptionsBuilder;

/** Fully-applied settings after defaults. */
export interface ResolvedStaticSettings {
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
}

/** Apply defaults to an options bag (builder or plain object). */
export function resolveStaticSettings(options?: StaticFilesOptions): ResolvedStaticSettings {
  const o = (options ?? {}) as Partial<StaticFilesOptionsType>;
  return {
    indexFiles: o.indexFiles ?? ['index.html'],
    browse: o.browse ?? false,
    cacheControl: o.cacheControl,
    etag: o.etag ?? true,
    lastModified: o.lastModified ?? true,
    ranges: o.ranges ?? true,
    dotfiles: o.dotfiles ?? 'deny',
    symlinks: o.symlinks ?? 'within-root',
    contentTypes: o.contentTypes,
    contentType: o.contentType,
    maxFileSize: o.maxFileSize ?? 50 * 1024 * 1024,
  };
}
