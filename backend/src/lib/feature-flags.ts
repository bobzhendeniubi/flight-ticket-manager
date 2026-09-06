/**
 * Feature flag 基础库 —— 全部新行为默认关，开关存在 SystemSetting（零迁移）。
 *
 * 读法与 orders.service.ts 的 getSwapFeeOptions / hotel-control 超售上限同一套哲学：
 *   - DB 配置优先，缺记录 / 读失败 / 测试里没铺 systemSetting delegate 一律回落默认值
 *     （flag 库读挂了绝不能把业务功能一起带崩，只能悄悄按「关」处理）。
 *   - key 统一前缀 `feature.`，与其它用途的 SystemSetting key（如 orders.swapFeeOptionsCny）
 *     分区，避免撞键。
 *
 * 60 秒进程内缓存：flag 只在运维手动切换时变化，频率极低，没必要每次调用都查库；
 * PUT 写入后调用 invalidateFeatureFlagCache 让本进程立即感知（多副本部署下其它进程
 * 仍按最长 60 秒的陈旧窗口收敛，可接受）。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma.js';

export interface FeatureFlagDef {
  /** SystemSetting.key（含 `feature.` 前缀），落库与读取都用这个键 */
  key: string;
  /** 中文说明，给设置页展示用 */
  label: string;
  /** 默认值——上线当天必须是 false，运营确认口径后再手动开 */
  defaultEnabled: boolean;
}

/** Feature flag 注册表：新增开关在这里加一条即可，不需要建表/迁移。 */
export const FEATURE_FLAGS = {
  REMINDER_AUTO_GENERATE: {
    key: 'feature.REMINDER_AUTO_GENERATE',
    label: '提醒每日自动生成 —— 每天北京时间 08:30 自动跑一遍规则扫描并生成待办，无需人工点「生成今日提醒」',
    defaultEnabled: false,
  },
  REMINDER_WEBHOOK_PUSH: {
    key: 'feature.REMINDER_WEBHOOK_PUSH',
    label: '企业微信群推送 —— 提醒每日汇总 / 工单创建 / 履约任务指派 推送到企业微信群机器人',
    defaultEnabled: false,
  },
  REMINDER_BELL_ALL: {
    key: 'feature.REMINDER_BELL_ALL',
    label: '顶栏铃铛全覆盖 —— 除撤名单/退票三类工单外，铃铛再统计所有紧急/高优先级的规则提醒',
    defaultEnabled: false,
  },
} as const satisfies Record<string, FeatureFlagDef>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

const CACHE_TTL_MS = 60_000;
const cache = new Map<FeatureFlagKey, { value: boolean; expiresAt: number }>();

type FlagClient = PrismaClient | Prisma.TransactionClient;

function settingDelegate(client: FlagClient) {
  return (
    client as unknown as {
      systemSetting?: {
        findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null>;
        upsert: (args: {
          where: { key: string };
          create: { key: string; value: string; updatedById: string | null };
          update: { value: string; updatedById: string | null };
        }) => Promise<unknown>;
      };
    }
  ).systemSetting;
}

/**
 * 当前 flag 是否开启。client 缺省用全局 prisma；测试可传自己的 mock（没铺
 * systemSetting delegate 时回落默认值，不炸）。
 */
export async function isFeatureEnabled(
  client: FlagClient = defaultPrisma,
  key: FeatureFlagKey,
): Promise<boolean> {
  const def = FEATURE_FLAGS[key];
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const delegate = settingDelegate(client);
  let value: boolean = def.defaultEnabled;
  if (delegate) {
    try {
      const row = await delegate.findUnique({ where: { key: def.key } });
      if (row) value = row.value === 'true';
    } catch {
      // 读失败按默认值处理——flag 只是增强开关，不该拖垮调用方
      value = def.defaultEnabled;
    }
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** 清缓存：单个 key 或全部（不传 key）。PUT 写入后调用，本进程立即读到新值。 */
export function invalidateFeatureFlagCache(key?: FeatureFlagKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/** 写入 flag 值（PUT /settings/feature-flags/:key 用）；写完自动清本进程缓存。 */
export async function setFeatureFlag(
  client: PrismaClient,
  key: FeatureFlagKey,
  enabled: boolean,
  updatedById: string | null,
): Promise<void> {
  const def = FEATURE_FLAGS[key];
  const delegate = settingDelegate(client);
  if (!delegate) throw new Error('systemSetting delegate 不可用，无法写入 feature flag');
  await delegate.upsert({
    where: { key: def.key },
    create: { key: def.key, value: String(enabled), updatedById },
    update: { value: String(enabled), updatedById },
  });
  invalidateFeatureFlagCache(key);
}

export interface FeatureFlagView {
  key: FeatureFlagKey;
  label: string;
  enabled: boolean;
  default: boolean;
}

/** 列出全部 flag 当前状态（GET /settings/feature-flags 用）。 */
export async function listFeatureFlags(client: FlagClient = defaultPrisma): Promise<FeatureFlagView[]> {
  const keys = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];
  return Promise.all(
    keys.map(async (key) => ({
      key,
      label: FEATURE_FLAGS[key].label,
      enabled: await isFeatureEnabled(client, key),
      default: FEATURE_FLAGS[key].defaultEnabled,
    })),
  );
}

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}
