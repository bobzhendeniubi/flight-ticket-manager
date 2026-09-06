/**
 * 订票助手工具定义 buildTools · 单测（vitest，prisma 走 mock）。
 *
 * 只守一件事：search_hotels 的 cityCode 参数说明里的例子来自**在飞航线**，
 * 不是写死的某个目的地——写死的话，第二条航线一开就是在教模型去错的城市查酒店。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  flight: { findMany: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../modules/pricing/pricing.service.js', () => ({ PricingService: class {} }));
// env 在模块顶层加载并会 process.exit —— 单测只用到模型名，给一份最小配置即可。
vi.mock('../config/env.js', () => ({ env: { OPENAI_MODEL: 'test-model' } }));

import { buildTools, resetActiveRoutesCache } from './ai-assistant.js';

/** 取 search_hotels 的 cityCode 参数说明。 */
function cityCodeDescription(tools: Awaited<ReturnType<typeof buildTools>>): string {
  const tool = tools.find((t) => t.function.name === 'search_hotels');
  const params = tool?.function.parameters as
    | { properties?: { cityCode?: { description?: string } } }
    | undefined;
  return params?.properties?.cityCode?.description ?? '';
}

describe('buildTools · 城市码例子来自在飞航线', () => {
  beforeEach(() => {
    resetActiveRoutesCache();
    prismaMock.flight.findMany.mockReset();
  });

  it('按第一条在飞航线的目的地举例', async () => {
    prismaMock.flight.findMany.mockResolvedValue([{ originCode: 'MFM', destinationCode: 'DAD' }]);
    expect(cityCodeDescription(await buildTools())).toBe('城市代码，例 DAD(岘港)；省略 = 所有城市');
  });

  it('换一条航线，例子跟着换（不写死某个目的地）', async () => {
    prismaMock.flight.findMany.mockResolvedValue([{ originCode: 'CAN', destinationCode: 'KIX' }]);
    expect(cityCodeDescription(await buildTools())).toBe('城市代码，例 KIX(大阪)；省略 = 所有城市');
  });

  it('查不到在飞航线时不举例（不举例好过举错的例）', async () => {
    prismaMock.flight.findMany.mockResolvedValue([]);
    expect(cityCodeDescription(await buildTools())).toBe('城市代码；省略 = 所有城市');
  });

  it('其余工具原样返回，占位符不外泄', async () => {
    prismaMock.flight.findMany.mockResolvedValue([{ originCode: 'MFM', destinationCode: 'DAD' }]);
    const tools = await buildTools();
    expect(tools.map((t) => t.function.name)).toContain('search_flights');
    expect(JSON.stringify(tools)).not.toContain('{{CITY_CODE_EXAMPLE}}');
  });
});
