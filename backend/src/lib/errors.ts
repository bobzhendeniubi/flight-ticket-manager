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
