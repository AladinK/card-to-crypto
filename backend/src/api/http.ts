import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { AppError, err } from '../core/errors.js';
import type { Logger } from '../logger.js';

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw zodToAppError(result.error);
  return result.data;
}

export function zodToAppError(error: ZodError): AppError {
  return new AppError(422, 'invalid_request', 'Request validation failed.', {
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length < 8 || key.length > 255) {
    throw err.badRequest('idempotency_key_required', 'Send an Idempotency-Key header (8-255 characters) with this request.');
  }
  return key;
}

export function pagination(request: FastifyRequest): { limit: number; startingAfter: string | undefined } {
  const q = request.query as Record<string, string | undefined>;
  const limit = Math.min(Math.max(Number(q.limit ?? 25) || 25, 1), 100);
  return { limit, startingAfter: q.starting_after };
}

export function errorBody(error: AppError, requestId: string): Record<string, unknown> {
  return {
    error: {
      type: error.status >= 500 ? 'api_error' : 'invalid_request',
      code: error.code,
      message: error.message,
      details: error.details ?? undefined,
      request_id: requestId,
    },
  };
}

export function installErrorHandling(app: {
  setErrorHandler: (handler: (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => unknown) => void;
  setNotFoundHandler: (handler: (request: FastifyRequest, reply: FastifyReply) => unknown) => void;
}, log: Logger): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    if (error instanceof AppError) {
      return reply.code(error.status).send(errorBody(error, requestId));
    }
    if (error instanceof ZodError) {
      const mapped = zodToAppError(error);
      return reply.code(422).send(errorBody(mapped, requestId));
    }
    const statusCode = (error as FastifyError).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send(errorBody(new AppError(statusCode, 'invalid_request', error.message), requestId));
    }
    log.error({ err: error, requestId }, 'unhandled error');
    return reply.code(500).send(errorBody(new AppError(500, 'internal_error', 'Something went wrong.'), requestId));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(errorBody(new AppError(404, 'not_found', 'Route not found.'), request.id)));
}
