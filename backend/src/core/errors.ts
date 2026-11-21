/** Domain/HTTP error. `code` is a stable machine-readable identifier for API clients. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Thrown when a row lock cannot be taken immediately; the job is retried shortly without counting as a failure. */
export class ResourceBusyError extends Error {
  constructor(resource: string) {
    super(`${resource} is busy.`);
    this.name = 'ResourceBusyError';
  }
}

export const err = {
  badRequest: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(400, code, message, details),
  unauthorized: (message = 'Authentication required.') => new AppError(401, 'unauthorized', message),
  forbidden: (code: string, message: string) => new AppError(403, code, message),
  notFound: (entity: string) => new AppError(404, 'not_found', `${entity} not found.`),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(422, code, message, details),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
  upstream: (code: string, message: string) => new AppError(502, code, message),
};
