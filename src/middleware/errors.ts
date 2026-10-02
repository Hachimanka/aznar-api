import type { NextFunction, Request, Response } from 'express'
import { HttpError } from '../lib/http.js'

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: 'Not found' })
}

/** Never leak stack traces or driver errors to the browser. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message })
  // Postgres error codes (the driver may wrap them in `cause`)
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code
  if (code === '23505') return res.status(409).json({ message: 'A record with the same unique value already exists' })
  if (code === '23503') return res.status(400).json({ message: 'A referenced record does not exist' })
  if (code === '22P02' || code === '22007' || code === '22008') return res.status(400).json({ message: 'Invalid value in request' })
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ message: 'Malformed JSON body' })
  console.error(err)
  res.status(500).json({ message: 'Something went wrong. Please try again.' })
}
