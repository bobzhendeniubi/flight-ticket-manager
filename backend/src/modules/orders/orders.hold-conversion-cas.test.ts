import { CabinClass, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { takeSeatWithinTx } from './orders.service.js';

describe('hold conversion seat CAS', () => {
  it('uses held seats after the conversion aggregate update in the final CAS', async () => {
    const calls: string[] = [];
    const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('cas');
      expect(values).toEqual([2, 'schedule_1', CabinClass.ECONOMY, 2, 3, 7]);
      expect(strings.join(' ')).toContain('sold +');
      return 1;
    });
    const tx = {
      $queryRaw: vi.fn(async () => {
        calls.push('lock');
        return [{ id: 'seat_1' }];
      }),
      seatLock: {
        aggregate: vi.fn(async () => {
          calls.push('other-locks');
          return { _sum: { qty: 3 } };
        }),
      },
      holdOrder: {
        aggregate: vi.fn(async () => {
          calls.push('updated-held');
          return { _sum: { seats: 10, seatsConverted: 3, seatsCancelled: 0 } };
        }),
      },
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;

    await takeSeatWithinTx(tx, 'schedule_1', CabinClass.ECONOMY, 2, null);

    expect(calls).toEqual(['lock', 'other-locks', 'updated-held', 'cas']);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});
