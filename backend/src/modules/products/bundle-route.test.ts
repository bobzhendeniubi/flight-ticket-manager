/**
 * 套餐航线派生 bundle-route · 纯函数单测（vitest，不连库）。
 *
 * 重点守住一条铁律：**派生不出航线时返回 null，绝不兜底到老航线**。
 * 兜底一旦回来，第二条航线的套餐会静默按老航线算库存和票价，线上看不出任何异常。
 */
import { describe, it, expect } from 'vitest';
import {
  LEGACY_ROUTE_KEY,
  bundleRouteKey,
  parseRouteKey,
  resolveBundleRoute,
  routeKeyOf,
} from './bundle-route.js';

describe('routeKeyOf / parseRouteKey', () => {
  it('routeKeyOf 拼成 origin-destination', () => {
    expect(routeKeyOf('MFM', 'KIX')).toBe('MFM-KIX');
  });

  it('parseRouteKey 是 routeKeyOf 的逆运算', () => {
    expect(parseRouteKey(routeKeyOf('MFM', 'KIX'))).toEqual({ origin: 'MFM', destination: 'KIX' });
  });

  it('parseRouteKey 对畸形输入返回 null（缺段 / 空段 / 非字符串）', () => {
    expect(parseRouteKey('MFM')).toBeNull();
    expect(parseRouteKey('MFM-KIX-NRT')).toBeNull();
    expect(parseRouteKey('-KIX')).toBeNull();
    expect(parseRouteKey('')).toBeNull();
    expect(parseRouteKey(null)).toBeNull();
    expect(parseRouteKey(undefined)).toBeNull();
  });

  it('LEGACY_ROUTE_KEY 仍是可解析的老航线键（只做识别用，不作兜底值）', () => {
    expect(parseRouteKey(LEGACY_ROUTE_KEY)).toEqual({ origin: 'MFM', destination: 'DAD' });
  });
});

describe('resolveBundleRoute', () => {
  it('绑了去程 → 用去程的 origin→destination', () => {
    expect(
      resolveBundleRoute({ outboundFlight: { originCode: 'MFM', destinationCode: 'KIX' } }),
    ).toEqual({ origin: 'MFM', destination: 'KIX', routeKey: 'MFM-KIX' });
  });

  it('去程与回程都绑 → 以去程为准（去程是唯一权威）', () => {
    expect(
      resolveBundleRoute({
        outboundFlight: { originCode: 'MFM', destinationCode: 'KIX' },
        // 回程数据即便对不上（脏数据），也不该动摇去程口径
        returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
      }),
    ).toMatchObject({ origin: 'MFM', destination: 'KIX' });
  });

  it('只绑回程 → 按回程反推去程方向', () => {
    expect(
      resolveBundleRoute({ returnFlight: { originCode: 'KIX', destinationCode: 'MFM' } }),
    ).toEqual({ origin: 'MFM', destination: 'KIX', routeKey: 'MFM-KIX' });
  });

  it('机场码大小写/空格不敏感（统一规范化成大写）', () => {
    expect(
      resolveBundleRoute({ outboundFlight: { originCode: ' mfm ', destinationCode: 'kix' } }),
    ).toEqual({ origin: 'MFM', destination: 'KIX', routeKey: 'MFM-KIX' });
  });

  it('两段都没绑 → null（**不兜底到老航线**）', () => {
    expect(resolveBundleRoute({})).toBeNull();
    expect(resolveBundleRoute({ outboundFlight: null, returnFlight: null })).toBeNull();
  });

  it('绑了航班但起降地缺失（脏数据）→ 按未绑处理，绝不半途拼出一条假航线', () => {
    expect(
      resolveBundleRoute({ outboundFlight: { originCode: 'MFM', destinationCode: null } }),
    ).toBeNull();
    expect(
      resolveBundleRoute({ outboundFlight: { originCode: '', destinationCode: 'KIX' } }),
    ).toBeNull();
  });

  it('去程脏数据但回程完好 → 回落到按回程反推（而不是直接判没航线）', () => {
    expect(
      resolveBundleRoute({
        outboundFlight: { originCode: 'MFM', destinationCode: null },
        returnFlight: { originCode: 'KIX', destinationCode: 'MFM' },
      }),
    ).toMatchObject({ origin: 'MFM', destination: 'KIX' });
  });
});

describe('bundleRouteKey', () => {
  it('有航线 → routeKey；没航线 → null（分桶/缓存键不能给未绑套餐编一个）', () => {
    expect(bundleRouteKey({ outboundFlight: { originCode: 'MFM', destinationCode: 'KIX' } })).toBe(
      'MFM-KIX',
    );
    expect(bundleRouteKey({})).toBeNull();
  });
});
