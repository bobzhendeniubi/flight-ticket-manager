/**
 * Domain-level error classes. Mapped to HTTP responses by the error-handler plugin.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts: { statusCode?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.details = opts.details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, { statusCode: 400, code: 'BAD_REQUEST', details });
    this.name = 'BadRequestError';
  }
}

/**
 * 同一航班班次的「占座中」订单里已有同证件号乘客。
 * 稳定 code=DUPLICATE_PASSENGER，前端据此弹「确认重复录入」二次确认（不靠中文文案匹配）；
 * details.conflicts 带证件号 + 冲突订单号，供前端组织确认文案。
 */
export class DuplicatePassengerError extends AppError {
  constructor(message = '存在重复乘客', details?: unknown) {
    super(message, { statusCode: 400, code: 'DUPLICATE_PASSENGER', details });
    this.name = 'DuplicatePassengerError';
  }
}

/**
 * 前台展示价与服务端权威商品价不一致（下单前的价格漂移兜底）。
 * 稳定 code=PRICE_CHANGED，前端据此提示「价格已更新，请刷新页面后重新下单」（不靠中文文案匹配），
 * 绝不静默按新价多收 —— 见 createOrder 里 expectedTotalCny 比对。
 */
export class PriceChangedError extends AppError {
  constructor(message = '价格已更新，请刷新页面后重新下单', details?: unknown) {
    super(message, { statusCode: 400, code: 'PRICE_CHANGED', details });
    this.name = 'PriceChangedError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { statusCode: 404, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) {
    super(message, { statusCode: 409, code: 'CONFLICT', details });
    this.name = 'ConflictError';
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = 'Unprocessable entity', details?: unknown) {
    super(message, { statusCode: 422, code: 'UNPROCESSABLE_ENTITY', details });
    this.name = 'UnprocessableEntityError';
  }
}
