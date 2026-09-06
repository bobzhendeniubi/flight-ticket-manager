/**
 * 跨模块共用的响应形状。
 *
 * 注意：本文件（以及各模块里的 DTO 类型）**只做类型**，后端响应路径上不加 parse。
 * 出参再跑一遍 zod 是白花运行时开销，而且一旦某条真实数据不合 schema，受害的是
 * 正在用系统的人，不是写代码的人 —— 出参的正确性该由类型和测试保证，不该由运行时兜。
 */

/** 分页信封：全后端列表接口统一这三个字段（page 从 1 起）。 */
export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

/**
 * 分页列表响应的信封部分。后端各模块返回的是 `{ <复数名>: T[], pagination }`，
 * 数据键名各不相同（orders / customers / travelers …），所以这里只给公共的那一半，
 * 用法：`type ListOrdersResponse = { orders: OrderSummary[] } & Paginated`。
 */
export interface Paginated {
  pagination: Pagination;
}
