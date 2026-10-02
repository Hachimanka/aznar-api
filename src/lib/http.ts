import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg)
export const forbidden = (msg = 'You don’t have permission to do this') => new HttpError(403, msg)
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`)
export const conflict = (msg: string) => new HttpError(409, msg)

/** Parse and validate a request body; throws a 400 with a readable message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data)
  if (!result.success) throw badRequest(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return result.data
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate a route id param as a UUID; anything else is simply "not found". */
export function uuid(value: unknown, what = 'Resource') {
  if (typeof value !== 'string' || !UUID.test(value)) throw notFound(what)
  return value
}

/** Express 5 forwards rejected promises to the error handler; this just keeps handlers typed. */
export const handler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  async (req, res, next) => {
    const out = await fn(req, res, next)
    if (out !== undefined && !res.headersSent) res.json(out)
  }

/** 'yyyy-MM-dd' validator */
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use yyyy-MM-dd')
/** Peso amount as a string with up to 2 decimals */
export const pesoString = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 1000 or 1000.50')
