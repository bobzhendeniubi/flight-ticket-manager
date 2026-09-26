/**
 * 订单列表「乘客姓名」贴名单筛选 · 真 DB 集成测试
 *
 * buildOrderFilterWhere 的 passengerName 分支由「一个乘客子查询里 OR 全部词」改成「能走三元组
 * 索引的词每词一个子查询、短词合成一个子查询，子查询间 OR」——只为让姓名三元组索引用得上。
 * 本测试把改前的写法原样留作参照，在真库上逐组名单比对两者命中的订单集合：三字名 / 两字名 /
 * 混贴 / 拼音短词 / 大小写 / 旧身份（换人前的姓名与证件号）/ 两字名是三字名的一部分 / 查无此人。
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/modules/orders/orders.passenger-name-filter.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { buildOrderFilterWhere, MAX_PASSENGER_NAME_TERMS, splitSearchTerms } from './orders.service.js';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type PaxSpec = { fullName: string; chineseName?: string; formerIdentities?: string };

async function createOrder(label: string, passengers: PaxSpec[]): Promise<string> {
  const order = await prisma.order.create({
    data: {
      orderNumber: uniq(label),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(500),
      total: new Prisma.Decimal(500),
      contactName: label,
      contactPhone: '13800138000',
      passengers: {
        create: passengers.map((p) => ({
          fullName: p.fullName,
          chineseName: p.chineseName ?? null,
          formerIdentities: p.formerIdentities ?? null,
          documentType: 'PASSPORT' as const,
          documentNumber: uniq('E'),
          nationality: 'CN',
          dateOfBirth: new Date('1990-01-01'),
        })),
      },
    },
  });
  return order.id;
}

/** 改前的写法：一个乘客子查询里 OR 全部词，原样保留作参照。*/
function legacyWhere(passengerName: string): Prisma.OrderWhereInput {
  const terms = splitSearchTerms(passengerName, MAX_PASSENGER_NAME_TERMS);
  return {
    AND: [
      {
        passengers: {
          some: {
            OR: terms.flatMap((term) => [
              { fullName: { contains: term, mode: 'insensitive' as const } },
              { chineseName: { contains: term, mode: 'insensitive' as const } },
              { formerIdentities: { contains: term, mode: 'insensitive' as const } },
            ]),
          },
        },
      },
    ],
  };
}

async function hitIds(where: Prisma.OrderWhereInput, scope: string[]): Promise<string[]> {
  const rows = await prisma.order.findMany({
    where: { AND: [where, { id: { in: scope } }] },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => r.id);
}

describe('乘客姓名贴名单筛选 · 分组子查询与「一个子查询 OR 全部词」命中同一批单', () => {
  it('三字名 / 两字名 / 混贴 / 拼音短词 / 大小写 / 旧身份 / 包含关系 / 查无此人，逐组一致', async () => {
    const ids = {
      hu: await createOrder('HU', [{ fullName: 'HU JIANPING', chineseName: '胡建平' }]),
      li: await createOrder('LI', [{ fullName: 'LI KANG', chineseName: '李康' }]),
      swapped: await createOrder('SW', [
        { fullName: 'ZHAO LIU', chineseName: '赵六', formerIdentities: '王五 WANG WU E7654321' },
      ]),
      pinyinOnly: await createOrder('PY', [{ fullName: 'LI NA' }]),
      group: await createOrder('GR', [
        { fullName: 'JIN LIJIN', chineseName: '靳李近' },
        { fullName: 'XIE BAYI', chineseName: '谢八一' },
      ]),
      contains: await createOrder('ZS', [{ fullName: 'ZHANG SANFENG', chineseName: '张三丰' }]),
      other: await createOrder('OT', [{ fullName: 'SUN QI', chineseName: '孙七' }]),
    };
    const scope = Object.values(ids);

    const lists = [
      '胡建平 李康',
      '李康 王五 张三',
      '胡建平，靳李近、谢八一',
      'LI NA',
      'li',
      'e7654321',
      '孙七 查无此人',
      '查无此人',
      '胡建平 李康 王五 LI NA 谢八一 张三 孙七 wang wu',
    ];
    for (const passengerName of lists) {
      const current = await hitIds(buildOrderFilterWhere({ passengerName }), scope);
      expect(current, passengerName).toEqual(await hitIds(legacyWhere(passengerName), scope));
    }

    // 钉几组期望值，防止参照实现和现行实现一起跑偏
    const hits = async (passengerName: string) =>
      new Set(await hitIds(buildOrderFilterWhere({ passengerName }), scope));
    expect(await hits('李康 王五 张三')).toEqual(new Set([ids.li, ids.swapped, ids.contains]));
    expect(await hits('胡建平，靳李近、谢八一')).toEqual(new Set([ids.hu, ids.group]));
    expect(await hits('e7654321')).toEqual(new Set([ids.swapped]));
    expect(await hits('查无此人')).toEqual(new Set());
  });
});
