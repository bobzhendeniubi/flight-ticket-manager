/**
 * 错误信封与稳定错误码 —— 前后端按 code 对话的那一层。
 *
 * 前端**从不**靠中文文案匹配错误（文案随时会改），一律看 `error.code`。所以这些码
 * 本身就是契约：后端抛的时候用这里的常量，前端判的时候也用这里的常量，改一处两边一起动。
 *
 * 以前的样子：后端在 lib/errors.ts 里写字符串字面量，两个前端各自在 api.ts 里
 * 又敲一遍同样的字符串，还各自复制了一份一模一样的 ApiErrorBody。
 */

/** 所有非 2xx 响应的统一信封（error-handler 插件的输出形状）。 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * 通用错误码（HTTP 语义那一层）。
 * 值与 backend/src/lib/errors.ts 里各 AppError 子类逐字一致。
 */
export const API_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/**
 * 业务错误码：前端见到它们要做的**不是**弹个红条，而是走一条专门的分支
 *（二次确认、引导去别的单、提示刷新重下）。所以每一个都必须稳定。
 */
export const BUSINESS_ERROR_CODES = {
  /** 同班次占座中的订单里已有同证件号乘客 → 弹「确认仍要录入」，确认后带 allowDuplicatePassengers 重试。 */
  DUPLICATE_PASSENGER: 'DUPLICATE_PASSENGER',
  /** 近 N 分钟内同订单已有等额收款 → 弹二次确认，确认后带 confirmDuplicate 重试。 */
  DUPLICATE_AMOUNT: 'DUPLICATE_AMOUNT',
  /** 前台展示价与服务端权威价不一致 → 提示刷新后重下，绝不静默按新价多收。 */
  PRICE_CHANGED: 'PRICE_CHANGED',
  /** 按人改期：乘客已被拆成新单，但对新单改期这一步失败了 → 引导去新单重试，不能当普通失败丢掉新单号。 */
  SPLIT_DONE_RESCHEDULE_FAILED: 'SPLIT_DONE_RESCHEDULE_FAILED',
} as const;
export type BusinessErrorCode = (typeof BUSINESS_ERROR_CODES)[keyof typeof BUSINESS_ERROR_CODES];

/** DUPLICATE_AMOUNT 的 details（后端保证这三个字段都在）。 */
export interface DuplicateAmountDetails {
  existingPaymentId: string;
  amount: number;
  windowMinutes: number;
}

/** DUPLICATE_PASSENGER 的 details：每条冲突带证件号/姓名与撞上的订单号。 */
export interface DuplicatePassengerConflict {
  documentNumber?: string;
  fullName?: string;
  orderNumbers?: string[];
}
export interface DuplicatePassengerDetails {
  conflicts: DuplicatePassengerConflict[];
}

/** SPLIT_DONE_RESCHEDULE_FAILED 的 details：已经拆出来的那张新单。 */
export interface ReschedulePassengersSplitFailureDetails {
  newOrderId: string;
  newOrderNumber: string;
  passengerCount?: number;
  reason?: string;
}
