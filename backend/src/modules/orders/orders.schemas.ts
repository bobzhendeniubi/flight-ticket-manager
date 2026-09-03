import { z } from 'zod';
import {
  CabinClass,
  DocumentType,
  Gender,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  UserRole,
  VisaRequirement,
} from '@prisma/client';
import { normalizePassengerFullName } from '../../lib/passenger-name.js';
import { COUNTRY_ALPHA3_TO_ALPHA2 } from '../../lib/country-codes.js';

// 团队议价结算价上限（CNY/人）。防误输天价；正常机票远低于此。
export const SETTLEMENT_PRICE_CAP_CNY = 100_000;

// 售后费用（改期费/换人费）上限（CNY）。防误输天价；正常售后费远低于此。
export const POST_SALE_FEE_CAP_CNY = 100_000;

// ── 录单调价/加项（ADMIN/STAFF 录单专用）──────────────────────────────────
// 业务场景：录单时有优惠 / 补收杂费 / 行程变更改期费等需要在系统权威价上手工加减金额。
// 此处只承载「一笔调整」的金额 + 原因；不放开裸手填整单价（服务端权威定价仍是安全底线）。
// 金额（CNY，整数）可正（加钱）可负（减价/优惠），0 无意义 → 拒绝。
//
// 原因收窄为纯财务类：升舱/升级酒店/签证改多签曾经也在这个下拉里，但会造成运营隐形——
// 升舱不占套餐结构化商务舱库存、升级酒店不走「换酒店」（房控看不到）、改多签不换签证产品
// （签证岗看不到）。这三类改动必须走各自的结构化功能，不能再通过调价旁路，故从可录入枚举
// 中移除；升舱/单人入住用套餐加购，换酒店用订单详情「换酒店」，改多签需更换签证产品。
export const PRICE_ADJUSTMENT_CAP_CNY = 100_000;

// 可录入原因（当前）：仅财务口径的四类。
export const PRICE_ADJUSTMENT_REASON = [
  'DISCOUNT', // 优惠
  'MISC_FEE', // 补收杂费
  'CHANGE', // 变更改期费
  'OTHER', // 其它（配合 reasonText）
] as const;
export type PriceAdjustmentReason = (typeof PRICE_ADJUSTMENT_REASON)[number];

// 历史全集（含已下线、不再允许新录入的原因值）——仅用于展示旧订单行 label，避免老数据
// 的 metadata.reasonCode 在 label 查找时变成 undefined。新录入一律走上面收窄后的枚举。
export const PRICE_ADJUSTMENT_REASON_LEGACY = [
  'UPGRADE_CABIN', // 升舱（已下线，历史展示用）
  'UPGRADE_HOTEL', // 升级酒店（已下线，历史展示用）
  'VISA_MULTI', // 签证改多签（已下线，历史展示用）
] as const;

// 专用端点产生、不在录单可选枚举里的 reasonCode（仅用于行 label 展示）。
// ROOM_DIFF「补收单房差」走订单详情专用「补收单房差」通道（POST /orders/:id/room-supplement），
// 不通过录单调价旁路——口径同升级酒店必须走「换酒店」：结构化改动不走调价，避免运营隐形。
export const PRICE_ADJUSTMENT_REASON_ENDPOINT_ONLY = [
  'ROOM_DIFF', // 补收单房差（由 room-supplement 端点产生，展示用）
  // 代理结算价：录单填「本单结算总价」（settlementTotalCny）时由系统按「结算价 − 权威合计」
  // 自动生成的差额行。**只能系统生成**，不进人工调价下拉（PRICE_ADJUSTMENT_REASON 不含它）。
  'SETTLEMENT',
  // 取消航段手续费：由「取消航段」端点（POST /orders/:id/cancel-leg）按取消政策
  // （或带原因的手工覆盖）生成。去程/回程各一个码，好让行 label 直接说清取消的是哪一段。
  // **只能系统生成**，不进人工调价下拉。
  'RETURN_LEG_CANCEL_FEE',
  'OUTBOUND_LEG_CANCEL_FEE',
] as const;

export type PriceAdjustmentReasonDisplay =
  | PriceAdjustmentReason
  | (typeof PRICE_ADJUSTMENT_REASON_LEGACY)[number]
  | (typeof PRICE_ADJUSTMENT_REASON_ENDPOINT_ONLY)[number];

export const PRICE_ADJUSTMENT_REASON_LABEL: Record<PriceAdjustmentReasonDisplay, string> = {
  DISCOUNT: '优惠',
  MISC_FEE: '补收杂费',
  CHANGE: '变更改期费',
  OTHER: '其它',
  UPGRADE_CABIN: '升舱',
  UPGRADE_HOTEL: '升级酒店',
  VISA_MULTI: '签证改多签',
  ROOM_DIFF: '补收单房差',
  SETTLEMENT: '代理结算价',
  RETURN_LEG_CANCEL_FEE: '取消回程手续费',
  OUTBOUND_LEG_CANCEL_FEE: '取消去程手续费',
};

// 调价金额校验（录单调价与「按乘客/整单事后调价」共用同一口径，避免两处漂移）：
//   可正（加钱）可负（减价），整数 CNY；0 无意义（不调整就别传该字段）；|金额| ≤ 上限。
const priceAdjustmentAmountSchema = z
  .number()
  .int('调整金额必须为整数（CNY）')
  .refine((v) => v !== 0, { message: '调整金额不能为 0（不调整请勿传该字段）' })
  .refine((v) => Math.abs(v) <= PRICE_ADJUSTMENT_CAP_CNY, {
    message: `调整金额超出上限（±${PRICE_ADJUSTMENT_CAP_CNY}）`,
  });

// 「其它」必须补一句文本，避免出现无从追溯的匿名调价。录单调价与事后调价共用同一 refine。
const requireReasonTextForOther = (v: { reasonCode: string; reasonText?: string }): boolean =>
  v.reasonCode !== 'OTHER' || Boolean(v.reasonText?.trim());
const REASON_TEXT_REQUIRED_MSG: { message: string; path: (string | number)[] } = {
  message: '选择「其它」时必须填写调整原因说明',
  path: ['reasonText'],
};

export const priceAdjustmentSchema = z
  .object({
    amountCny: priceAdjustmentAmountSchema,
    reasonCode: z.enum(PRICE_ADJUSTMENT_REASON),
    reasonText: z.string().max(200).optional(),
  })
  .refine(requireReasonTextForOther, REASON_TEXT_REQUIRED_MSG);
type PublicPriceAdjustmentInput = z.infer<typeof priceAdjustmentSchema>;
/**
 * 价格调整的服务端内部载荷。
 * stackWithSettlementCalendar 只允许 batchCreateOrders 的优惠路径注入；它不在
 * priceAdjustmentSchema 中，因此 createOrderBodySchema 解析外部 HTTP 请求时会 strip 掉。
 */
export type PriceAdjustmentInput = PublicPriceAdjustmentInput & {
  stackWithSettlementCalendar?: boolean;
};

// 事后调价（POST /orders/:id/price-adjustment · 0722 公测反馈「按乘客调价」）：
//   在录单调价四类原因基础上，加一个可空 passengerId —— 非空 = 只作用于该乘客的应收份额，
//   空 = 整单调价（与录单整单调价同口径）。passengerId 归属本单由 service 层校验（不在此断言）。
export const orderPriceAdjustmentBodySchema = z
  .object({
    amountCny: priceAdjustmentAmountSchema,
    reasonCode: z.enum(PRICE_ADJUSTMENT_REASON),
    reasonText: z.string().max(200).optional(),
    passengerId: z.string().min(1).optional(),
  })
  .refine(requireReasonTextForOther, REASON_TEXT_REQUIRED_MSG);
export type OrderPriceAdjustmentBody = z.infer<typeof orderPriceAdjustmentBodySchema>;

// ── 订单级签证状态 + 结构化备注四栏（录单/编辑共用）─────────────────────────
// 全部 optional：老客户端不传则字段留空，与旧行为一致。每栏限 ~300 字。
const STRUCTURED_NOTE_MAX = 300;
export const orderStructuredNotesShape = {
  visaStatus: z.nativeEnum(VisaRequirement).optional(),
  noteHotel: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  noteVisa: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  notePayment: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  noteSpecial: z.string().max(STRUCTURED_NOTE_MAX).optional(),
} as const;

// 可选字符串字段的姓名规范化 transform：undefined 原样透传，避免把「不传该字段」误变成空字符串。
// 票务岗反馈：护照 OCR/手输姓名格式脏数据（如 `ZHENG,/QINQIN`）入库污染导出名单，
// 在 schema 层兜底规范化，与前端 admin-web/src/lib/passengerName.ts 同一套规则。
function optionalNormalizedName(max: number) {
  return z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v === undefined ? v : normalizePassengerFullName(v)));
}

// 拉丁姓/名的「单段」字段（PNR 姓名里的 LAST 一段或 FIRST 一段）：规范化后不允许再含 '/'。
// 为什么斜线一定是脏数据、而不是某国的合法姓氏：
//   - 在航司 PNR 姓名里 '/' 是且仅是「姓/名」分隔符；护照 MRZ（ICAO 9303）的字符集里根本没有
//     '/'（分隔用 '<<'）。所以单段字段里出现 '/' 只可能是把整个姓名塞进了姓（或名）一栏。
//   - 放过去的后果是静默的：导出层把两段无脑拼成 `LAST/FIRST`，于是
//     lastName='ZHENG/QIN' + firstName='MEI' → `ZHENG/QIN/MEI` 三段名，航司系统拒收，
//     而错误要到出票时才暴露。故在入口就 400，把问题挡在还能改的地方。
// normalize 已经吃掉首尾斜线并把连续斜线折叠成一个，所以这里只会拦到真正内嵌的分隔符；
// 空格分隔的复姓（如 VAN DER BERG）不受影响。
function optionalPnrSegmentName(max: number) {
  return optionalNormalizedName(max).refine((v) => v === undefined || !v.includes('/'), {
    message: '姓、名请分开填写：该栏不能包含「/」（整个姓名请分别填入姓与名两栏）',
  });
}

// 国家码字段（nationality / passportIssueCountry）：录单表单/前端已归一 2 位，但 OTA 名单粘贴解析
// （admin-web parseOtaRoster.ts）、护照 OCR、代理侧 API 等非受控输入常见 3 位码（护照 MRZ 本身
// 就是 3 位，如 CHN/USA/VNM）。此前用 z.string().length(2) 死板拒绝 → 整批建单 400，
// 且报错笼统成 "Request validation failed"，运营看不出到底哪个字段哪个值有问题（0720 反馈）。
// 现改为接受 2 或 3 位字母：3 位查表（与 admin-web 同一口径的 COUNTRY_ALPHA3_TO_ALPHA2）归一成
// 2 位；查不到映射的 3 位码 / 其它非法格式，直接在这条 issue 上给出「哪个字段、哪个值」的中文提示
// （而不是让全局错误处理器的兜底文案吞掉）。
function countryCodeSchema(fieldLabel: string) {
  return z.string().transform((raw, ctx) => {
    const trimmed = raw.trim();
    const upper = trimmed.toUpperCase();
    if (/^[A-Z]{2}$/.test(upper)) return upper;
    if (/^[A-Z]{3}$/.test(upper)) {
      const mapped = COUNTRY_ALPHA3_TO_ALPHA2[upper];
      if (mapped) return mapped;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${fieldLabel}「${trimmed}」是未识别的 3 位国家/地区码，请改用 2 位 ISO 码（如 CN/US/VN）或核对拼写`,
      });
      return z.NEVER;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel}「${trimmed}」不是合法的国家码，应为 2 位或 3 位字母（如 CN 或 CHN）`,
    });
    return z.NEVER;
  });
}

// ── 下单 ─────────────────────────────────────────────────────────────────
// 乘客信息 — 注：所有新字段都是 optional，老客户端可继续工作
export const passengerInputSchema = z.object({
  fullName: z
    .string()
    .min(1)
    .max(120)
    .transform((v) => normalizePassengerFullName(v)),
  // 航司 PNR 拆分姓/名（fullName 仍必填做兼容）
  // 与 fullName 同样在 schema 层兜底规范化：前端 blur 只挡人手录单，任何非 UI 路径
  // （代理 API / 批量导入 / 前台）都能把 `ZHENG,` 直接写进 lastName，必须在边界收口。
  lastName: optionalPnrSegmentName(60),
  firstName: optionalPnrSegmentName(80),
  title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'DR']).optional(),
  gender: z.enum(['M', 'F', 'X']).optional(),
  documentType: z.nativeEnum(DocumentType).default('PASSPORT'),
  documentNumber: z.string().min(3).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  placeOfBirth: z.string().max(60).optional(),
  nationality: countryCodeSchema('国籍').default('CN'),
  passengerType: z.nativeEnum(PassengerType).default('ADULT'),

  // 护照扩展
  chineseName: z.string().max(120).optional(),                                  // 中文姓名
  passportIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),       // 护照签发日期
  passportIssueCountry: countryCodeSchema('护照签发国').optional(),
  passportIssuePlace: z.string().max(120).optional(),                          // 护照签发地点（城市/机关文本，OCR 或手填，选填）
  // 基座 schema 保持 optional：更新/补录路径（自助补录、换人等）复用同款字段规则，
  // 存量空值旧单必须还能继续编辑。**新建路径必填**，口径见
  // passengerInputWithRequiredExpirySchema（批量/OTA）与 refineRequiredPassportExpiry（下单端点）。
  passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  // 订座编码（PNR）：录单时可直接带入（如 OTA 名单里的共用编码——多人同一 PNR 各行填同值，
  // 与航司「一码多人」模型一致）。出票后 demo worker 也会回填/覆盖。
  pnr: z.string().max(20).optional(),
  // 签证
  visaNumber: z.string().max(40).optional(),
  visaType: z.string().max(40).optional(),
  visaIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visaEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),       // 签证生效日期
  visaExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visaPlaceOfIssue: z.string().max(60).optional(),
  visaCountryOfApplication: z.string().length(2).optional(),

  // 地址（航司提交格式）
  addressType: z.enum(['BUSINESS', 'RESIDENTIAL']).optional(),
  addressDetails: z.string().max(200).optional(),
  addressCity: z.string().max(60).optional(),
  addressState: z.string().max(60).optional(),
  addressCountry: z.string().length(2).optional(),
  addressZip: z.string().max(20).optional(),

  mealPreference: z.string().max(40).optional(),
  needsWheelchair: z.boolean().optional(),
  needsInfantBassinet: z.boolean().optional(),
  bedPref: z.enum(['SINGLE', 'DOUBLE', 'TWIN', 'SHARE_OK']).optional(),
  // 护照图 data-URL；3MB 上限让单张超大图快速失败（清晰报错，而非整请求 413 黑盒）
  passportPhotoUrl: z.string().url().max(3_000_000, '护照图过大，请压缩后重试').optional(),

  // ── 套餐乘客级选项（购物车模式：同一订单每人各选住宿方式 + 签证）──
  //   visaExempt = 客人自备签证（无需送签，签证台过滤 + 套餐价按人扣减 selfVisaDeductCny）
  //   singleRoom = 单住（不拼房，按人收单房差）
  // 均 optional 布尔：向后兼容——不传时 service 回落 bundleItem 的旧整单聚合口径；
  //   任一乘客显式提供时以乘客级派生为权威（优先级见 orders.service）。
  visaExempt: z.boolean().optional(),
  singleRoom: z.boolean().optional(),
});
export type PassengerInput = z.infer<typeof passengerInputSchema>;

// ── 新建乘客：护照有效期必填口径（业务拍板，2026-07）──────────────────────
// **全渠道强制**：所有新建订单路径（后台单录、批量/OTA 入单、前台散客/游客/代理自助、
// 小程序）都必须带护照有效期。批量/OTA 走本 schema；POST /orders 走
// refineRequiredPassportExpiry（文案能指到第几位出行人，且按产品类型划范围）。
// 更新/补录路径（selfUpdatePassengerBodySchema、签证台补录、换人 swapPassengerBodySchema 等）
// 保持可空：存量空值旧单要能继续编辑，护照补录功能不受影响。
export const passengerInputWithRequiredExpirySchema = passengerInputSchema.extend({
  passportExpiry: z
    .string({ required_error: '护照有效期必填', invalid_type_error: '护照有效期必填' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, '护照有效期格式应为 YYYY-MM-DD'),
});

// 「按人出行」的产品行：含这些行的订单，每位出行人都必须有护照有效期。
// 纯酒店/接送单不在此列 —— 那类单的出行人可能只是联系人占位（documentNumber='N/A'），
// 没有护照资料，强制有效期会把正常录单打死。
const PER_PERSON_TRAVEL_KINDS = new Set(['FLIGHT', 'BUNDLE', 'VISA']);

/**
 * 公开下单端点（POST /orders）的护照有效期必填校验：**不分渠道**（后台单录、前台散客/
 * 游客/代理自助、小程序全覆盖），只按产品类型划范围（见 PER_PERSON_TRAVEL_KINDS）。
 *
 * 放在 body 级而非乘客 item 级的原因有二：
 *   ① 要同时看到 items 才能判断本单是否「按人出行」；
 *   ② item 级 issue 只带 0 基下标路径（passengers.0.passportExpiry），客人看不懂 ——
 *      这里直接给「第 N 位出行人」的中文文案。
 * 其余字段规则仍由 passengerInputSchema 逐项校验（不放松任何一项）。
 */
function refineRequiredPassportExpiry(
  body: { items: Array<{ kind: string }>; passengers: Array<{ passportExpiry?: string }> },
  ctx: z.RefinementCtx,
): void {
  if (!body.items.some((it) => PER_PERSON_TRAVEL_KINDS.has(it.kind))) return;
  body.passengers.forEach((p, i) => {
    if (!p.passportExpiry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passengers', i, 'passportExpiry'],
        message: `第 ${i + 1} 位出行人：护照有效期必填（格式 YYYY-MM-DD）`,
      });
    }
  });
}

// ── 前台自助：出行人护照资料补录（PATCH /orders/:id/passengers/:passengerId，客户/代理侧）──
// 字段校验规则与 passengerInputSchema 完全同款；全部可选但至少给一个。
// 刻意不含 fullName / lastName / firstName —— 换人请联系客服（身份字段前台锁定），
// .strict() 让误传 fullName 的客户端拿到明确校验错误而不是被静默忽略。
export const selfUpdatePassengerBodySchema = z
  .object({
    chineseName: z.string().max(120).optional(),
    gender: z.enum(['M', 'F', 'X']).optional(),
    documentNumber: z.string().min(3).max(40).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    nationality: z.string().length(2).optional(),
    passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    passportIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    passportIssueCountry: z.string().length(2).optional(),
    passportIssuePlace: z.string().max(120).optional(),
    // 护照图 data-URL；3MB 上限与下单口径一致（超大图快速失败，而非整请求 413 黑盒）
    passportPhotoUrl: z.string().url().max(3_000_000, '护照图过大，请压缩后重试').optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '请至少提供一个需要更新的字段',
  });
export type SelfUpdatePassengerBody = z.infer<typeof selfUpdatePassengerBodySchema>;

// ── 签证台：出签后补录 出签日/生效日/有效期（PATCH /orders/:id/passengers/:passengerId/visa-dates；ADMIN/STAFF）──
// 这三项是签证岗出签后才拿得到的信息，录单时无法预先知道（票务岗反馈：录单时不需要，
// 已从录单表单移除），改由签证台在出签后补录。YYYY-MM-DD 字符串；null 表示清空该字段；
// 三个字段均可选，但至少要提供一个（不然这次调用没有意义）。
export const updatePassengerVisaDatesBodySchema = z
  .object({
    visaIssueDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
    visaEffectiveDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
    visaExpiry: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '请至少提供一个需要更新的字段',
  });
export type UpdatePassengerVisaDatesBody = z.infer<typeof updatePassengerVisaDatesBodySchema>;

// ── 前台自助：改签申请（POST /orders/:id/change-request）──
export const changeRequestBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(2, '请填写改签原因（至少 2 个字）')
    .max(500, '改签原因最多 500 字'),
});
export type ChangeRequestBody = z.infer<typeof changeRequestBodySchema>;

// 订单行（OrderItem）— 前端用 kind 区分是机票/酒店/接送/签证
// FLIGHT 必须带 flightScheduleId + flightCabin + quantity；后端会重算价格并校验余票
// HOTEL/TRANSFER/VISA 暂时"信任前端价格"（产品 CRUD P1 补齐后改为后端查）
const baseItemSchema = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(20),
  metadata: z.record(z.unknown()).optional(),
});

export const flightItemSchema = baseItemSchema.extend({
  kind: z.literal('FLIGHT'),
  flightScheduleId: z.string().min(1),
  flightCabin: z.nativeEnum(CabinClass),
  // 套餐折扣关联：该机票腿属于哪个套餐（前台套餐下单时打的标）。
  // 后端据此把该腿按套餐 discountPct 打折（不信前端折扣值，从 DB 读 bundle.discountPct）。
  bundleId: z.string().min(1).optional(),
});

// 注：这里必须保持纯 ZodObject（orderItemInputSchema 是 discriminatedUnion，不接受 ZodEffects），
// 故「hotelRoomTypeId 与 randomStarTier 互斥 + 随机档行必须有入住区间」的跨字段校验放在
// service 的 HOTEL 分支（priceAndValidateItems），那里本就是权威定价/校验闸。
export const hotelItemSchema = baseItemSchema.extend({
  kind: z.literal('HOTEL'),
  hotelRoomTypeId: z.string().min(1).optional(),
  // 星级随机档行（3=三星随机、4=四星随机、5=五星随机）：客人买的是「N 星随机」，下单时不指定酒店，
  // 占的是同星级酒店的合计余量（未落位随机单），之后由房控落到具体酒店。与 hotelRoomTypeId 互斥。
  randomStarTier: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unitPrice: z.number().nonnegative(),
  // 计费房间数（支持 0.5 间）。缺省 → 按房型容量自动推算 roomsNeeded（旧行为）。
  roomsBilled: z.number().multipleOf(0.5).min(0.5).max(50).optional(),
});

export const transferItemSchema = baseItemSchema.extend({
  kind: z.literal('TRANSFER'),
  transferId: z.string().min(1).optional(),
  unitPrice: z.number().nonnegative(),
});

export const visaItemSchema = baseItemSchema.extend({
  kind: z.literal('VISA'),
  visaId: z.string().min(1).optional(),
  unitPrice: z.number().nonnegative(),
  // 预计出行日期（可选，YYYY-MM-DD，与 hotelItemSchema.checkIn 同款校验）：签证业务的日期锚点。
  // 纯签证单没有航班行、也没有酒店入住日；填了它，订单「出发日」派生才有得回退，
  // 按出发日期区间导出才捞得到这单。留空 = 行程尚未定，行为与扩展前一致。
  visaIntendedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const bundleItemSchema = baseItemSchema.extend({
  kind: z.literal('BUNDLE'),
  bundleId: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  // 可选升级 add-on（server-priced，整数份数；缺省 0 = 无升级，价格与旧版完全一致）：
  //   singleCount   = 选「一个人住酒店（单人入住）」的人数 → 每人每晚加 singleSupplementCnyPerNight
  //   businessCount = 选「升舱商务」的人数 → 每人每航段加 businessUpgradeCnyPerLeg（占用真实商务舱库存）
  singleCount: z.number().int().min(0).max(20).optional(),
  businessCount: z.number().int().min(0).max(20).optional(),
  // 升舱分程口径（去程 / 回程各自的升舱人数）——同一批客人可以只升去程、或去回程升的人数不同。
  //   两者任一显式提供 → 以分程口径为权威（单程套餐 legs=1 时回程人数恒按 0 处理）；
  //   两者都省略 → 回落旧的整程 businessCount（每程同人数，× legs 计价），行为与扩展前完全一致。
  businessCountOutbound: z.number().int().min(0).max(20).optional(),
  businessCountReturn: z.number().int().min(0).max(20).optional(),
  // 占座模型（业务需求）：区分成人 / 占座儿童 / 不占座婴儿（都需护照，均为出行人）：
  //   adultCount  = 成人数（占 1 座、计入拼房）
  //   childCount  = 占座儿童数（占 1 座、计入拼房；机票按成人价减 childSeatDiscountCnyPerPerson）
  //   infantCount = 不占座婴儿数（不占座、不占房；机票收 infantPriceCny/人）
  // 向后兼容：三者全缺省时，旧 pax（metadata.pax 或行 quantity）视为 adultCount，child/infant=0，定价与旧版完全一致。
  adultCount: z.number().int().min(0).max(20).optional(),
  childCount: z.number().int().min(0).max(20).optional(),
  infantCount: z.number().int().min(0).max(20).optional(),
  // 自备签证：出行人自行办妥签证，套餐加价里减去该套餐配置的自备签证减免（selfVisaDeductCny）。
  selfProvidedVisa: z.boolean().optional(),
  // 计费房间数（支持 0.5 间）。缺省 → 按房型容量自动推算 roomsNeeded（旧行为）。
  roomsBilled: z.number().multipleOf(0.5).min(0.5).max(50).optional(),
  // 指定酒店（可选）：套餐按「星级随机」报价，客人点名要住某家酒店 → 传该店房型 id。
  // 服务端据此把占房/盖章切到指定房型，并按该酒店配置的「指定酒店加价 ¥/人」×占座人数
  // 加收（server-priced，客户端不传金额）。缺省 = 不指定，走套餐绑定房型/随机现状。
  designatedHotelRoomTypeId: z.string().min(1).optional(),
  // 星级不匹配放行原因（仅 ADMIN/STAFF 有效）：指定酒店的星级与套餐结算档次对不上时，
  // 代理/客户一律拒单；运营必须写明原因才放行，原因随审计留痕（谁放的、为什么放）。
  // 匹配时传了也无副作用（不写审计）。
  designatedHotelStarMismatchReason: z.string().trim().min(1).max(200).optional(),
});

// BUNDLE 行 metadata 里的出行信息（sales-web 购物车带过来，用于推导酒店入住日期）。
// 全部 optional 且逐字段 .catch(undefined) 降级 —— metadata 异常绝不阻断套餐下单。
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const bundleItemMetadataSchema = z
  .object({
    goDate: dateOnlySchema.optional().catch(undefined),
    returnDate: dateOnlySchema.optional().catch(undefined),
    pax: z.number().int().min(1).max(99).optional().catch(undefined),
    rooms: z.number().int().min(1).max(99).optional().catch(undefined),
    // 占座模型计数（前台带过来，用于出行人数校验）。逐字段降级，异常绝不阻断下单。
    adultCount: z.number().int().min(0).max(99).optional().catch(undefined),
    childCount: z.number().int().min(0).max(99).optional().catch(undefined),
    infantCount: z.number().int().min(0).max(99).optional().catch(undefined),
  })
  .catch({});
export type BundleItemMetadata = z.infer<typeof bundleItemMetadataSchema>;

export const orderItemInputSchema = z.discriminatedUnion('kind', [
  flightItemSchema,
  hotelItemSchema,
  transferItemSchema,
  visaItemSchema,
  bundleItemSchema,
]);
export type OrderItemInput = z.infer<typeof orderItemInputSchema>;

// 游客下单（免登录）联系人 —— 仅在请求未带有效登录态时必填（路由层断言）。
// 登录用户下单时忽略此字段（沿用 userId 绑定）。
export const guestContactSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(5).max(40),
  email: z.string().email().optional(),
});
export type GuestContact = z.infer<typeof guestContactSchema>;

export const createOrderBodySchema = z.object({
  // 联系人默认=录入人，电话选填：登录用户下单时缺省由后端用登录账号兜底（见 createOrder）。
  // 游客下单仍须通过 guestContact 提供联系人（路由层断言），与此处放宽无关。
  contactName: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(120).optional()),
  contactPhone: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(5).max(40).optional()),
  contactEmail: z.string().email().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  items: z.array(orderItemInputSchema).min(1).max(20),
  passengers: z.array(passengerInputSchema).min(1, '至少需要 1 位出行人').max(20),
  notes: z.string().max(500).optional(),
  // 签证状态 + 结构化备注四栏（可选；兼容旧客户端）
  ...orderStructuredNotesShape,
  idempotencyKey: z.string().min(8).max(128).optional(),
  // 游客下单联系人（免登录时必填；登录用户忽略）
  guestContact: guestContactSchema.optional(),
  // 运营代下单时归属的代理（仅 ADMIN/STAFF 录单时生效）。
  // AGENT 自助下单忽略此字段（只能归属自己）；游客忽略。
  agentId: z.string().optional(),
  // 团队议价结算价（CNY，每位出行人）覆盖机票动态价。仅内部调用方（batchCreateOrders）
  // 在路由层完成 ADMIN/STAFF 鉴权后注入；公开下单端点不暴露此字段（createOrderBodySchema.parse
  // 会接受但路由 POST / 永不设置它）。设置时仅改 FLIGHT 行价格，扣座 quantity/班次/舱位不变。
  flightSettlementPriceCny: z
    .number()
    .min(0)
    .max(SETTLEMENT_PRICE_CAP_CNY)
    .optional(),
  // 录单调价/加项（仅 ADMIN/STAFF 录单生效）。服务端按认证身份判权限：公开散客/客户/代理
  // 携带此字段一律 400（见 createOrder）。落一条独立 OrderItem 计入 total，并写审计。
  priceAdjustment: priceAdjustmentSchema.optional(),
  // 本单结算总价（CNY，≥0，最多两位小数；仅 ADMIN/STAFF 录单生效，服务端按认证身份判权限）。
  // 业务场景：代理单与代理谈定整单一口价，系统照此收钱。实现上**不改任何明细行价格**：
  // 服务端算完权威合计后，按「结算价 − 权威合计」自动生成一条 reasonCode=SETTLEMENT 的调价行
  // （原价/差额/原因留痕可审计），总额=Σitems 不变式保持。差额受 PRICE_ADJUSTMENT_CAP_CNY 约束；
  // 与 priceAdjustment 互斥（同时传 400，见 createOrder），避免双重砸价。
  settlementTotalCny: z
    .number()
    .min(0, '结算总价不能为负')
    .refine((v) => Number(v.toFixed(2)) === v, { message: '结算总价最多两位小数（元）' })
    .optional(),
  // 每人结算价（CNY，≥0，最多两位小数；仅 ADMIN/STAFF 录单生效，服务端按认证身份判权限）。
  // 业务场景（票务反馈）：同单多人结算价不同，录单时逐人填价。**不是手填每人价格的口子**——
  // 落库仍走差额模型：服务端取 min 为基准生成整单 SETTLEMENT 差额行，再逐人生成
  // 「该人结算价 − min」的按乘客 SETTLEMENT 差额行（挂 passengerId），订单详情
  // 「每人结算价」表按既有派生口径还原出逐人价。数组与 passengers 同序等长（createOrder 校验）；
  // 与 settlementTotalCny / priceAdjustment 互斥（同时传 400，见 createOrder）。
  perPassengerSettlementCny: z
    .array(
      z
        .number()
        .min(0, '每人结算价不能为负')
        .refine((v) => Number(v.toFixed(2)) === v, { message: '每人结算价最多两位小数（元）' }),
    )
    .min(1)
    .max(20)
    .optional(),
  // 允许重复乘客强录（仅 ADMIN/STAFF 后台录入生效）。客人重复订票且已付款场景：
  // 同班次同证件号本会被拦，运营确认后带此 flag 放行，服务端写审计 + 订单备注留痕。
  // 服务端按认证身份判权限：散客/AGENT 携带此字段无效，照旧拦（见 createOrder）。
  allowDuplicatePassengers: z.boolean().optional(),
  // 前台展示总价兜底（正整数 CNY，仅前台散客结账带；admin/批量/quote 一律不带 → 跳过比对，不影响录单路径）。
  // 后端权威商品价（护照临期费/录单调价之前）与此偏差 > 1 元 → 抛 PRICE_CHANGED（见 createOrder），
  // 防止「展示价与实收价背离」时静默按新价多收（如套餐机票展示 ¥0 实扣真实机票价）。
  expectedTotalCny: z.number().int().positive().optional(),
})
  // 护照有效期必填（业务拍板，2026-07）：本 schema 是 POST /orders 的唯一入口，
  // 前台散客/游客、代理自助、小程序与后台单录全走这里 → 一处收口即全渠道生效。
  // service 层还有一道 ADMIN/STAFF 同口径校验（createOrder），作双保险保留。
  .superRefine(refineRequiredPassportExpiry);
type ParsedCreateOrderBody = z.infer<typeof createOrderBodySchema>;
// 内部 batchCreateOrders 可在 priceAdjustment 上附带 stackWithSettlementCalendar；HTTP schema
// 仍使用公开 priceAdjustmentSchema 并 strip 该字段，不会把内部语义暴露给外部调用方。
export type CreateOrderBody = Omit<ParsedCreateOrderBody, 'priceAdjustment'> & {
  priceAdjustment?: PriceAdjustmentInput;
};

/**
 * 结算价日历预览的唯一后端类型真源；quote 与 createOrder 共用同一套日历取价结果形状。
 */
export type SettlementPreview =
  | null
  | {
      ok: true;
      source: 'GROUND' | 'FLIGHT';
      totalCny: number;
      departDate?: string;
      lines: Array<{
        pricePerPersonCny: number;
        pax: number;
        addOnCny?: number;
        note: string;
      }>;
      autoDiscount?: {
        hits: Array<{
          ruleId: string;
          kind: 'AGENT' | 'AGENT_DEFAULT' | 'RETAIL';
          perPersonCny: number;
          pax: number;
        }>;
        pax: number;
        totalCny: number;
      } | null;
    }
  | { ok: false; reason: string };

// ── 录单前试算（quote，只算不落库；ADMIN/STAFF）───────────────────────────
// body 为 createOrder items 子集：填完产品/人数即可拿到「系统权威价」，供录单页展示。
// 复用 priceAndValidateItems 的权威定价逻辑，绝不写库、绝不扣座。
//
// passengers（可选）：套餐乘客级住宿/签证选项的试算输入。试算只需定价相关的两维布尔，
//   不需要完整身份字段（区别于 createOrder 的 passengerInputSchema）。缺省则回落 item 级
//   旧聚合口径，与 createOrder 同一优先级（见 priceAndValidateItems）。
export const quotePassengerOptionSchema = z.object({
  visaExempt: z.boolean().optional(),
  singleRoom: z.boolean().optional(),
});
export type QuotePassengerOption = z.infer<typeof quotePassengerOptionSchema>;

export const quoteOrderBodySchema = z.object({
  items: z.array(orderItemInputSchema).min(1).max(20),
  passengers: z.array(quotePassengerOptionSchema).max(20).optional(),
  // ADMIN/STAFF 试算代理订单时传入归属代理；不传则按散客口径试算。
  agentId: z.string().min(1).optional(),
  // 手工价通道字段（形状抄 createOrderBodySchema 对应字段）：录单页填了这些字段后随试算一起
  // 发送，quoteOrder 服务层据此与 createOrder 同口径判定「是否存在手工价通道」，抑制一个真下单
  // 时并不会生效的自动立减（同业/代理）——此前 schema 未暴露这三个字段，路由层 parse 时会被
  // 静默剥掉，运营在试算里看到的立减和真下单的结果对不上。
  priceAdjustment: priceAdjustmentSchema.optional(),
  settlementTotalCny: z
    .number()
    .min(0, '结算总价不能为负')
    .refine((v) => Number(v.toFixed(2)) === v, { message: '结算总价最多两位小数（元）' })
    .optional(),
  flightSettlementPriceCny: z
    .number()
    .min(0)
    .max(SETTLEMENT_PRICE_CAP_CNY)
    .optional(),
});
export type QuoteOrderBody = z.infer<typeof quoteOrderBodySchema>;

// ── 列表 / 详情 ─────────────────────────────────────────────────────────
export const listOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  agentId: z.string().optional(),
  // 渠道筛选（直客 / 代理）—— 与 agentId 是同一维度的粗细两档：
  //   direct = 直客/散客单（Order.agentId 为空）；agent = 代理单（Order.agentId 非空）。
  // 与 agentId 同时给出时 agentId 优先（更细的那一档），channel 忽略 ——「某一家代理」本就是
  // 「代理单」的子集，两者矛盾时按用户明确点名的那家算。
  channel: z.enum(['direct', 'agent']).optional(),
  kind: z.nativeEnum(OrderItemKind).optional(),
  search: z.string().max(120).optional(), // 订单号/姓名/电话
  // 下单时间起/止 — 兼容两种口径（公测反馈：需精确到几点几分统计当日进单）：
  //   · 纯日期 YYYY-MM-DD（历史口径，行为不变：当日整天）
  //   · 带时间 YYYY-MM-DDTHH:mm[:ss]（datetime-local 口径，按录单人所见的北京时精确卡界）
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).optional(),  // 下单时间起
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).optional(),    // 下单时间止
  // 按出行日期筛选（票务/签证流程按日期批量处理，反馈高优需求）
  travelFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  travelTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // 按返程日期筛选（出行日期语义不变 = 整单出发日区间；本参数另开一维 = 整单返程日区间）。
  // 只对有回程航段的往返单有意义——无回程腿的单程/纯地面单在填了本筛选时不命中，见
  // filterOrderIdsByReturnDate。口径与 travelFrom/travelTo 对称：可只填一端，单填一端即开区间。
  returnFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  returnTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // 按航班日期筛选（票务需求：按「某天的某一班」搜整班订单）。这是**航段级**维度：
  // 匹配「任一带班次的 FLIGHT 行的当地起飞日」落在区间内，不区分该段是去程还是回程；
  // 与 flightNumber 同时给出时要求**同一段**既是该航班号、又在区间内——"9/3 的 QH9588"
  // 一次搜全，不必再拆成「返程日期+航班号」和「出行日期+单程」两次搜。
  // 与出行日期（整单去程日）/ 返程日期（整单回程日）是不同维度，互不替代。
  flightDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  flightDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // 接单状态过滤
  claimedById: z.string().optional(),   // 指定 ops
  unclaimedOnly: z.coerce.boolean().optional(),
  // ops 确认的三个筛选（航班号 / 乘客姓名 / 开票状态）
  // 航班号（不区分大小写）。口径随同时给出的日期维度收口（0831 票务反馈，精筛见
  // filterOrderIdsByLegFlightNumber / filterOrderIdsByFlightDate）：
  //   · 单独给出：订单任一段含该航班号即命中（宽口径，维持历史行为）；
  //   · 与 travelFrom/travelTo 同给：整单**去程段**须是该航班号；
  //   · 与 returnFrom/returnTo 同给：整单**回程段**须是该航班号；
  //   · 与 flightDateFrom/flightDateTo 同给：**同一段**该航班号且当天起飞（整班名单）。
  flightNumber: z.string().max(20).optional(),
  // 乘客姓名模糊匹配——上限 600 字符：运营反馈要能一次贴一整团（几十人）的名单，
  // 与 orders.service.ts 的 MAX_PASSENGER_NAME_TERMS（50 词）配套，留够分隔符空间。
  passengerName: z.string().max(600).optional(),
  // 录入人员模糊匹配 —— 口径与导出「录入人员」列同源（下单账号 user.displayName → email；
  // 游客单无录单账号，整类记作「散客」，搜该标签即捞出全部游客单）。多词之间 OR：一次填几个
  // 人名＝列出这几位录入的订单（与 passengerName 同语义，不是 search 的词间 AND）。
  recordedBy: z.string().max(120).optional(),
  invoiceStatus: z.nativeEnum(InvoiceStatus).optional(),
  // 六态开票筛选（组合式，取代旧的订单级 invoiceStatus 作为主口径）：
  //   invoiceLeg = 维度（去程 outbound / 回程 return / 系统 system）
  //   invoiced   = 该维度已开(true) / 未开(false)
  // 二者需同时给出才生效——票务岗「出行日期=7/10 + 去程未开 → 导出」正走这条路径。
  invoiceLeg: z.enum(['outbound', 'return', 'system']).optional(),
  // query 参数是字符串，z.coerce.boolean 会把 "false" 也判成 true（非空字符串皆真）——
  // 这里显式只认 'true'/'false'（或真布尔），避免 ?invoiced=false 被误判为已开。
  invoiced: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  // 签证办理状态筛选 — 与列表「签证」列徽标同源（订单 VISA 行的 VISA_APPLICATION 履约任务状态）。
  //   signed   = 已签证：订单含 VISA 行且其签证办理任务已确认(CONFIRMED)
  //   unsigned = 未签证：订单含 VISA 行但签证办理任务尚未确认（待处理/处理中/已取消/失败或无任务）
  // 无 VISA 行的订单（列表签证列显示「—」）两个值都不命中，与徽标保持一致、不引入第三口径。
  // 注：这是履约进度口径，区别于订单录单字段 Order.visaStatus（VisaRequirement 枚举）。
  visaFulfillmentStatus: z.enum(['signed', 'unsigned']).optional(),
  // 按订单录单要求（Order.visaStatus）筛选；与 visaFulfillmentStatus（履约任务进度）是两个维度。
  visaRequirement: z.enum(['NEEDED', 'E_VISA', 'HAS_VISA', 'NOT_NEEDED']).optional(),
  // 行程类型筛选：oneway=只有去程（且必须有航段，酒店单/签证单不算单程单）；roundtrip=有回程。
  // 查询层走物化列 Order.hasReturnLeg（Prisma where 表达不了「关联行 ≥ 2 条」）。
  tripType: z.enum(['oneway', 'roundtrip']).optional(),
  // 航段留痕四态筛选（物化列 Order.legFlag，派生规则见 orders.service 的 syncOrderLegFlag）：
  //   NO_SHOW         去程标了 no-show，但回程没释放（单程单，或勾了不释放）
  //   RETURN_RELEASED 回程座位当前处于「已释放」态 —— 票务要盯的就是这一批（可恢复、可重卖）
  //   RETURN_RESTORED 释放过、已恢复回原班次
  //   RETURN_VOIDED   回程终局作废（释放后原班次已飞完，或走取消航段取消了回程）
  //   OUTBOUND_VOIDED 去程终局作废（走取消航段取消了去程）
  //   NONE            没有任何此类留痕（绝大多数单）
  legFlag: z
    .enum([
      'NONE',
      'NO_SHOW',
      'RETURN_RELEASED',
      'RETURN_RESTORED',
      'RETURN_VOIDED',
      'OUTBOUND_VOIDED',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ── 勾选导出：orderIds ───────────────────────────────────────────────────
// 「只导出勾选的订单」——列表勾选后把选中订单 id 透传给导出。
// 支持逗号分隔（?orderIds=a,b,c）或重复参数（?orderIds=a&orderIds=b），跟随现有 query 风格。
// 规整为去重后的非空字符串数组；给上限防滥用（一次导出体量可控）。
export const MAX_EXPORT_ORDER_IDS = 500;
export const orderIdsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const raw = Array.isArray(v) ? v : v.split(',');
    const ids = Array.from(new Set(raw.map((s) => s.trim()).filter(Boolean)));
    return ids.length > 0 ? ids : undefined;
  })
  .refine((ids) => ids === undefined || ids.length <= MAX_EXPORT_ORDER_IDS, {
    message: `一次最多导出 ${MAX_EXPORT_ORDER_IDS} 条勾选订单`,
  });

// ── 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）────────────────────────
// 与 listOrders 共用同一组筛选字段（status/agentId/kind/search/from/to/
// travelFrom/travelTo/flightNumber/passengerName/invoiceStatus），外加 template。
// 另可选 orderIds：给了就「只导勾选的这些订单」，忽略上述筛选（见 buildOrderFilterWhere）。
export const exportTemplatesQuerySchema = listOrdersQuerySchema
  .pick({
    status: true,
    agentId: true,
    // 渠道 / 返程日期 / 航班日期：列表有、导出此前没有的四组筛选。缺了它们，运营在列表里
    // 按「代理单 + 9/3 回程」筛完再点导出，导出会按更宽的条件多带一批单出来（导出 ≠ 列表所见）。
    channel: true,
    kind: true,
    search: true,
    from: true,
    to: true,
    travelFrom: true,
    travelTo: true,
    returnFrom: true,
    returnTo: true,
    flightDateFrom: true,
    flightDateTo: true,
    flightNumber: true,
    passengerName: true,
    recordedBy: true,
    invoiceStatus: true,
    invoiceLeg: true,
    invoiced: true,
    visaFulfillmentStatus: true,
    visaRequirement: true,
    legFlag: true,
  })
  .extend({
    template: z.enum(['full', 'ticketing', 'visa']),
    // 精确按班次（整班·全岗导出用）；优先于 travelFrom/travelTo，只导该班次订单。
    scheduleId: z.string().min(1).optional(),
    // 行程类型筛选（票务岗反馈）：oneway=只有去程、roundtrip=有第 2 段（回程）。
    // 导出内存侧按 determineFlightLegs 判定（Prisma where 表达不了"关联行 ≥ 2 条"）。
    tripType: z.enum(['oneway', 'roundtrip']).optional(),
    // 勾选导出：给了就以这批 id 为准（忽略其余筛选），无则按上面的筛选条件。
    orderIds: orderIdsQuerySchema,
  });
export type ExportTemplatesQuery = z.infer<typeof exportTemplatesQuerySchema>;

// ── 全岗总表导出 ─────────────────────────────────────────────────────────
// 与三模板导出**同名同义**的一整套筛选（= 列表 listOrders 的筛选集），外加岗位视图 role
// 与勾选导出 orderIds。此前本端点只认 from/to，且 from/to 的语义是**出行日期** —— 于是
// 「按下单时间筛一批单再导全岗总表」根本导不出想要的那批，而列表上明明筛好了。
//
// ⚠️ from/to 的语义随本次改动统一为**下单时间**（与列表/三模板/进单统计一致），
// 出行日期改用 travelFrom/travelTo。唯一调用方是运营后台，与本批同版本发布。
export const exportMasterQuerySchema = listOrdersQuerySchema
  .pick({
    status: true,
    agentId: true,
    channel: true,
    kind: true,
    search: true,
    from: true,
    to: true,
    travelFrom: true,
    travelTo: true,
    returnFrom: true,
    returnTo: true,
    flightDateFrom: true,
    flightDateTo: true,
    flightNumber: true,
    passengerName: true,
    recordedBy: true,
    invoiceStatus: true,
    invoiceLeg: true,
    invoiced: true,
    visaFulfillmentStatus: true,
    visaRequirement: true,
    tripType: true,
    legFlag: true,
  })
  .extend({
    // 岗位视图：仅裁列，不改取数。路由按登录身份强制覆盖（专岗账号改参数无效）。
    role: z.enum(['all', 'ticketing', 'visa']).optional(),
    // 勾选导出：给了就以这批 id 为准（忽略上述筛选，见 buildOrderFilterWhere）。
    orderIds: orderIdsQuerySchema,
  });
export type ExportMasterQuery = z.infer<typeof exportMasterQuerySchema>;

// ── 分房表导出（成都格式：按入住日期分 sheet）────────────────────────────
export const exportRoomAllocationQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
  // 按出发日口径：选出该日出发的订单，导出其全部入住晚（与 from/to 互斥，给了它就优先）。
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
});
export type ExportRoomAllocationQuery = z.infer<typeof exportRoomAllocationQuerySchema>;

// ── 签证资料合并打包（zip：合并签证名单 xlsx + 全部护照图）─────────────────
// 按勾选的订单 id 列表选单，一次导出这些订单的签证资料（不再按出发日整日打包）。
export const visaBundleBodySchema = z.object({
  orderIds: z
    .array(z.string().min(1))
    .min(1, '请至少勾选一个订单')
    .max(200, '单次最多打包 200 个订单，请分批操作'),
});
export type VisaBundleBody = z.infer<typeof visaBundleBodySchema>;

// ── 状态流转 ─────────────────────────────────────────────────────────────
export const updateStatusBodySchema = z.object({
  toStatus: z.nativeEnum(OrderStatus),
  reason: z.string().max(500).optional(),
  // ADMIN 强制覆盖：跳过 ALLOWED_TRANSITIONS 检查（仅 ADMIN 生效；STAFF/CUSTOMER 忽略）
  force: z.boolean().optional(),
});
export type UpdateStatusBody = z.infer<typeof updateStatusBodySchema>;

export const swapRefundBodySchema = z.object({
  swapFeeCny: z.number().int().min(0),
  replacementOrderNumber: z.string().trim().max(64).optional(),
  reason: z.string().trim().min(1, '请填写换人退款原因').max(500),
});
export type SwapRefundBody = z.infer<typeof swapRefundBodySchema>;

export const updateSwapReplacementOrderBodySchema = z.object({
  replacementOrderNumber: z.string().trim().max(64).nullable(),
});
export type UpdateSwapReplacementOrderBody = z.infer<typeof updateSwapReplacementOrderBodySchema>;

// ── 批量状态流转（ADMIN/STAFF）──────────────────────────────────────────
export const batchUpdateStatusBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  toStatus: z.nativeEnum(OrderStatus),
  reason: z.string().max(500).optional(),
  force: z.boolean().optional(),
});
export type BatchUpdateStatusBody = z.infer<typeof batchUpdateStatusBodySchema>;

// ── 批量开票（票务岗，ADMIN/STAFF）─────────────────────────────────────────
// 逐单按航段翻转 outboundInvoiced/returnInvoiced/systemInvoiced（复用单条 setInvoiceFlags 语义）；
// flags 至少选一项，orderIds 上限对齐 batchUpdateStatusBodySchema。
export const batchSetInvoiceFlagsBodySchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(100),
  flags: z
    .object({
      outboundInvoiced: z.boolean().optional(),
      returnInvoiced: z.boolean().optional(),
      systemInvoiced: z.boolean().optional(),
    })
    .refine((f) => Object.keys(f).length > 0, { message: '请至少选择一项开票标记' }),
});
export type BatchSetInvoiceFlagsBody = z.infer<typeof batchSetInvoiceFlagsBodySchema>;

// ── 批量改航班（录入纠错，ADMIN/STAFF）────────────────────────────────────
// 按订单解析去程/回程航段；不接收费用字段，纠错只搬座位、不收改期费。
export const batchRescheduleBodySchema = z.object({
  orderIds: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'orderIds 不得重复' }),
  leg: z.enum(['OUTBOUND', 'RETURN']),
  newScheduleId: z.string().min(1, 'newScheduleId 必填'),
  allowTicketed: z.boolean().optional().default(false),
  note: z.string().max(500).optional(),
});
export type BatchRescheduleBody = z.infer<typeof batchRescheduleBodySchema>;

// ── 批量锁定/解锁结算价（ADMIN/STAFF）──────────────────────────────────────
export const batchSettlementLockBodySchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(500),
  lock: z.boolean(),
});
export type BatchSettlementLockBody = z.infer<typeof batchSettlementLockBodySchema>;

// ── 批量散客建单（后台）─────────────────────────────────────────────────────
// 选一个航班班次 + 舱位 + 共享联系人 → 名单里每位乘客各成一单（FLIGHT × 1）
// ── 公开订单查询（免登录，A4）──────────────────────────────────────────────
// orderNumber + (phone 或 email) 任一匹配；至少给一个联系方式。
export const publicOrderLookupQuerySchema = z
  .object({
    orderNumber: z.string().min(3).max(40),
    phone: z.string().min(3).max(40).optional(),
    email: z.string().email().optional(),
  })
  .refine((q) => Boolean(q.phone) || Boolean(q.email), {
    message: '需提供手机号或邮箱',
  });
export type PublicOrderLookupQuery = z.infer<typeof publicOrderLookupQuerySchema>;

// ── B5: 批量建单 productType 枚举 ─────────────────────────────────────────────
// 必须在 batchCreateOrdersBodySchema 之前声明（const 不提升；下方对象字段直接引用）。
export const batchProductTypeSchema = z
  .enum(['FLIGHT_ONEWAY', 'FLIGHT_ROUNDTRIP', 'BUNDLE'])
  .default('FLIGHT_ONEWAY');
export type BatchProductType = z.infer<typeof batchProductTypeSchema>;

// 批量创单与占位单转正共用的乘客输入口径：姓名规范化、证件字段、护照有效期必填等规则
// 只在这里维护一份，避免两条名单入口出现漂移。
export const batchPassengerInputSchema = passengerInputWithRequiredExpirySchema.extend({
  note: z.string().max(500).optional(),
  businessUpgrade: z.boolean().optional(),
  designatedHotelRoomTypeId: z.string().min(1).optional(),
  // 星级不匹配放行原因（口径同 bundleItemSchema 同名字段）：批量名单里逐人指定酒店时，
  // 该人的指定酒店与套餐档次对不上 → 必须写原因才放行（批量入口本就仅 ADMIN/STAFF 可达）。
  designatedHotelStarMismatchReason: z.string().trim().min(1).max(200).optional(),
});
export type BatchPassengerInput = z.infer<typeof batchPassengerInputSchema>;

export const batchCreateOrdersBodySchema = z
  .object({
    // ── 产品类型（B5 新增）──────────────────────────────────────────────────────
    // FLIGHT_ONEWAY  : outboundScheduleId + cabin（单程，每人 1 条 FLIGHT 行）
    // FLIGHT_ROUNDTRIP: outboundScheduleId + returnScheduleId + cabin（往返，每人 2 条 FLIGHT 行）
    // BUNDLE          : bundleId（套餐，每人 1 张套餐订单，含 HOTEL 项）
    // 向后兼容：旧调用只传 flightScheduleId 时等价于 FLIGHT_ONEWAY。
    productType: batchProductTypeSchema,

    // ── FLIGHT_ONEWAY / FLIGHT_ROUNDTRIP ──────────────────────────────────────
    // 兼容旧字段名：flightScheduleId → 等价于 outboundScheduleId
    flightScheduleId: z.string().optional(), // 旧路径（向后兼容）
    outboundScheduleId: z.string().optional(),
    returnScheduleId: z.string().optional(), // 仅 FLIGHT_ROUNDTRIP 必填
    flightCabin: z.nativeEnum(CabinClass).optional(),

    // ── BUNDLE ─────────────────────────────────────────────────────────────────
    bundleId: z.string().optional(),
    // 套餐出发日期（YYYY-MM-DD）：批量套餐子单据此匹配套餐绑定航班的当日班次，注入去/回程 FLIGHT 行
    //   → 机票座位 + 房控盖章一次对上。缺省回落 bundle.defaultDepartDate（service 层解析）；两者都缺则该批
    //   逐单优雅失败（不阻断整批）。
    bundleDepartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // 套餐入住晚数 / 占座等（透传给 bundleItemSchema add-on 字段）
    bundleNights: z.number().int().min(1).max(30).optional(),

    // ── 公共字段 ────────────────────────────────────────────────────────────────
    description: z.string().min(1).max(200), // 航段/套餐描述（每张子单写入 item.description）
    // 录入人即登录账号 —— 后端用登录用户名兜底联系人，前台不再要求填写。
    contactName: z.string().min(1).max(120).optional(),
    contactPhone: z.string().min(5).max(40).optional(),
    contactEmail: z.string().email().optional(),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    notes: z.string().max(500).optional(),
    // 签证状态 + 结构化备注四栏（整批共用，写入每张子单）
    ...orderStructuredNotesShape,
    // 运营批量录单时整批归属的代理（仅 ADMIN/STAFF 生效）
    agentId: z.string().optional(),
    // 团队议价结算价（CNY，每位出行人）。仅 ADMIN/STAFF 生效（路由层断言）。
    // 仅对 FLIGHT 行生效（BUNDLE 套餐走 bundleItemSchema 的 server-priced 逻辑）。
    settlementPriceCny: z
      .number()
      .min(0, '结算价不能为负')
      .max(SETTLEMENT_PRICE_CAP_CNY, `结算价超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`)
      .optional(),
    // OTA 线上单快速入单：手动录入的每人结算单价（CNY）。仅 ADMIN/STAFF 生效
    // （路由层 403 早拦 + 服务端按认证身份 400，见 batchCreateOrders）。
    // 与 settlementPriceCny（团队议价，直接覆盖机票行权威价）不同：此值不改机票权威价，
    // 而是由服务端算出系统权威价后，追加一条价格调整行（差额 = 手动价 − 系统价）把订单总额
    // 调到该手动结算价——系统价 / 差额全程可追溯、审计照记。二者互斥（同传 → 路由层 400）。
    manualUnitPriceCny: z
      .number()
      .int('结算单价必须为整数（CNY）')
      .min(0, '结算单价不能为负')
      .max(SETTLEMENT_PRICE_CAP_CNY, `结算单价超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`)
      .optional(),
    // 批量同业优惠（CNY/人）。服务端按每张子单的真实出行人数生成 DISCOUNT 调整行。
    discountPerPersonCny: z
      .number()
      .int('优惠金额必须为整数（CNY）')
      .min(0, '优惠金额不能为负')
      .max(20_000, '单人优惠不能超过 ¥20000')
      .optional(),
    // 团期备注（写入每张子单 notes + noteSpecial）
    groupNote: z.string().max(500).optional(),
    // 允许重复乘客强录（仅 ADMIN/STAFF 生效；透传给每张子单的 createOrder）。
    // 客人重复订票且已付款场景：同班次同证件号本会整批拒，运营确认后带此 flag 放行。
    allowDuplicatePassengers: z.boolean().optional(),
    // 批量幂等键（前端每次提交生成一个 UUID）：整批 HTTP 重试/双击时，每张子单派生稳定幂等键
    // `batch:{batchId}:{index}` 复用 createOrder 的幂等回放 → 同批重复提交每子单只建一次、不双占座。
    // 缺省时后端生成一个同批共享的（仅防同一请求内重复，跨请求重试防不住，故前端应传）。
    batchId: z.string().min(8).max(100).optional(),
    // 每位 → 一单。note 为该乘客个别备注（选填），与整批备注合并写入本人订单 notes。
    // 批量/OTA 入单是新建路径 → 护照有效期必填（见 passengerInputWithRequiredExpirySchema 注释）。
    passengers: z
      .array(
        batchPassengerInputSchema,
      )
      .min(1)
      .max(100),
  })
  .superRefine((val, ctx) => {
    const pt = val.productType;
    const outbound = val.outboundScheduleId ?? val.flightScheduleId;
    if (pt === 'FLIGHT_ONEWAY' || pt === 'FLIGHT_ROUNDTRIP') {
      if (!outbound) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT 类型必须提供 outboundScheduleId（或 flightScheduleId）',
          path: ['outboundScheduleId'],
        });
      }
      if (!val.flightCabin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT 类型必须提供 flightCabin',
          path: ['flightCabin'],
        });
      }
      if (pt === 'FLIGHT_ROUNDTRIP' && !val.returnScheduleId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT_ROUNDTRIP 必须提供 returnScheduleId',
          path: ['returnScheduleId'],
        });
      }
    }
    if (pt === 'BUNDLE') {
      if (!val.bundleId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'BUNDLE 类型必须提供 bundleId',
          path: ['bundleId'],
        });
      }
    } else {
      val.passengers.forEach((passenger, index) => {
        if (passenger.designatedHotelRoomTypeId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: '指定酒店仅适用于 BUNDLE 批量创单',
            path: ['passengers', index, 'designatedHotelRoomTypeId'],
          });
        }
      });
    }
    const hasDiscount = val.discountPerPersonCny !== undefined && val.discountPerPersonCny > 0;
    if (val.manualUnitPriceCny !== undefined && hasDiscount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '优惠与手动结算单价二选一',
        path: ['discountPerPersonCny'],
      });
    }
    if (val.settlementPriceCny !== undefined && hasDiscount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '优惠与团队议价结算价二选一',
        path: ['discountPerPersonCny'],
      });
    }
  });
export type BatchCreateOrdersBody = z.infer<typeof batchCreateOrdersBodySchema>;

// ── 售后改单：改期（reschedule）/ 换人（passenger swap）的费用口径 ──────────────
// PATCH /orders/:id/reschedule（ADMIN/STAFF）：把某条 FLIGHT 行就地改到新班次 + 可选改期差价。
const postSaleFeeSchema = z
  .number()
  .int('费用必须为整数（CNY）')
  .min(0, '费用不能为负')
  .max(POST_SALE_FEE_CAP_CNY, `费用超出上限（${POST_SALE_FEE_CAP_CNY}）`)
  .optional();

// 改期差价：整数 CNY，**可正可负**（改到贵班次补差 / 改到便宜班次退差），±上限同售后费。
// 与换人费（postSaleFeeSchema，只增不减）分开：换人是一次性服务收费，改期是两张票的价差，
// 天然双向。口径与换酒店差价 / 酒店改期差价一致，只是这里仍接受 0 与缺省
//（= 只搬班次不动钱，改期最常见的用法，不该逼运营在留空与传 0 之间二选一）。
const rescheduleFeeSchema = z
  .number()
  .int('差价必须为整数（CNY）')
  .refine((v) => Math.abs(v) <= POST_SALE_FEE_CAP_CNY, {
    message: `差价超出上限（±${POST_SALE_FEE_CAP_CNY}）`,
  })
  .optional();

export const rescheduleOrderBodySchema = z.object({
  orderItemId: z.string().min(1, 'orderItemId 必填'),
  newScheduleId: z.string().min(1, 'newScheduleId 必填'),
  newCabin: z.nativeEnum(CabinClass).optional(), // 缺省沿用原舱位
  feeCny: rescheduleFeeSchema, // 改期差价（CNY，整数，可正可负；0/缺省=不调整价格）
  feeLabel: z.string().max(120).optional(), // 自定义费用名（缺省"改期差价"）
  note: z.string().max(500).optional(),
});
export type RescheduleOrderBody = z.infer<typeof rescheduleOrderBodySchema>;

// ── 售后改单：升舱（经济舱 → 商务舱）───────────────────────────────────────
// POST /orders/:id/items/:itemId/upgrade-cabin（ADMIN/STAFF）：把某条经济舱 FLIGHT 行升到商务舱。
// 目标舱固定商务舱、差价由服务端按航班的升舱差价源 × 人数权威计算——**请求体里不接受任何金额**，
// 运营手填差价的老路（借改期表单填「改期费」）到此为止。
export const upgradeItemCabinBodySchema = z.object({
  note: z.string().max(500).optional(),
});
export type UpgradeItemCabinBody = z.infer<typeof upgradeItemCabinBodySchema>;

// ── 售后改单：换人（passenger swap）─────────────────────────────────────────
// PATCH /orders/:id/passengers/:passengerId（ADMIN/STAFF）：就地改出行人身份 + 可选重置开票/签证 + 换人费。
export const swapPassengerBodySchema = z
  .object({
    // lastName/firstName 各自单段规范化（不做斜线拼接）：与录单入口同款，单段里不允许出现 '/'
    // ——换人同样会把姓名写进库、同样喂给导出层拼 `LAST/FIRST`，正门堵了这扇窗也不能留。
    // fullName 是整名，斜线在这里是合法分隔符，故仍走不带斜线校验的 optionalNormalizedName。
    lastName: optionalPnrSegmentName(120),
    firstName: optionalPnrSegmentName(120),
    fullName: optionalNormalizedName(120),
    // 中文姓名（护照扩展字段；下单时已支持，此处补录/编辑用同一约束）
    chineseName: z.string().max(120).optional(),
    documentNumber: z.string().max(60).optional(),
    // YYYY-MM-DD（与建单 passengerInputSchema / selfUpdatePassengerBodySchema 同款正则）：
    // 此前只校验 z.string()，带时区的完整 ISO 串（如 1990-01-01T00:00:00+08:00）会被 new Date()
    // 折成 UTC 前一天，换人/改生日把出生日期悄悄改错一天。
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender: z.nativeEnum(Gender).optional(),
    // 国籍：换人时的新出行人国籍。证件号变化（= 真换人）时「建议必填」——新出行人不应沿用旧国籍。
    //   注：Zod superRefine 只能硬性 400，而「建议必填」是软约束（不改现有不传国籍即换人的行为、不误伤既有
    //   调用/测试），故此处不做条件强制；由前端在证件号变化时提示补录国籍（真正的硬校验留待后续按业务定夺）。
    nationality: z.string().max(60).optional(),
    // 换人可显式带的新出行人属性（service.swapPassenger 早已按可选接收，此前 schema 未暴露 → 前端传不进来）：
    //   title（称谓）/ passengerType（成人·儿童·婴儿）/ visaExempt（自备签）/ singleRoom（单住）。
    title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'DR']).optional(),
    passengerType: z.nativeEnum(PassengerType).optional(),
    visaExempt: z.boolean().optional(),
    singleRoom: z.boolean().optional(),
    resetInvoice: z.boolean().optional(), // → 开票状态回 NONE
    resetVisa: z.boolean().optional(), // → 该订单 VISA 履约任务回 PENDING
    feeCny: postSaleFeeSchema, // 换人费（CNY，整数；0/缺省=不收）
    feeLabel: z.string().max(120).optional(), // 自定义费用名（缺省"换人费"）
    note: z.string().max(500).optional(),
  })
  // 至少改一项身份字段，或触发一次重置/收费 —— 防空 PATCH
  .refine(
    (b) =>
      b.lastName !== undefined ||
      b.firstName !== undefined ||
      b.fullName !== undefined ||
      b.chineseName !== undefined ||
      b.documentNumber !== undefined ||
      b.dateOfBirth !== undefined ||
      b.gender !== undefined ||
      b.nationality !== undefined ||
      b.title !== undefined ||
      b.passengerType !== undefined ||
      b.visaExempt !== undefined ||
      b.singleRoom !== undefined ||
      b.resetInvoice === true ||
      b.resetVisa === true ||
      (b.feeCny ?? 0) > 0,
    { message: '换人请求需至少包含一项身份变更 / 重置 / 费用' },
  );
export type SwapPassengerBody = z.infer<typeof swapPassengerBodySchema>;

/**
 * PATCH /orders/:id/passengers/:passengerId/visa-exempt —— 建单后按人改自备签（专用端点）。
 *
 * 与换人通道（swapPassengerBodySchema 的 visaExempt 透传）不同：这里是「同一个人改办签方式」，
 * 钱走 BUNDLE 行按建单快照费率的对称重算（服务端权威，body 不收任何金额），不走换人的
 * SWAP_VISA_DEDUCT_REVERSAL 调整行。
 */
export const setPassengerVisaExemptBodySchema = z.object({
  visaExempt: z.boolean(),
  note: z.string().max(500).optional(),
  // 送签已在办理（材料准备/已送签）时改自备签的「人为确认」（签证岗 2026-08-30 口径：
  // 退不退、退多少由人当场定，系统不硬拦也不自动退）。缺省不带 → 服务端拒并提示确认；
  // refundCny = 本次退给客人的金额（0 = 不退，上限为该单自备签减免费率，服务端钳位校验）。
  submittedOverride: z
    .object({
      refundCny: z.number().int().min(0),
      reason: z.string().trim().min(1, '请填写退费/不退费的原因').max(200),
    })
    .optional(),
});
export type SetPassengerVisaExemptBody = z.infer<typeof setPassengerVisaExemptBodySchema>;

/**
 * PATCH /orders/:id/passengers/:passengerId 的「换人语义字段」——只出现在换人（swap）语义里、
 * 补录 schema（selfUpdatePassengerBodySchema）里没有的键。请求体带其中任一，即表达「换成另一个人 /
 * 重置开票或签证 / 收换人费」的意图，唯一指向换人分支。
 * （chineseName/documentNumber/dateOfBirth/gender/nationality 两个 schema 都有，不能用来区分，故不列。）
 *
 * 本集合必须与 swapPassengerBodySchema「独有的键」保持一致：漏了哪个，只带该字段提交就会被分流到
 * 补录通道，而补录 schema 是 .strict() 的 → 400，且换人通道后面挂着的联动（自备签变更 →
 * 签证任务同步）也整条跑不到。title / passengerType / visaExempt / singleRoom 四项即因此补入。
 */
export const SWAP_PASSENGER_SEMANTIC_FIELDS: readonly string[] = [
  'lastName',
  'firstName',
  'fullName',
  // 新出行人属性（补录 schema 里没有 → 可用于分流）
  'title',
  'passengerType',
  'visaExempt',
  'singleRoom',
  'resetInvoice',
  'resetVisa',
  'feeCny',
  'feeLabel',
  'note',
];

/**
 * 同一路径双通道判定（纯函数，供路由与单测复用）：返回 'SWAP' 走换人分支，'SELF_UPDATE' 走补录分支。
 *
 * 判定规则：
 *   - CUSTOMER / AGENT（前台）：一律 'SELF_UPDATE'（自助补录护照/证件资料；换人只能联系客服）。
 *   - ADMIN / STAFF（运营）：请求体带任一「换人语义字段」→ 'SWAP'（换人）；否则 → 'SELF_UPDATE'
 *     （运营只想补 passportIssueDate/passportExpiry/护照图 等证件资料时，走补录同款更新路径，
 *      不该被换人 schema 400——换人 schema 无护照字段）。
 */
export function resolvePassengerPatchChannel(
  role: UserRole,
  body: unknown,
): 'SWAP' | 'SELF_UPDATE' {
  const isInternal = role === UserRole.ADMIN || role === UserRole.STAFF;
  if (!isInternal) return 'SELF_UPDATE';
  const raw = (body ?? {}) as Record<string, unknown>;
  const hasSwapSemantics = SWAP_PASSENGER_SEMANTIC_FIELDS.some((key) => raw[key] !== undefined);
  return hasSwapSemantics ? 'SWAP' : 'SELF_UPDATE';
}

// ── B4: 改结算价（ADMIN/STAFF）────────────────────────────────────────────────
// PATCH /orders/:id/items/:itemId/settlement-price
// 仅允许 kind=FLIGHT；事务内重算 order.subtotal/total；
// 不走 adjustmentCny（那是售后费用，这是基础价订正）。
export const updateItemSettlementPriceBodySchema = z.object({
  unitPriceCny: z
    .number()
    .positive('结算价必须大于 0')
    .max(SETTLEMENT_PRICE_CAP_CNY, `结算价超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`),
  reason: z.string().max(500).optional(),
});
export type UpdateItemSettlementPriceBody = z.infer<typeof updateItemSettlementPriceBodySchema>;

// ── 售后改单：换酒店（hotel swap）───────────────────────────────────────────
// PATCH /orders/:id/items/:itemId/hotel（ADMIN/STAFF）：把某条 HOTEL 行（或已盖章酒店的
// BUNDLE 行）就地换到另一个房型/酒店。定价哲学（owner 批准 A+B）：价格默认冻结——绝不按新
// 房型的 basePrice 重算 unitPrice/amount；feeCny 是可选的人工调整（可正可负，与改期费/换人费
// 同一 adjustmentCny 机制）。0 没有意义（"不调整"应留空不传该字段），故显式拒绝。
const hotelSwapFeeSchema = z
  .number()
  .int('金额必须为整数（CNY）')
  .refine((v) => v !== 0, { message: '金额不能为 0（不调整价格请留空，不要传 0）' })
  .refine((v) => Math.abs(v) <= POST_SALE_FEE_CAP_CNY, {
    message: `金额超出上限（±${POST_SALE_FEE_CAP_CNY}）`,
  })
  .optional();

export const swapItemHotelBodySchema = z.object({
  newHotelRoomTypeId: z.string().min(1, 'newHotelRoomTypeId 必填'),
  feeCny: hotelSwapFeeSchema, // 换酒店差价（CNY，整数，可负；不填/不传=不调整价格）
  feeLabel: z.string().max(60).optional(), // 自定义费用名（缺省"换酒店差价"）
  note: z.string().max(200).optional(),
  // 星级不匹配放行原因（字段名与录单口径 bundleItemSchema 一致，前端一套表单复用）：
  // 换入酒店的星级与该 BUNDLE 行所属套餐的结算档次对不上 → 必须写原因才放行（审计留痕）。
  designatedHotelStarMismatchReason: z.string().trim().min(1).max(200).optional(),
});
export type SwapItemHotelBody = z.infer<typeof swapItemHotelBodySchema>;

// ── 售后改单：酒店改期（hotel reschedule）──────────────────────────────────
// PATCH /orders/:id/items/:itemId/hotel-reschedule（ADMIN/STAFF）：把某条 HOTEL 行的
// 入住/退房日期整体挪到新区间（房控占房随之从旧区间释放、落到新区间）。
// 定价哲学与换酒店同一套：**行价冻结** —— 晚数变了也绝不重算 unitPrice/amount/quantity，
// 差额由 feeCny 走售后费（与改期费/换人费/换酒店差价同一 adjustmentCny 机制）。
// feeCny 复用换酒店那条（整数、可正可负、±上限、显式拒绝 0）。
export const rescheduleItemHotelBodySchema = z.object({
  newCheckIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '入住日期格式应为 YYYY-MM-DD'),
  newCheckOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '退房日期格式应为 YYYY-MM-DD'),
  feeCny: hotelSwapFeeSchema, // 酒店改期差价（CNY，整数，可负；不填/不传=不调整价格）
  feeLabel: z.string().max(60).optional(), // 自定义费用名（缺省"酒店改期差价"）
  note: z.string().max(200).optional(),
});
export type RescheduleItemHotelBody = z.infer<typeof rescheduleItemHotelBodySchema>;

// ── 售后改单：按房组拆分酒店行（split room group）───────────────────────────
// POST /orders/:id/items/:itemId/split-room-group（ADMIN/STAFF）：把分房表里的一个房组从
// 某条 HOTEL 行拆成独立酒店行 —— 「按房组换酒店」的前置步骤（拆完对新行走现成换酒店端点）。
// 钱不动（新行 0 元、源行 amount 冻结），只挪库存归属与成本比例；守卫与守恒断言见 service。
export const splitRoomGroupBodySchema = z.object({
  roomGroupId: z.string().min(1, 'roomGroupId 必填'),
  note: z.string().max(200).optional(),
});
export type SplitRoomGroupBody = z.infer<typeof splitRoomGroupBodySchema>;

// ── 售后改单：套餐改档（change bundle）──────────────────────────────────────
// POST /orders/:id/change-bundle（ADMIN/STAFF）：把本单的套餐行换绑到另一张套餐
// （行业口径 amendment：改档 → 按新档重新计价 → 差价入账 → 审计）。
// 「档次」在数据模型上就是另一条 Bundle 记录（settlementTier / settlementNights 是 Bundle 的属性），
// 故改档 = 换 bundleId，不是改某个字段。
//   · note 同时进审计与差额行的调价原因（人眼可读地解释这笔差价）。
//   · 机票行/班次/座位一律不动（改档不改航班）；酒店已落位到真实酒店的单先走换酒店。
export const changeOrderBundleBodySchema = z.object({
  bundleId: z.string().min(1, 'bundleId 必填'),
  note: z.string().max(200).optional(),
});
export type ChangeOrderBundleBody = z.infer<typeof changeOrderBundleBodySchema>;

// ── T5：更改订单归属代理（PATCH /orders/:id/agent；ADMIN/STAFF）─────────────────
// 服务端硬守卫逐单校验；agentId=null（或空串归一为 null）= 转直客。
// 财务不回溯：已发生的收款/代理余额抵扣/佣金流水按原归属，不因改归属而回滚；变更后新产生的按新归属。
export const changeOrderAgentBodySchema = z.object({
  // 空串归一为 null（前端「直客」选项传空串）；非空则须是有效代理 id（服务端再校验存在且在用）。
  agentId: z.preprocess((v) => (v === '' ? null : v), z.string().min(1).nullable()),
  reason: z.string().max(500).optional(),
});
export type ChangeOrderAgentBody = z.infer<typeof changeOrderAgentBodySchema>;

// ── 事后补收单房差（POST /orders/:id/room-supplement；ADMIN/STAFF）───────────────
// 金额 = perNightCny × nights；新增一条 FEE 调整行 + 重算 order.subtotal/total + 追加审计流水。
// 仅含 BUNDLE/HOTEL 行的订单可用（纯机票单无住宿 → 服务端拒绝）。
export const ROOM_SUPPLEMENT_MAX_NIGHTS = 60;
export const roomSupplementBodySchema = z.object({
  perNightCny: z
    .number()
    .int('每晚金额必须为整数（CNY）')
    .positive('每晚金额必须大于 0')
    .max(POST_SALE_FEE_CAP_CNY, `每晚金额超出上限（${POST_SALE_FEE_CAP_CNY}）`),
  nights: z
    .number()
    .int('晚数必须为整数')
    .min(1, '晚数至少 1')
    .max(ROOM_SUPPLEMENT_MAX_NIGHTS, `晚数最多 ${ROOM_SUPPLEMENT_MAX_NIGHTS}`),
  note: z.string().max(500).optional(),
  // 幂等键（可选，客户端生成）：同 key 重试只入账一次，防双击/超时重发叠加多条 FEE 行。
  idempotencyKey: z.string().min(8).max(128).optional(),
  // 转单住的乘客（可选，A15 房控联动）：传了则同事务把该乘客标记 singleRoom=true，
  // 并按权威公式重算套餐行计费房数 —— 房控销控板/分房/超卖提醒是派生账，随之自动跟上。
  // 不传 = 旧行为（只收钱，房控不动），兼容存量调用方。
  passengerId: z.string().min(1).max(64).optional(),
});
export type RoomSupplementBody = z.infer<typeof roomSupplementBodySchema>;

// ── 订单详情补录结构化地面项（POST /orders/:id/items/ground；ADMIN/STAFF）──
// unitPriceCny 省略时由服务端按产品 costPriceCny 带出，显式传值表示运营手改售价。
const groundItemCommonSchema = z.object({
  unitPriceCny: z.number().finite().nonnegative('售价不能为负').optional(),
  note: z.string().max(500).optional(),
});

export const addGroundItemBodySchema = z.discriminatedUnion('kind', [
  groundItemCommonSchema.extend({
    kind: z.literal('VISA'),
    visaId: z.string().min(1, 'visaId 必填'),
    quantity: z.number().int().min(1).max(99).optional(),
    // 预计出行日期（可选，YYYY-MM-DD）：与建单 visaItemSchema 同款字段与校验。
    // 补录的签证行同样是订单「出发日」的第三级锚点——建单能填、补录填不了的话，
    // 「先建单后补签证」的纯签证单按出发日期导出时仍旧派生不出日期。
    visaIntendedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, '预计出行日期格式应为 YYYY-MM-DD')
      .optional(),
  }),
  groundItemCommonSchema.extend({
    kind: z.literal('HOTEL'),
    hotelRoomTypeId: z.string().min(1, 'hotelRoomTypeId 必填'),
    nights: z.number().int().min(1, '晚数至少 1'),
    rooms: z.number().multipleOf(0.5).min(0.5, '间数至少 0.5'),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '入住日期格式应为 YYYY-MM-DD').optional(),
  }),
]);
export type AddGroundItemBody = z.infer<typeof addGroundItemBodySchema>;

// ── 拆单 v1（split PNR 售后逃生门；ADMIN/STAFF）─────────────────────────────
// POST /orders/:id/split-preview：只读预检 —— 跑全部准入闸 + 每人份额计算，返回
// blockers（人话，每条一个不满足的闸）与 shares/movedShareCny/movedPaidCny/hotelItems。
// POST /orders/:id/split：执行拆单。requestToken 为幂等键（同源单同 token 重试只回放既有结果）。
// roomSplit 只传间数（0.5 网格），金额由服务端按间数比例权威拆分 —— 前端不传任何金额。
export const splitOrderPreviewBodySchema = z.object({
  passengerIds: z.array(z.string().min(1)).min(1, '至少选择 1 位乘客').max(99),
  // 与执行体同名同义：勾上它预检就按「混合房组自动劈半」的口径评估（no-show / 按人改期弹窗用），
  // 不勾则同房组闸照旧作为 blocker 回给运营。
  autoSplitRoomGroups: z.boolean().optional(),
});
export type SplitOrderPreviewBody = z.infer<typeof splitOrderPreviewBodySchema>;

export const splitOrderBodySchema = z.object({
  passengerIds: z.array(z.string().min(1)).min(1, '至少选择 1 位乘客').max(99),
  // 酒店行**与套餐住宿行**都收（套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上）。
  roomSplit: z
    .array(
      z.object({
        itemId: z.string().min(1, 'itemId 必填'),
        // 显式 0 = 「这一行整块留在源单」（套餐住宿行也一样）；只有**缺省**（不给这一行）
        // 才走自动派生。两者语义不同，故下限是 0 而不是 0.5。
        roomsBilledToMove: z
          .number()
          .multipleOf(0.5, '随拆搬走的间数必须是 0.5 的整数倍')
          .min(0, '随拆搬走的间数不能为负'),
      }),
    )
    .max(50)
    .optional(),
  // 升舱位随拆搬走几个：一行一腿，toMove 直接给这一行搬几个。
  // 不传 = 按占座人头自动派生；两侧都不能记比自己座位还多的升舱位（服务端校验）。
  // outboundToMove / returnToMove 是旧形状（一条 entry 同时带两腿的数），继续兼容：
  // 服务端按该行实际归属的航段取对应字段。新前端只发 toMove。
  upgradeSplit: z
    .array(
      z.object({
        itemId: z.string().min(1, 'itemId 必填'),
        toMove: z.number().int().min(0).max(99).optional(),
        outboundToMove: z.number().int().min(0).max(99).optional(),
        returnToMove: z.number().int().min(0).max(99).optional(),
      }),
    )
    .max(10)
    .optional(),
  // 混合房组（一半走一半留）自动劈成两个半组：no-show / 按人改期编排传 true。
  // 手工拆单默认 false —— 同房组闸照旧拒拆，让运营自己先在分房里把人分开。
  autoSplitRoomGroups: z.boolean().optional(),
  note: z.string().max(200).optional(),
  // 与占位单转正同款幂等键口径（uuid）：同 (源单, token) 重试只回放既有结果。
  requestToken: z.string().min(8).max(64).uuid(),
});
export type SplitOrderBody = z.infer<typeof splitOrderBodySchema>;

// ── 取消航段（POST /orders/:id/cancel-leg；ADMIN/STAFF）──────────────────────────
// 场景：往返单（含套餐单）的客人只飞其中一段 —— 另一段不要了。按航司/包机行业标准的
// 「取消航段（partial cancellation）」处理：被取消那一段的座位放回库存重卖、订单变单程、
// 手续费按取消政策计算。
//   leg=RETURN   取消回程，保留去程 → 单去程单（老路径 /cancel-return-leg 即此语义）；
//   leg=OUTBOUND 取消去程，保留回程 → 单回程单（客人去程 noshow、只留回程的场景）。
// leg 缺省为 RETURN：老前端与老调用方不带该字段时行为完全不变。
//
// 金额口径（服务端权威定价，请求体不接受任何「应退多少」）：
//   feeMode=POLICY  → 手续费由服务端按取消政策对**被取消那一行**报价，请求体不带金额；
//   feeMode=MANUAL  → 运营手工覆盖，必须同时给出金额与原因（原因进审计与调价行文案）。
// 上限：手工金额 ≤ 被取消航段行金额（由 service 校验，schema 只管格式与调价行通用上限）。
// 退多少钱不由本端点决定：它只把应收降下来，多收部分走既有多收/退款流程。
// requestToken 为幂等键：同 (订单, token) 重试只回放既有结果，绝不二次放座、二次收手续费。
export const flightLegSideSchema = z.enum(['OUTBOUND', 'RETURN']);
export type FlightLegSide = z.infer<typeof flightLegSideSchema>;

/** 预检请求体：只有 leg（缺省 RETURN），空 body 即老口径的「取消回程预检」。 */
export const cancelLegPreviewBodySchema = z.object({
  leg: flightLegSideSchema.default('RETURN'),
});
export type CancelLegPreviewBody = z.infer<typeof cancelLegPreviewBodySchema>;

export const cancelLegBodySchema = z
  .object({
    requestToken: z.string().min(8).max(64).uuid(),
    leg: flightLegSideSchema.default('RETURN'),
    feeMode: z.enum(['POLICY', 'MANUAL']),
    manualFeeCny: z
      .number()
      .int('手续费必须为整数（CNY）')
      .min(0, '手续费不能为负')
      .max(PRICE_ADJUSTMENT_CAP_CNY, `手续费超出上限（${PRICE_ADJUSTMENT_CAP_CNY}）`)
      .optional(),
    overrideReason: z.string().max(200).optional(),
    note: z.string().max(200).optional(),
    // 非阻断提示的「我已知悉」回执：预检 requiresAcknowledgement=true 时前端弹二次确认，
    // 确认后带 true 再提交。缺省 false —— 有 warnings 而未确认，服务端回 400
    // ACKNOWLEDGEMENT_REQUIRED，绝不静默放行（已出票的段被取消是需要票务善后的动作）。
    acknowledgeWarnings: z.boolean().optional(),
  })
  .refine((v) => v.feeMode !== 'MANUAL' || v.manualFeeCny != null, {
    message: '手工指定手续费时必须填写金额（整数 CNY，可为 0）',
    path: ['manualFeeCny'],
  })
  .refine((v) => v.feeMode !== 'MANUAL' || Boolean(v.overrideReason?.trim()), {
    message: '手工覆盖取消政策手续费时必须填写原因',
    path: ['overrideReason'],
  });
export type CancelLegBody = z.infer<typeof cancelLegBodySchema>;

// 老路径 POST /orders/:id/cancel-return-leg 的请求体 = 同一张 schema（leg 缺省 RETURN），
// 保留别名让既有调用方与用例不必改动。
export const cancelReturnLegBodySchema = cancelLegBodySchema;
export type CancelReturnLegBody = Omit<CancelLegBody, 'leg'>;

// ── 去程 no-show / 回程释放（POST /orders/:id/no-show；ADMIN/STAFF）────────────────
// 场景：航司每天发 no-show 名单。客人没登机 —— 去程钱不动不退、成本不动，只打一个
// no-show 标；回程座位释放回库存可以继续卖（钱同样不动）。
//
// ⚠ 与「取消航段」是两件事，别混：
//   取消回程 = 客人主动退这一段，按取消政策收手续费、应收下降（钱要动）；
//   no-show 释放 = 客人没来、公司把空出来的回程座位收回重卖，**一分钱不动**
//                （不改 unitPrice/amount/成本/subtotal/total，不改开票状态）。
//
// passengerIds 缺省 = 全员 no-show；只勾部分人 → 服务端先按所选乘客拆单（票随人走）、
// 再对拆出的新单标记，与「按人改期」同一条 Split PNR 编排。
// releaseReturn 缺省 true：极少数只想打标不放座的情况可显式传 false。
// requestToken 为幂等键：同 (订单, token) 重试只回放，座位绝不二次释放。
export const noShowPreviewBodySchema = z.object({
  // 缺省（不传）才是整单；`[]` 是**没勾任何人**，一律拒 —— 曾经空数组被当成整单，
  // 前端一个交互 bug 就能把整单的人全标上，且请求体看上去完全正常。
  passengerIds: z.array(z.string().min(1)).min(1, '至少选择 1 位乘客').max(99).optional(),
  // 「同时释放回程」勾选框的当前状态（缺省 true，与执行体同缺省）。
  // 预检要拿它才能如实回「回程已起飞 → 不能释放座位」这条闸；否则运营点了提交才被拒。
  releaseReturn: z.boolean().optional(),
});
export type NoShowPreviewBody = z.infer<typeof noShowPreviewBodySchema>;

export const noShowBodySchema = z.object({
  requestToken: z.string().min(8).max(64).uuid(),
  // 缺省（不传）才是整单；`[]` 是「没勾任何人」→ 直接拒（口径同预检，service 侧另有一道防御）。
  passengerIds: z
    .array(z.string().min(1))
    .min(1, '至少选择 1 位乘客')
    .max(99)
    .optional()
    .refine((ids) => ids == null || new Set(ids).size === ids.length, {
      message: '所选乘客不得重复',
    }),
  releaseReturn: z.boolean().default(true),
  note: z.string().max(200).optional(),
});
export type NoShowBody = z.infer<typeof noShowBodySchema>;

// ── 恢复回程（POST /orders/:id/restore-return-leg；ADMIN/STAFF）─────────────────
// 代理来说「这位客人还要回程」→ 票务把之前释放掉的回程恢复回**原班次**。
// 有座直接占；没座允许超售（前端二次确认 → allowOversell=true），后端记 CRITICAL 审计。
// 系统不设通知时限或门槛，能不能恢复只看余位与班次是否已起飞。
export const restoreReturnLegBodySchema = z.object({
  requestToken: z.string().min(8).max(64).uuid(),
  // 余位不足时的「确认超售」回执；缺省 false → 服务端回 409 OVERSELL_CONFIRMATION_REQUIRED。
  allowOversell: z.boolean().default(false),
  note: z.string().max(200).optional(),
});
export type RestoreReturnLegBody = z.infer<typeof restoreReturnLegBodySchema>;

// ── 回程起飞后作废（POST /orders/:id/void-return-leg；ADMIN/STAFF）────────────────
// 「已释放」不是终态：no-show 把回程座位放回库存后，这一行会一直挂在单上等人处置。
// 原班次一飞走，「恢复回程」就走不通了，而提醒还在一直催 —— 作废给这一行一个终态。
//
// ⚠ 只打终态标：**不动座位**（释放那一步早就还回库存了）、**不动一分钱**
//（no-show 全程钱不动；要退钱走既有退款流程）、不动开票位。
// 起飞前不许作废：那时候「恢复回程」还走得通，作废等于把客人的回程凭空抹掉。
// requestToken 为幂等键：同 (订单, token) 重试只回放。
export const voidReturnLegBodySchema = z.object({
  requestToken: z.string().min(8).max(64).uuid(),
  note: z.string().max(200).optional(),
});
export type VoidReturnLegBody = z.infer<typeof voidReturnLegBodySchema>;

// ── 按人改期（POST /orders/:id/reschedule-passengers；ADMIN/STAFF）──────────────
// 场景：三人一单，只给其中一位客人改航班。一单一行程是全站硬约束（去/回程各一条 FLIGHT 行），
// 同一订单里塞不下「两个人飞 A 班次、一个人飞 B 班次」，所以走行业标准的 Split PNR：
//   先按所选乘客把订单拆成新单（既有拆单 v1，服务端权威算钱），再对**新单**改期。
// 勾选全员 = 没什么好拆的，等价于现有整单改期（不拆单）。
//
// 金额口径：只透传 feeCny（改期差价，可正可负，±上限同 rescheduleFeeSchema），
// 拆单侧的份额/已收转移一律由服务端按人头权威计算 —— 本请求体不接受任何金额覆盖。
// roomSplit 与拆单同形（只传间数，0.5 网格）：拆出的人占着酒店房时需显式说明搬走几间。
// requestToken 为幂等键：同 (源单, token) 重试只回放既有拆单，不会拆出第二张新单。
export const reschedulePassengersBodySchema = z.object({
  passengerIds: z
    .array(z.string().min(1))
    .min(1, '至少选择 1 位乘客')
    .max(99)
    .refine((ids) => new Set(ids).size === ids.length, { message: '所选乘客不得重复' }),
  // 要改的航段行（源单上的 FLIGHT 行 id）：服务端据此判定去程/回程，再在新单上按航段定位。
  orderItemId: z.string().min(1, 'orderItemId 必填'),
  newScheduleId: z.string().min(1, 'newScheduleId 必填'),
  newCabin: z.nativeEnum(CabinClass).optional(), // 缺省沿用原舱位（改期不许改舱，同单条改期口径）
  feeCny: rescheduleFeeSchema, // 改期差价（CNY，整数，可正可负；0/缺省=不调整价格）
  feeLabel: z.string().max(120).optional(),
  // 与拆单 note 同上限（本字段同时带给拆单流水与改期流水）
  note: z.string().max(200).optional(),
  roomSplit: splitOrderBodySchema.shape.roomSplit,
  requestToken: z.string().min(8).max(64).uuid(),
});
export type ReschedulePassengersBody = z.infer<typeof reschedulePassengersBodySchema>;
