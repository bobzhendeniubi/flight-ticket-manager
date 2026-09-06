/**
 * Prisma 枚举镜像的漂移守卫
 *
 * @ftm/contracts 要能被两套 Vite 前端打进浏览器，所以它不能 import @prisma/client，
 * 枚举只能抄一份。抄来的东西迟早会跟源头分家 —— 这个测试就是那道闸：
 *
 *   · schema.prisma 里给某个枚举加了值、改了名、删了值，而 packages/contracts/src/enums.ts
 *     没跟上 → 这里立刻红，红在合并前而不是红在运营的下拉框里。
 *   · 反过来，契约包里凭空多抄了一个 Prisma 侧不存在的值，同样红。
 *
 * 断言的是**值集合相等**，不比顺序 —— Prisma 生成的对象是 { KEY: 'VALUE' } 形态，
 * 顺序对运行时没有意义；镜像文件里保持声明顺序只是为了 diff 好看。
 *
 * 新增枚举怎么办：先改 schema.prisma，再去 enums.ts 按三件套（XXX_VALUES /
 * xxxSchema / type Xxx）补一段，并在 PRISMA_ENUM_MIRRORS 索引表加一行。漏了索引表，
 * 下面「两侧枚举名对齐」那条会红。
 */
import { describe, it, expect } from 'vitest';
import * as PrismaNamespace from '@prisma/client';
import * as Mirrors from '@ftm/contracts/enums';
import { PRISMA_ENUM_MIRRORS } from '@ftm/contracts/enums';

/**
 * Prisma 生成的枚举在运行时是纯字符串对象（{ ADMIN: 'ADMIN', … }），而同名的 TS 类型
 * 只存在于编译期。@prisma/client 的导出里还混着 PrismaClient、Prisma 命名空间、
 * Decimal 之类的东西，所以这里按「键与值相等的纯字符串对象」把枚举挑出来。
 */
function isPrismaEnumObject(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([k, v]) => typeof v === 'string' && k === v);
}

const prismaEnums: Record<string, Record<string, string>> = {};
for (const [name, value] of Object.entries(PrismaNamespace as Record<string, unknown>)) {
  if (isPrismaEnumObject(value)) prismaEnums[name] = value;
}

describe('Prisma 枚举镜像 · @ftm/contracts 与 schema.prisma 不许分家', () => {
  it('挑出来的 Prisma 枚举不是空的（挑选逻辑本身没失效）', () => {
    expect(Object.keys(prismaEnums).length).toBeGreaterThan(40);
  });

  it('两侧枚举名对齐：Prisma 有的镜像都要有，镜像有的 Prisma 也要有', () => {
    const prismaNames = Object.keys(prismaEnums).sort();
    const mirrorNames = Object.keys(PRISMA_ENUM_MIRRORS).sort();
    expect(mirrorNames).toEqual(prismaNames);
  });

  // 逐个枚举一条用例：红的时候直接告诉你是哪个枚举漂了，不用在一坨 diff 里找。
  for (const [name, prismaEnum] of Object.entries(prismaEnums)) {
    it(`${name} 的值集合与 Prisma 完全一致`, () => {
      const mirror = (PRISMA_ENUM_MIRRORS as Record<string, readonly string[] | undefined>)[name];
      expect(mirror, `${name} 在 packages/contracts/src/enums.ts 里没有镜像`).toBeDefined();
      expect([...(mirror ?? [])].sort()).toEqual(Object.values(prismaEnum).sort());
    });
  }

  // 镜像还导出了与 Prisma 同名同形的值对象（{ KEY: 'KEY' }），让 `OrderStatus.CANCELLED`
  // 这种值引用能从契约包直接搬过来。形状不一致就不是 drop-in 了，一并对账。
  it('值对象与 Prisma 生成的对象逐键相等（drop-in 不能只是像）', () => {
    const asRecord = Mirrors as unknown as Record<string, unknown>;
    for (const [name, prismaEnum] of Object.entries(prismaEnums)) {
      expect(asRecord[name], `${name} 缺少同名值对象`).toEqual(prismaEnum);
    }
  });

  it('镜像里没有重复值（复制粘贴时手抖）', () => {
    for (const [name, values] of Object.entries(PRISMA_ENUM_MIRRORS)) {
      expect(new Set(values).size, `${name} 镜像里有重复值`).toBe(values.length);
    }
  });
});
