import { describe, expect, it } from 'vitest';
import { contentMaxWidthClass, isContentUnbounded, isWidePagePath } from './layoutChrome';

describe('isWidePagePath', () => {
  it('订单管理页及其子路径算宽表页', () => {
    expect(isWidePagePath('/orders')).toBe(true);
    expect(isWidePagePath('/orders/abc')).toBe(true);
  });

  it('前缀相同但不是同一段的路径不算（/hold-orders、/orders-x）', () => {
    expect(isWidePagePath('/hold-orders')).toBe(false);
    expect(isWidePagePath('/orders-archive')).toBe(false);
    expect(isWidePagePath('/dashboard')).toBe(false);
  });
});

describe('isContentUnbounded', () => {
  it('侧栏展开的普通页面保持 1400 上限', () => {
    expect(isContentUnbounded({ sidebarCollapsed: false, pathname: '/products' })).toBe(false);
    expect(contentMaxWidthClass(false)).toBe('max-w-[1400px]');
  });

  it('侧栏收起后任何页面都去掉上限', () => {
    expect(isContentUnbounded({ sidebarCollapsed: true, pathname: '/products' })).toBe(true);
    expect(contentMaxWidthClass(true)).toBe('max-w-none');
  });

  it('订单页无论侧栏开合都不设上限', () => {
    expect(isContentUnbounded({ sidebarCollapsed: false, pathname: '/orders' })).toBe(true);
    expect(isContentUnbounded({ sidebarCollapsed: true, pathname: '/orders' })).toBe(true);
  });
});
