/**
 * 财务核实运营水单登记 · 单元测试（vitest，fake prisma）
 *
 * 盯一处并发口径：交易流水号的「先查后写」只看得见事务开始前的行 —— 两个人几乎同时给
 * 两笔不同的登记填同一个流水号，两边都查到「没占用」，后提交的那笔会撞唯一索引（P2002）。
 * 那时候必须回 409 + 人话，而不是裸 500（数据本身由唯一索引保住，但前端看不出发生了什么）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const receiptFindUnique = vi.fn();
const receiptUpdate = vi.fn();
const transaction = vi.fn();

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    receipt: {
      findUnique: (...args: unknown[]) => receiptFindUnique(...args),
      update: (...args: unknown[]) => receiptUpdate(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));
// 审计是异步旁路，本用例不关心：mock 掉免得去连库。
vi.mock('../../lib/audit.js', () => ({ writeAudit: vi.fn() }));

import { Prisma, PaymentMethod, ReceiptSource, ReceiptStatus, UserRole } from '@prisma/client';
import { ReceiptsService } from './receipts.service.js';

const service = new ReceiptsService();
const FINANCE = { userId: 'u-finance', role: UserRole.STAFF };

function claimRow() {
  return {
    id: 'r-1',
    receiptNo: 'RCP2026090100001',
    source: ReceiptSource.OPS_CLAIM,
    status: ReceiptStatus.OPEN,
    amountCny: new Prisma.Decimal(5000),
    method: PaymentMethod.BANK_CARD,
    externalTxnId: null,
    verifiedAt: null,
    verifiedById: null,
    createdById: 'u-ops',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      receipt: {
        findUnique: (...args: unknown[]) => receiptFindUnique(...args),
        update: (...args: unknown[]) => receiptUpdate(...args),
      },
    }),
  );
});

describe('verifyClaimReceipt · 交易流水号并发占用', () => {
  it('写入撞唯一索引（P2002）→ 回 409 人话，不再是裸 500', async () => {
    // 查重时还没人占（并发那笔尚未提交），写入时才撞上。
    receiptFindUnique.mockImplementation(async (args: { where: { id?: string } }) =>
      args.where.id ? claimRow() : null,
    );
    receiptUpdate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['externalTxnId'] },
      }),
    );

    await expect(
      service.verifyClaimReceipt('r-1', { externalTxnId: 'TXN-9001' }, FINANCE),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.verifyClaimReceipt('r-1', { externalTxnId: 'TXN-9001' }, FINANCE),
    ).rejects.toThrow(/TXN-9001/);
  });

  it('查重就发现流水号被占 → 照旧 409（这条口径不变）', async () => {
    receiptFindUnique.mockImplementation(async (args: { where: { id?: string } }) =>
      args.where.id ? claimRow() : { id: 'r-other', receiptNo: 'RCP2026090100002' },
    );

    await expect(
      service.verifyClaimReceipt('r-1', { externalTxnId: 'TXN-9001' }, FINANCE),
    ).rejects.toThrow(/已登记在进账 RCP2026090100002/);
    expect(receiptUpdate).not.toHaveBeenCalled();
  });

  it('没填流水号时的其它数据库错误原样抛出（不冒充流水号冲突）', async () => {
    receiptFindUnique.mockResolvedValue(claimRow());
    receiptUpdate.mockRejectedValue(new Error('db down'));

    await expect(
      service.verifyClaimReceipt('r-1', { externalTxnId: null }, FINANCE),
    ).rejects.toThrow('db down');
  });

  it('正常核实 → 写 verifiedAt / 核实人 / 流水号（首尾空格照旧裁掉）', async () => {
    receiptFindUnique.mockImplementation(async (args: { where: { id?: string } }) =>
      args.where.id ? claimRow() : null,
    );
    receiptUpdate.mockResolvedValue({});

    const result = await service.verifyClaimReceipt(
      'r-1',
      { externalTxnId: ' TXN-9001 ' },
      FINANCE,
    );

    expect(result.ok).toBe(true);
    expect(result.receiptNo).toBe('RCP2026090100001');
    const updateArgs = receiptUpdate.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'r-1' });
    expect(updateArgs.data.externalTxnId).toBe('TXN-9001');
    expect(updateArgs.data.verifiedById).toBe('u-finance');
    expect(updateArgs.data.verifiedAt).toBeInstanceOf(Date);
  });
});
