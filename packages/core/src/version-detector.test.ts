import { describe, expect, it } from 'vitest';
import type { VersioningConfig } from './types.js';
import { VersionDetector } from './version-detector.js';
import { VersionNormalizer } from './version-normalizer.js';

function createDetector(overrides?: Partial<VersioningConfig>) {
  const normalizer = new VersionNormalizer(
    [
      { name: 'v1', order: 1 },
      { name: 'v2', order: 2 },
      { name: 'v3', order: 3 },
      { name: 'v4', order: 4 },
    ],
    'v4',
  );
  return new VersionDetector(
    {
      sources: [
        { type: 'header', name: 'accept-version' },
        { type: 'header', name: 'api-version' },
        { type: 'path', pattern: /\/(v\d+)\/?/ },
        { type: 'query', name: 'api_version' },
      ],
      onMissing: 'use-default',
      onInvalid: 'reject',
      ...overrides,
    },
    normalizer,
    'v4',
  );
}

describe('VersionDetector', () => {
  it('detects version from X-API-Version header', () => {
    const detector = createDetector();
    const result = detector.detect({ 'api-version': 'v2' }, '/users', {});
    expect(result.version).toBe('v2');
    expect(result.source).toBe('header');
  });

  it('detects version from Accept-Version header', () => {
    const detector = createDetector();
    const result = detector.detect({ 'accept-version': 'v3' }, '/users', {});
    expect(result.version).toBe('v3');
    expect(result.source).toBe('header');
  });

  it('performs negotiation from Accept-Version with comma-separated values', () => {
    const detector = createDetector();
    const result = detector.detect({ 'accept-version': 'v2, v3' }, '/users', {});
    // highest-supported strategy picks the highest supported version
    expect(result.version).toBe('v3');
    expect(result.source).toBe('header');
  });

  it('detects version from URL path /v2/users', () => {
    const detector = createDetector();
    const result = detector.detect({}, '/v2/users', {});
    expect(result.version).toBe('v2');
    expect(result.source).toBe('path');
  });

  it('detects version from query param api_version=v2', () => {
    const detector = createDetector();
    const result = detector.detect({}, '/users', { api_version: 'v2' });
    expect(result.version).toBe('v2');
    expect(result.source).toBe('query');
  });

  it('returns default version when version is missing', () => {
    const detector = createDetector();
    const result = detector.detect({}, '/users', {});
    expect(result.version).toBe('v4');
    expect(result.source).toBe('default');
  });

  it('throws on invalid version with onInvalid=reject', () => {
    const detector = createDetector();
    expect(() => detector.detect({ 'api-version': 'v99' }, '/users', {})).toThrow(
      'Invalid API version',
    );
  });

  it('returns default on invalid version with onInvalid=use-default', () => {
    const detector = createDetector({ onInvalid: 'use-default' });
    const result = detector.detect({ 'api-version': 'v99' }, '/users', {});
    expect(result.version).toBe('v4');
  });

  it('negotiation picks highest supported version', () => {
    const detector = createDetector({
      negotiation: { strategy: 'highest-supported', onUnsupported: 'use-default' },
    });
    const result = detector.detect({ 'accept-version': 'v1, v3, v2' }, '/users', {});
    expect(result.version).toBe('v3');
  });

  it('negotiation throws on unsupported with onUnsupported=reject', () => {
    const detector = createDetector({
      negotiation: { strategy: 'highest-supported', onUnsupported: 'reject' },
    });
    expect(() => detector.detect({ 'accept-version': 'v99, v100' }, '/users', {})).toThrow(
      'No supported API version',
    );
  });

  it('onMissing=reject throws when no version found', () => {
    const detector = createDetector({ onMissing: 'reject' });
    expect(() => detector.detect({}, '/users', {})).toThrow('No API version found');
  });

  it('onMissing=use-oldest returns the oldest version', () => {
    const detector = createDetector({ onMissing: 'use-oldest' });
    const result = detector.detect({}, '/users', {});
    expect(result.version).toBe('v1');
    expect(result.source).toBe('default');
  });

  it('detects version from body field', () => {
    const detector = createDetector({
      sources: [
        { type: 'body', name: 'version' },
        { type: 'header', name: 'api-version' },
      ],
    });
    const result = detector.detect({}, '/users', {}, { version: 'v2' });
    expect(result.version).toBe('v2');
    expect(result.source).toBe('body');
  });

  it('checks sources in order: header > path > query > body', () => {
    const detector = createDetector();
    // All sources present — header should win
    const result = detector.detect({ 'api-version': 'v1' }, '/v2/users', { api_version: 'v3' });
    expect(result.version).toBe('v1');
  });
});
