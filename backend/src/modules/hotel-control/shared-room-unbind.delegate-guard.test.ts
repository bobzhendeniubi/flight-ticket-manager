/**
 * shared-room-unbind.ts · sharedRoomMemberDelegate 的 mock-safe 回落守卫（L5 修复，批 10）。
 *
 * 只覆盖这一条：生产环境（NODE_ENV=production）+ tx 没有 sharedRoomMember delegate
 * （客户端初始化坏了）→ 直接抛错，不悄悄回落成「没有共享成员」；非生产环境（单测常用
 * 手搭 mock tx）维持原回落，不强制所有单测都换真库/完整替身。
 *
 * planUnbindMany / getSharedRoomStatesForItem 共用同一个内部 sharedRoomMemberDelegate
 * 取值 helper，两个公开入口各起一条用例，覆盖两处调用点。
 */
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { getSharedRoomStatesForItem, planUnbindMany } from './shared-room-unbind.js';

/** 不搭 sharedRoomMember delegate 的最小假 tx——模拟生产客户端初始化坏了的场景。 */
const txWithoutDelegate = {} as unknown as Prisma.TransactionClient;

describe('sharedRoomMemberDelegate 生产环境守卫（L5）', () => {
  it('planUnbindMany：生产环境缺 delegate → 抛错，不回落成空计划', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        planUnbindMany(txWithoutDelegate, { orderId: 'order-1', orderItemIds: ['item-1'] }),
      ).rejects.toThrow('sharedRoom delegate missing on production client');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('planUnbindMany：非生产环境缺 delegate → 维持回落成空计划，不抛错', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const plan = await planUnbindMany(txWithoutDelegate, {
        orderId: 'order-1',
        orderItemIds: ['item-1'],
      });
      expect(plan.changes).toEqual([]);
      expect(plan.nextRoomAssignment).toBeNull();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('getSharedRoomStatesForItem：生产环境缺 delegate → 抛错，不回落成空数组', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(getSharedRoomStatesForItem(txWithoutDelegate, 'order-1', 'item-1')).rejects.toThrow(
        'sharedRoom delegate missing on production client',
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('getSharedRoomStatesForItem：非生产环境缺 delegate → 维持回落成空数组，不抛错', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const states = await getSharedRoomStatesForItem(txWithoutDelegate, 'order-1', 'item-1');
      expect(states).toEqual([]);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
