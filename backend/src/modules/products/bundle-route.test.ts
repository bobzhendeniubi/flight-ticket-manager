import { describe, expect, it } from 'vitest';
import {
  LEGACY_ROUTE_KEY,
  bundleRouteKey,
  parseRouteKey,
  resolveBundleRoute,
  routeKeyOf,
} from './bundle-route.js';

describe('bundle-route', () => {
  it('routeKeyOf 大写并去空格', () => {
    expect(routeKeyOf(' mfm', 'dad ')).toBe('MFM-DAD');
  });

  it('优先按去程航班派生', () => {
    const r = resolveBundleRoute({
      outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' },
      returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
    });
    expect(r).toEqual({ origin: 'MFM', destination: 'DAD', routeKey: 'MFM-DAD' });
  });

  it('只绑回程时按回程反推', () => {
    const r = resolveBundleRoute({
      outboundFlight: null,
      returnFlight: { originCode: 'KIX', destinationCode: 'MFM' },
    });
    expect(r).toEqual({ origin: 'MFM', destination: 'KIX', routeKey: 'MFM-KIX' });
  });

  it('没绑航班返回 null，不回落到旧航线', () => {
    expect(resolveBundleRoute({})).toBeNull();
    expect(bundleRouteKey({ outboundFlight: { originCode: null, destinationCode: 'DAD' } })).toBeNull();
  });

  it('parseRouteKey 只认 XXX-YYY', () => {
    expect(parseRouteKey('mfm-dad')).toEqual({ origin: 'MFM', destination: 'DAD' });
    expect(parseRouteKey('MFMDAD')).toBeNull();
    expect(parseRouteKey(null)).toBeNull();
    expect(parseRouteKey(LEGACY_ROUTE_KEY)).toEqual({ origin: 'MFM', destination: 'DAD' });
  });
});
