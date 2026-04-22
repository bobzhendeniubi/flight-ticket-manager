import { z } from 'zod';
import {
  CabinClass,
  DocumentType,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
} from '@prisma/client';

// ── 下单 ─────────────────────────────────────────────────────────────────
// 乘客信息
export const passengerInputSchema = z.object({
  fullName: z.string().min(1).max(120),
  documentType: z.nativeEnum(DocumentType).default('PASSPORT'),
  documentNumber: z.string().min(3).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality: z.string().length(2).default('CN'),
  passengerType: z.nativeEnum(PassengerType).default('ADULT'),
  mealPreference: z.string().max(40).optional(),
  needsWheelchair: z.boolean().optional(),
  needsInfantBassinet: z.boolean().optional(),
});
export type PassengerInput = z.infer<typeof passengerInputSchema>;

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
});

export const hotelItemSchema = baseItemSchema.extend({
  kind: z.literal('HOTEL'),
  hotelRoomTypeId: z.string().min(1).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unitPrice: z.number().nonnegative(),
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
});

export const bundleItemSchema = baseItemSchema.extend({
  kind: z.literal('BUNDLE'),
  bundleId: z.string().min(1),
  unitPrice: z.number().nonnegative(),
});

export const orderItemInputSchema = z.discriminatedUnion('kind', [
  flightItemSchema,
  hotelItemSchema,
  transferItemSchema,
  visaItemSchema,
  bundleItemSchema,
]);
export type OrderItemInput = z.infer<typeof orderItemInputSchema>;

export const createOrderBodySchema = z.object({
  contactName: z.string().min(1).max(120),
  contactPhone: z.string().min(5).max(40),
  contactEmail: z.string().email().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  items: z.array(orderItemInputSchema).min(1).max(20),
  passengers: z.array(passengerInputSchema).min(1).max(20),
  notes: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

// ── 列表 / 详情 ─────────────────────────────────────────────────────────
export const listOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  agentId: z.string().optional(),
  kind: z.nativeEnum(OrderItemKind).optional(),
  search: z.string().max(120).optional(), // 订单号/姓名/电话
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ── 状态流转 ─────────────────────────────────────────────────────────────
export const updateStatusBodySchema = z.object({
  toStatus: z.nativeEnum(OrderStatus),
  reason: z.string().max(500).optional(),
});
export type UpdateStatusBody = z.infer<typeof updateStatusBodySchema>;
