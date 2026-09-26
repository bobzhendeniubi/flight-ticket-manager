/**
 * 图片大字段的 Prisma `omit` 片段 —— 只读、且**不需要图片字节**的查询统一用它。
 *
 * 为什么要有：护照照片（Passenger.passportPhotoUrl）与收款 / 进账凭证（Payment.proofUrl /
 * Receipt.proofUrl）是整张图的 data URL 直接落库（单张约 270–300KB）。`passengers: true` /
 * `payments: true` / 不带 select 的 findMany 会把这几列一并从库里读回 Node：导一个月的全岗总表
 * 就是几百 MB，查询引擎还要把整份结果序列化成**一个**字符串经 napi 交回（导出整月 500 同根因），
 * 读库、传输、GC 全被拖慢，而导出 / 对账这些路径压根不用图。
 *
 * 用法（Prisma omitApi，schema.prisma 的 generator 已开预览；6.2 起 GA，语义不变）：
 *   include: { passengers: PASSENGERS_WITHOUT_PHOTO, payments: PAYMENTS_WITHOUT_PROOF }
 *   prisma.receipt.findMany({ where, omit: RECEIPT_PROOF_OMIT })
 * omit 只去掉点名的那一列，其余列照旧全取 —— 以后加列不会像显式 select 那样被漏选。
 *
 * 只在「确认只读、不需要字节」的查询上逐处加，**不要做成全局 omit**（PrismaClient 构造参数）：
 * 拆单 / 换人会把整行乘客展开复制进新行，全局 omit 会让照片被静默丢掉。需要字节的路径
 *（护照包 / 签证资料包 / 房控护照包 / 签证台按单取图 / 收款凭证查看 / 后台订单详情缩略图）照旧整列读。
 */
import { Prisma, type Passenger } from '@prisma/client';

/** 本模块管的图片大字段（按模型）。*/
export const HEAVY_COLUMNS: Readonly<Partial<Record<Prisma.ModelName, readonly string[]>>> = {
  Passenger: ['passportPhotoUrl'],
  Payment: ['proofUrl'],
  Receipt: ['proofUrl'],
};

/** Passenger 行不读护照照片。*/
export const PASSENGER_PHOTO_OMIT = { passportPhotoUrl: true } satisfies Prisma.PassengerOmit;

/** Payment 行不读收款凭证图。*/
export const PAYMENT_PROOF_OMIT = { proofUrl: true } satisfies Prisma.PaymentOmit;

/** Receipt 行不读进账凭证图。*/
export const RECEIPT_PROOF_OMIT = { proofUrl: true } satisfies Prisma.ReceiptOmit;

/** 不带护照照片列的乘客行（按上面的 omit 取回来的形态）；只读姓名 / 证件等字段的函数按它收参。*/
export type PassengerWithoutPhoto = Omit<Passenger, keyof typeof PASSENGER_PHOTO_OMIT>;

/** 关系 include 片段：订单的乘客取全部列，唯独不读护照照片（替代 `passengers: true`）。*/
export const PASSENGERS_WITHOUT_PHOTO = {
  omit: PASSENGER_PHOTO_OMIT,
} satisfies Prisma.Order$passengersArgs;

/** 关系 include 片段：订单的收款取全部列，唯独不读凭证图（替代 `payments: true`）。*/
export const PAYMENTS_WITHOUT_PROOF = {
  omit: PAYMENT_PROOF_OMIT,
} satisfies Prisma.Order$paymentsArgs;

/** 模型 → { 关系字段名 → 目标模型 }，按 DMMF 懒建一次。*/
let relationIndex: Map<string, Map<string, Prisma.ModelName>> | null = null;

function relationsOf(model: Prisma.ModelName): Map<string, Prisma.ModelName> {
  if (!relationIndex) {
    relationIndex = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [
        m.name,
        new Map(
          m.fields
            .filter((f) => f.kind === 'object')
            .map((f) => [f.name, f.type as Prisma.ModelName] as const),
        ),
      ]),
    );
  }
  return relationIndex.get(model) ?? new Map();
}

interface ReadShapeArgs {
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  omit?: Record<string, unknown>;
}

/**
 * 一次查询会从库里读回哪些图片大字段 —— 返回字段路径（如 `order.passengers.passportPhotoUrl`），
 * 空数组 = 一列都不读。口径与 Prisma 取数规则一致（按 DMMF 认关系）：
 *   - 带 select：只看 select 点名的列；关系写 `true` = 目标模型的全部标量列。
 *   - 不带 select：全部标量列减去 omit 点名的列；include 里的关系同理递归。
 * 用来在单测里锁住「导出 / 对账这类路径不读图」（对捕获到的查询参数断言），不参与任何业务判断。
 */
export function heavyColumnReads(model: Prisma.ModelName, args: unknown, path = ''): string[] {
  const shape = (args ?? {}) as ReadShapeArgs;
  const heavy = HEAVY_COLUMNS[model] ?? [];
  const relations = relationsOf(model);
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  const found: string[] = [];
  const visitRelation = (key: string, value: unknown): void => {
    const target = relations.get(key);
    // _count 之类不是关系字段；false / undefined 不取
    if (!target || !value) return;
    found.push(...heavyColumnReads(target, value === true ? {} : value, at(key)));
  };

  if (shape.select) {
    for (const [key, value] of Object.entries(shape.select)) {
      if (!value) continue;
      if (heavy.includes(key)) found.push(at(key));
      else visitRelation(key, value);
    }
    return found;
  }
  for (const column of heavy) {
    if (shape.omit?.[column] !== true) found.push(at(column));
  }
  for (const [key, value] of Object.entries(shape.include ?? {})) visitRelation(key, value);
  return found;
}
