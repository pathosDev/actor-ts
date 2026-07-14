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

const bag = (builder: object): Record<string, unknown> => ({ ...builder });

describe('option builders — every withX sets its field', () => {
  test('CorsOptions', () => {
    const builder = CorsOptions.create()
      .withOrigins('https://a.example', 'https://b.example')
      .withMethods('GET', 'POST')
      .withAllowedHeaders('x-a', 'x-b')
      .withExposedHeaders('x-c')
      .withCredentials()
      .withMaxAge(600);
    const fields = bag(builder);
    expect(fields.origins).toEqual(['https://a.example', 'https://b.example']);
    expect(fields.credentials).toBe(true);
    expect(fields.maxAge).toBe(600);
    // origin variants (each overwrites `origins`)
    expect(bag(CorsOptions.create().withAnyOrigin()).origins).toBe('*');
    const pred = (o: string): boolean => o === 'x';
    expect(bag(CorsOptions.create().withOriginPredicate(pred)).origins).toBe(pred);
  });

  test('CsrfOptions + SameOriginOptions', () => {
    const builder = CsrfOptions.create()
      .withSecret('a-very-long-secret-0123456789')
      .withCookieName('c')
      .withHeaderName('x-c')
      .withCookie({ secure: false, sameSite: 'strict' })
      .withVerifyOrigin(false)
      .withAllowedOrigins('https://a.example')
      .withFormField('_csrf');
    const fields = bag(builder);
    expect(fields.cookieName).toBe('c');
    expect(fields.headerName).toBe('x-c');
    expect(fields.verifyOrigin).toBe(false);
    expect(fields.formFieldName).toBe('_csrf');

    const so = SameOriginOptions.create().withAllowedOrigins('https://a.example').withAllowMissingOrigin();
    expect(bag(so).allowMissingOrigin).toBe(true);
  });

  test('HstsOptions', () => {
    const builder = HstsOptions.create().withMaxAge(100).withIncludeSubDomains(false).withPreload(false);
    const fields = bag(builder);
    expect(fields.maxAge).toBe(100);
    expect(fields.includeSubDomains).toBe(false);
    expect(fields.preload).toBe(false);
  });

  test('CspOptions', () => {
    const builder = CspOptions.create().withDirectives({ defaultSrc: ["'self'"] }).withoutDefaults().withReportOnly();
    const fields = bag(builder);
    expect(fields.useDefaults).toBe(false);
    expect(fields.reportOnly).toBe(true);
    expect(fields.directives).toEqual({ defaultSrc: ["'self'"] });
  });

  test('SecurityHeadersOptions', () => {
    const builder = SecurityHeadersOptions.create()
      .withContentTypeOptions(false)
      .withFrameOptions('SAMEORIGIN')
      .withReferrerPolicy('origin')
      .withPermissionsPolicy({ camera: [] })
      .withCrossOriginOpenerPolicy('unsafe-none')
      .withCrossOriginResourcePolicy('cross-origin')
      .withCrossOriginEmbedderPolicy('require-corp')
      .withXssProtection(false)
      .withHsts({ maxAge: 1 });
    const fields = bag(builder);
    expect(fields.frameOptions).toBe('SAMEORIGIN');
    expect(fields.crossOriginEmbedderPolicy).toBe('require-corp');
    expect(fields.contentTypeOptions).toBe(false);
  });

  test('RequestIdOptions', () => {
    const gen = (): string => 'x';
    const builder = RequestIdOptions.create().withHeaderName('x-id').withTrustIncoming(false).withGenerate(gen);
    const fields = bag(builder);
    expect(fields.headerName).toBe('x-id');
    expect(fields.trustIncoming).toBe(false);
    expect(fields.generate).toBe(gen);
  });

  test('BasicAuthOptions', () => {
    const validate = (): boolean => true;
    const builder = BasicAuthOptions.create().withUsers({ a: 'b' }).withValidate(validate).withRealm('r');
    const fields = bag(builder);
    expect(fields.users).toEqual({ a: 'b' });
    expect(fields.realm).toBe('r');
    expect(fields.validate).toBe(validate);
  });

  test('TimeoutOptions', () => {
    const onTimeout = (): HttpResponse => ({ status: Status.ServiceUnavailable, body: 'x' });
    const builder = TimeoutOptions.create().withMs(1234).withOnTimeout(onTimeout);
    const fields = bag(builder);
    expect(fields.ms).toBe(1234);
    expect(fields.onTimeout).toBe(onTimeout);
  });

  test('StaticFilesOptions', () => {
    const builder = StaticFilesOptions.create()
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
    const fields = bag(builder);
    expect(fields.indexFiles).toEqual(['a.html', 'b.html']);
    expect(fields.browse).toBe(true);
    expect(fields.dotfiles).toBe('allow');
    expect(fields.symlinks).toBe('follow');
    expect(fields.maxFileSize).toBe(1024);
    expect(fields.contentType).toBe('text/plain');
  });
});
