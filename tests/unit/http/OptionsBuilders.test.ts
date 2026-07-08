/**
 * Exercises every `withX` method on the HTTP options builders introduced
 * with the security-middleware + static-file work. A builder IS its
 * settings (each `withX` writes an own enumerable field), so we chain all
 * methods and read the fields back.
 */
import { describe, expect, test } from 'bun:test';
import {
  BasicAuthOptions,
  CorsOptions,
  CspOptions,
  CsrfOptions,
  HstsOptions,
  RequestIdOptions,
  SameOriginOptions,
  SecurityHeadersOptions,
  StaticFilesOptions,
  TimeoutOptions,
  Status,
  type HttpResponse,
} from '../../../src/http/index.js';

const bag = (b: object): Record<string, unknown> => ({ ...b });

describe('option builders — every withX sets its field', () => {
  test('CorsOptions', () => {
    const b = CorsOptions.create()
      .withOrigins('https://a.example', 'https://b.example')
      .withMethods('GET', 'POST')
      .withAllowedHeaders('x-a', 'x-b')
      .withExposedHeaders('x-c')
      .withCredentials()
      .withMaxAge(600);
    const s = bag(b);
    expect(s.origins).toEqual(['https://a.example', 'https://b.example']);
    expect(s.credentials).toBe(true);
    expect(s.maxAge).toBe(600);
    // origin variants (each overwrites `origins`)
    expect(bag(CorsOptions.create().withAnyOrigin()).origins).toBe('*');
    const pred = (o: string): boolean => o === 'x';
    expect(bag(CorsOptions.create().withOriginPredicate(pred)).origins).toBe(pred);
  });

  test('CsrfOptions + SameOriginOptions', () => {
    const b = CsrfOptions.create()
      .withSecret('a-very-long-secret-0123456789')
      .withCookieName('c')
      .withHeaderName('x-c')
      .withCookie({ secure: false, sameSite: 'strict' })
      .withVerifyOrigin(false)
      .withAllowedOrigins('https://a.example')
      .withFormField('_csrf');
    const s = bag(b);
    expect(s.cookieName).toBe('c');
    expect(s.headerName).toBe('x-c');
    expect(s.verifyOrigin).toBe(false);
    expect(s.formFieldName).toBe('_csrf');

    const so = SameOriginOptions.create().withAllowedOrigins('https://a.example').withAllowMissingOrigin();
    expect(bag(so).allowMissingOrigin).toBe(true);
  });

  test('HstsOptions', () => {
    const b = HstsOptions.create().withMaxAge(100).withIncludeSubDomains(false).withPreload(false);
    const s = bag(b);
    expect(s.maxAge).toBe(100);
    expect(s.includeSubDomains).toBe(false);
    expect(s.preload).toBe(false);
  });

  test('CspOptions', () => {
    const b = CspOptions.create().withDirectives({ defaultSrc: ["'self'"] }).withoutDefaults().withReportOnly();
    const s = bag(b);
    expect(s.useDefaults).toBe(false);
    expect(s.reportOnly).toBe(true);
    expect(s.directives).toEqual({ defaultSrc: ["'self'"] });
  });

  test('SecurityHeadersOptions', () => {
    const b = SecurityHeadersOptions.create()
      .withContentTypeOptions(false)
      .withFrameOptions('SAMEORIGIN')
      .withReferrerPolicy('origin')
      .withPermissionsPolicy({ camera: [] })
      .withCrossOriginOpenerPolicy('unsafe-none')
      .withCrossOriginResourcePolicy('cross-origin')
      .withCrossOriginEmbedderPolicy('require-corp')
      .withXssProtection(false)
      .withHsts({ maxAge: 1 });
    const s = bag(b);
    expect(s.frameOptions).toBe('SAMEORIGIN');
    expect(s.crossOriginEmbedderPolicy).toBe('require-corp');
    expect(s.contentTypeOptions).toBe(false);
  });

  test('RequestIdOptions', () => {
    const gen = (): string => 'x';
    const b = RequestIdOptions.create().withHeaderName('x-id').withTrustIncoming(false).withGenerate(gen);
    const s = bag(b);
    expect(s.headerName).toBe('x-id');
    expect(s.trustIncoming).toBe(false);
    expect(s.generate).toBe(gen);
  });

  test('BasicAuthOptions', () => {
    const validate = (): boolean => true;
    const b = BasicAuthOptions.create().withUsers({ a: 'b' }).withValidate(validate).withRealm('r');
    const s = bag(b);
    expect(s.users).toEqual({ a: 'b' });
    expect(s.realm).toBe('r');
    expect(s.validate).toBe(validate);
  });

  test('TimeoutOptions', () => {
    const onTimeout = (): HttpResponse => ({ status: Status.ServiceUnavailable, body: 'x' });
    const b = TimeoutOptions.create().withMs(1234).withOnTimeout(onTimeout);
    const s = bag(b);
    expect(s.ms).toBe(1234);
    expect(s.onTimeout).toBe(onTimeout);
  });

  test('StaticFilesOptions', () => {
    const b = StaticFilesOptions.create()
      .withIndexFiles('a.html', 'b.html')
      .withBrowse()
      .withCacheControl('max-age=60')
      .withEtag(false)
      .withLastModified(false)
      .withRanges(false)
      .withDotfiles('allow')
      .withSymlinks('follow')
      .withContentTypes({ foo: 'text/foo' })
      .withContentType('text/plain')
      .withMaxFileSize(1024);
    const s = bag(b);
    expect(s.indexFiles).toEqual(['a.html', 'b.html']);
    expect(s.browse).toBe(true);
    expect(s.dotfiles).toBe('allow');
    expect(s.symlinks).toBe('follow');
    expect(s.maxFileSize).toBe(1024);
    expect(s.contentType).toBe('text/plain');
  });
});
