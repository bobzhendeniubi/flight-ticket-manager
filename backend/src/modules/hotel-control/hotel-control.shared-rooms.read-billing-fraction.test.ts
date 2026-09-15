/**
 * readBillingFraction 单元测试（astra N12 回归修复）。
 *
 * 反例：`Number(null) === 0`——旧实现先转数字再判断，把普通组「真正没有显式值」的
 * `roomFraction: null` 误读成「显式 0」，回落缺省 1 的逻辑被绕过。必须先判断 nullish，
 * 再决定要不要转数字：null / 省略（undefined）都按缺省值回落（共享组 0、普通组 1），
 * 只有显式数值（含真正的 0）才原样保留。
 */
import { describe, it, expect } from 'vitest';
import { readBillingFraction } from './hotel-control.shared-rooms.js';

describe('readBillingFraction（房组计费份额读取，astra N12）', () => {
  describe('普通组（无 sharedRoomId）', () => {
    it('roomFraction 为 null → 按缺省 1（不是 0）', () => {
      expect(readBillingFraction({ roomFraction: null })).toBe(1);
    });

    it('roomFraction 省略（字段不存在）→ 按缺省 1', () => {
      expect(readBillingFraction({})).toBe(1);
    });

    it('roomFraction 显式为 0 → 原样保留 0（解绑后留下的历史值，不回落 1）', () => {
      expect(readBillingFraction({ roomFraction: 0 })).toBe(0);
    });

    it('roomFraction 显式为 0.5 → 原样保留', () => {
      expect(readBillingFraction({ roomFraction: 0.5 })).toBe(0.5);
    });
  });

  describe('共享组（带 sharedRoomId）', () => {
    it('roomFraction 为 null → 按缺省 0（不是把 null 读错成别的数）', () => {
      expect(readBillingFraction({ roomFraction: null, sharedRoomId: 's1' })).toBe(0);
    });

    it('roomFraction 省略 → 按缺省 0', () => {
      expect(readBillingFraction({ sharedRoomId: 's1' })).toBe(0);
    });

    it('roomFraction 显式为 0 → 原样保留 0（主单让份的明确值）', () => {
      expect(readBillingFraction({ roomFraction: 0, sharedRoomId: 's1' })).toBe(0);
    });

    it('roomFraction 显式为 1 → 原样保留', () => {
      expect(readBillingFraction({ roomFraction: 1, sharedRoomId: 's1' })).toBe(1);
    });
  });

  it('非数字、非 nullish 的脏值（如字符串 "abc"）→ 按缺省值回落，不是 NaN', () => {
    expect(readBillingFraction({ roomFraction: 'abc' })).toBe(1);
    expect(readBillingFraction({ roomFraction: 'abc', sharedRoomId: 's1' })).toBe(0);
  });
});
