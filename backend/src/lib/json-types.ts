/**
 * Prisma JSON 字段类型辅助。
 *
 * Prisma 的 InputJsonValue 是 readonly recursive union，直接传 Record<string, unknown>
 * 或 Array 会被 TS 拒。我们用 asJson() 做明确转换（运行时纯粹身份函数）。
 */
import { Prisma } from '@prisma/client';

/**
 * 把"应当是可序列化 JSON"的值转成 Prisma 的 InputJsonValue。
 * 运行时没有开销 —— 纯类型层的 assert。
 * 注意：调用方要自己保证不含 undefined / Function / BigInt / Date 等非 JSON 值。
 */
export function asJson<T>(value: T | null | undefined): Prisma.InputJsonValue {
  return (value ?? null) as unknown as Prisma.InputJsonValue;
}

/** Bundle.items 结构 */
export interface BundleItemJson {
  kind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';
  productName: string;
  qty: number;
  unitPrice: number;
}

/** FulfillmentTask.data 结构（按 type 分支） */
export interface FulfillmentDataJson {
  pnr?: string;
  eTicketNumber?: string;
  confirmationNumber?: string;
  applicationNumber?: string;
  progress?: string;
  driverName?: string;
  vehicleNumber?: string;
  [k: string]: string | undefined;
}
