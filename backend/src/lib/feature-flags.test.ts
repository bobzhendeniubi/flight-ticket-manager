import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_FLAGS,
  invalidateFeatureFlagCache,
  isFeatureEnabled,
  isFeatureFlagKey,
  listFeatureFlags,
  setFeatureFlag,
} from './feature-flags.js';

function client(row: { value: string } | null = null) {
  return {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  invalidateFeatureFlagCache();
});

describe('feature-flags · 注册表', () => {
  it('三个 flag 全部默认 false', () => {
    for (const def of Object.values(FEATURE_FLAGS)) {
      expect(def.defaultEnabled).toBe(false);
    }
  });

  it('key 统一带 feature. 前缀', () => {
    for (const def of Object.values(FEATURE_FLAGS)) {
      expect(def.key.startsWith('feature.')).toBe(true);
    }
  });

  it('isFeatureFlagKey 只认注册表里的键', () => {
    expect(isFeatureFlagKey('REMINDER_AUTO_GENERATE')).toBe(true);
    expect(isFeatureFlagKey('NOT_A_REAL_FLAG')).toBe(false);
  });
});

describe('isFeatureEnabled · 读取与默认值', () => {
  it('没有 systemSetting delegate（测试 mock 缺省）→ 回落默认值 false，不炸', async () => {
    await expect(isFeatureEnabled({} as never, 'REMINDER_AUTO_GENERATE')).resolves.toBe(false);
  });

  it('库里没有记录 → 回落默认值 false', async () => {
    const db = client(null);
    await expect(isFeatureEnabled(db as never, 'REMINDER_WEBHOOK_PUSH')).resolves.toBe(false);
    expect(db.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { key: 'feature.REMINDER_WEBHOOK_PUSH' },
    });
  });

  it('库里 value="true" → 开启', async () => {
    const db = client({ value: 'true' });
    await expect(isFeatureEnabled(db as never, 'REMINDER_BELL_ALL')).resolves.toBe(true);
  });

  it('库里 value="false" → 关闭', async () => {
    const db = client({ value: 'false' });
    await expect(isFeatureEnabled(db as never, 'REMINDER_BELL_ALL')).resolves.toBe(false);
  });

  it('读库失败 → 回落默认值，不上抛', async () => {
    const db = { systemSetting: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) } };
    await expect(isFeatureEnabled(db as never, 'REMINDER_AUTO_GENERATE')).resolves.toBe(false);
  });
});

describe('isFeatureEnabled · 60 秒进程内缓存', () => {
  it('命中缓存不再查库', async () => {
    const db = client({ value: 'true' });
    await isFeatureEnabled(db as never, 'REMINDER_BELL_ALL');
    await isFeatureEnabled(db as never, 'REMINDER_BELL_ALL');
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidateFeatureFlagCache(key) 清单个键后重新查库', async () => {
    const db = client({ value: 'true' });
    await isFeatureEnabled(db as never, 'REMINDER_BELL_ALL');
    invalidateFeatureFlagCache('REMINDER_BELL_ALL');
    await isFeatureEnabled(db as never, 'REMINDER_BELL_ALL');
    expect(db.systemSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('不传 key 的 invalidateFeatureFlagCache() 清空全部', async () => {
    const dbA = client({ value: 'true' });
    const dbB = client({ value: 'true' });
    await isFeatureEnabled(dbA as never, 'REMINDER_AUTO_GENERATE');
    await isFeatureEnabled(dbB as never, 'REMINDER_WEBHOOK_PUSH');
    invalidateFeatureFlagCache();
    await isFeatureEnabled(dbA as never, 'REMINDER_AUTO_GENERATE');
    await isFeatureEnabled(dbB as never, 'REMINDER_WEBHOOK_PUSH');
    expect(dbA.systemSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(dbB.systemSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('setFeatureFlag 写入后自动清缓存，下次读到新值', async () => {
    const db = client({ value: 'false' });
    await expect(isFeatureEnabled(db as never, 'REMINDER_AUTO_GENERATE')).resolves.toBe(false);

    db.systemSetting.findUnique.mockResolvedValue({ value: 'true' });
    await setFeatureFlag(db as never, 'REMINDER_AUTO_GENERATE', true, 'user_1');

    expect(db.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'feature.REMINDER_AUTO_GENERATE' },
      create: { key: 'feature.REMINDER_AUTO_GENERATE', value: 'true', updatedById: 'user_1' },
      update: { value: 'true', updatedById: 'user_1' },
    });
    await expect(isFeatureEnabled(db as never, 'REMINDER_AUTO_GENERATE')).resolves.toBe(true);
  });
});

describe('listFeatureFlags', () => {
  it('返回全部三个 flag 的当前状态', async () => {
    const db = client({ value: 'true' });
    const views = await listFeatureFlags(db as never);
    expect(views).toHaveLength(3);
    expect(views.every((v) => v.enabled === true)).toBe(true);
    expect(views.map((v) => v.key).sort()).toEqual(
      ['REMINDER_AUTO_GENERATE', 'REMINDER_BELL_ALL', 'REMINDER_WEBHOOK_PUSH'].sort(),
    );
  });
});
