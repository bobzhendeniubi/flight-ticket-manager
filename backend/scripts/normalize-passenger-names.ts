/**
 * 存量脏格式乘客姓名清洗（一次性脚本）。
 *
 * 背景：backend/src/lib/passenger-name.ts 的 normalizePassengerFullName 已接入
 * 下单 / 换人入口（orders.schemas.ts），新录入的姓名不再脏；但历史库里仍留有脏
 * 格式（实锤 `ZHENG,/QINQIN`），污染护照导出等名单。本脚本一次性扫描并清洗：
 *   - Passenger.fullName / lastName / firstName（各自独立规范化，
 *     lastName/firstName 不做斜线拼接——与 swapPassengerBodySchema 同口径）
 *   - TravelerProfile.fullName
 * chineseName 等中文字段不动。变更计算的纯逻辑见
 * backend/src/lib/passenger-name-migration.ts（该文件有独立单测）。
 *
 * 默认 dry-run：只打印每条 `model id | field | 原值 → 新值` 和汇总计数，不写库。
 * 加 --apply 才真正写库（每 100 条一个事务，Passenger/TravelerProfile 分别成批）。
 * 单行处理失败不会中断整体扫描——失败会收集起来，最后统一打印。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/normalize-passenger-names.ts          # dry-run
 *   npx tsx scripts/normalize-passenger-names.ts --apply  # 真正写库
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量（本脚本不硬编码、不额外读取连接串）。
 * 本地：用 backend/.env 里的 DATABASE_URL，或指向 docker-compose.test.yml 起的
 * ftm-postgres-test（端口 55432）。staging / 生产：连接串来自对应环境的 DATABASE_URL，
 * 对生产库操作前务必先 dry-run 看变更集是否符合预期，再 --apply。
 *
 * 建议流程：dry-run 存证 → --apply → 再 dry-run 复核（应为 0 条待改）。
 */
import { PrismaClient } from '@prisma/client';
import {
  computePassengerNameChanges,
  computeTravelerProfileNameChanges,
  type NameFieldChange,
} from '../src/lib/passenger-name-migration.js';

const prisma = new PrismaClient();
const BATCH_SIZE = 100;

interface RowError {
  model: string;
  id: string;
  message: string;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function logChange(model: string, id: string, change: NameFieldChange): void {
  // eslint-disable-next-line no-console
  console.log(
    `${model} ${id} | ${change.field} | ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`,
  );
}

async function flushPassengerBatch(
  batch: ReadonlyArray<{ id: string; data: Record<string, string> }>,
  errors: RowError[],
): Promise<void> {
  if (batch.length === 0) return;
  try {
    await prisma.$transaction(
      batch.map((b) => prisma.passenger.update({ where: { id: b.id }, data: b.data })),
    );
  } catch (error: unknown) {
    for (const b of batch) {
      errors.push({ model: 'Passenger', id: b.id, message: getErrorMessage(error) });
    }
  }
}

async function flushTravelerProfileBatch(
  batch: ReadonlyArray<{ id: string; fullName: string }>,
  errors: RowError[],
): Promise<void> {
  if (batch.length === 0) return;
  try {
    await prisma.$transaction(
      batch.map((b) =>
        prisma.travelerProfile.update({ where: { id: b.id }, data: { fullName: b.fullName } }),
      ),
    );
  } catch (error: unknown) {
    for (const b of batch) {
      errors.push({ model: 'TravelerProfile', id: b.id, message: getErrorMessage(error) });
    }
  }
}

async function processPassengers(apply: boolean, errors: RowError[]): Promise<number> {
  const rows = await prisma.passenger.findMany({
    select: { id: true, fullName: true, lastName: true, firstName: true },
  });

  let changedCount = 0;
  let batch: Array<{ id: string; data: Record<string, string> }> = [];

  for (const row of rows) {
    let changes: NameFieldChange[];
    try {
      changes = computePassengerNameChanges(row);
    } catch (error: unknown) {
      errors.push({ model: 'Passenger', id: row.id, message: getErrorMessage(error) });
      continue;
    }
    if (changes.length === 0) continue;

    changedCount += 1;
    for (const change of changes) {
      logChange('Passenger', row.id, change);
    }

    if (apply) {
      const data = Object.fromEntries(changes.map((c) => [c.field, c.to]));
      batch.push({ id: row.id, data });
      if (batch.length >= BATCH_SIZE) {
        await flushPassengerBatch(batch, errors);
        batch = [];
      }
    }
  }

  if (apply) await flushPassengerBatch(batch, errors);
  return changedCount;
}

async function processTravelerProfiles(apply: boolean, errors: RowError[]): Promise<number> {
  const rows = await prisma.travelerProfile.findMany({
    select: { id: true, fullName: true },
  });

  let changedCount = 0;
  let batch: Array<{ id: string; fullName: string }> = [];

  for (const row of rows) {
    let changes: NameFieldChange[];
    try {
      changes = computeTravelerProfileNameChanges(row);
    } catch (error: unknown) {
      errors.push({ model: 'TravelerProfile', id: row.id, message: getErrorMessage(error) });
      continue;
    }
    if (changes.length === 0) continue;

    changedCount += 1;
    for (const change of changes) {
      logChange('TravelerProfile', row.id, change);
    }

    if (apply) {
      const fullNameChange = changes.find((c) => c.field === 'fullName');
      if (fullNameChange) {
        batch.push({ id: row.id, fullName: fullNameChange.to });
        if (batch.length >= BATCH_SIZE) {
          await flushTravelerProfileBatch(batch, errors);
          batch = [];
        }
      }
    }
  }

  if (apply) await flushTravelerProfileBatch(batch, errors);
  return changedCount;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const errors: RowError[] = [];

  // eslint-disable-next-line no-console
  console.log(
    `[normalize-passenger-names] 模式: ${apply ? 'APPLY（真正写库）' : 'DRY-RUN（仅打印，不写库）'}`,
  );

  const passengerChanged = await processPassengers(apply, errors);
  const travelerChanged = await processTravelerProfiles(apply, errors);

  // eslint-disable-next-line no-console
  console.log(
    `[normalize-passenger-names] 汇总 — Passenger 待改行数:${passengerChanged}` +
      ` TravelerProfile 待改行数:${travelerChanged}` +
      (apply ? '（已写库）' : '（dry-run，未写库；加 --apply 真正执行）'),
  );

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`[normalize-passenger-names] ${errors.length} 条处理失败:`);
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.error(`  ${e.model} ${e.id}: ${e.message}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[normalize-passenger-names] 致命错误:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
